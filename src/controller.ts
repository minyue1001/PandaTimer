import { AppState, Linking } from 'react-native';
import * as LiveActivity from '../modules/live-activity';
import { cancelReminders, scheduleReminders } from './notify';
import { activeOrders, clampEstimate, DEFAULT_ESTIMATE, parseDeepLink, type Order } from './orders';
import { getOrders, mutate } from './store';

export type Feedback = (msg: string) => void;

/** ActivityKit 只允許前景啟動：冷啟動時等 AppState 變 active（最多 5 秒） */
function waitForActive(timeoutMs = 5000): Promise<void> {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') done();
    });
    function done() {
      clearTimeout(timer);
      sub.remove();
      resolve();
    }
  });
}

/** 開新單（疊單也照開）。先記錄，再啟動動態島與通知。 */
export async function startOrder(estimateInput: number, feedback?: Feedback): Promise<Order> {
  const estimateMin = clampEstimate(estimateInput);
  const now = Date.now();
  const order: Order = {
    id: `${now}-${Math.random().toString(36).slice(2, 7)}`,
    acceptedAt: now,
    estimateMin,
    deadline: now + estimateMin * 60_000,
    status: 'active',
  };
  await mutate((list) => ({ orders: [order, ...list] }));

  const activityPromise = (async () => {
    if (!LiveActivity.isSupported()) return undefined;
    await waitForActive();
    try {
      return await LiveActivity.start(estimateMin, order.deadline);
    } catch (e) {
      feedback?.(`動態島啟動失敗：${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  })();
  const [activityId, notifIds] = await Promise.all([
    activityPromise,
    scheduleReminders(order.deadline, estimateMin),
  ]);
  const stillActive = await mutate<boolean>((list) => {
    const cur = list.find((o) => o.id === order.id);
    return {
      orders: list.map((o) => (o.id === order.id ? { ...o, activityId, notifIds } : o)),
      result: cur?.status === 'active',
    };
  });
  // 動態島/通知還在啟動時就被按了送達或取消：當時 cleanup 拿不到 id，這裡補收掉
  if (!stillActive) await cleanup({ ...order, activityId, notifIds });
  return { ...order, activityId, notifIds };
}

function finish(o: Order, status: 'delivered' | 'canceled', at: number): Order {
  if (status === 'canceled') return { ...o, status };
  return {
    ...o,
    status,
    deliveredAt: at,
    actualMin: Math.round(((at - o.acceptedAt) / 60_000) * 10) / 10,
  };
}

async function cleanup(o: Order | undefined) {
  if (!o) return;
  await Promise.all([
    o.activityId ? LiveActivity.end(o.activityId).catch(() => undefined) : undefined,
    cancelReminders(o.notifIds),
  ]);
}

/** 送達：指定 id；不指定則取最早接單的進行中訂單 */
export async function completeOrder(id?: string): Promise<Order | undefined> {
  const now = Date.now();
  const done = await mutate<Order>((list) => {
    const target = id ? list.find((o) => o.id === id && o.status === 'active') : activeOrders(list)[0];
    if (!target) return { orders: list };
    const updated = finish(target, 'delivered', now);
    return { orders: list.map((o) => (o.id === target.id ? updated : o)), result: updated };
  });
  await cleanup(done);
  return done;
}

export async function cancelOrder(id: string): Promise<void> {
  const canceled = await mutate<Order>((list) => {
    const target = list.find((o) => o.id === id && o.status === 'active');
    if (!target) return { orders: list };
    const updated = finish(target, 'canceled', Date.now());
    return { orders: list.map((o) => (o.id === id ? updated : o)), result: updated };
  });
  await cleanup(canceled);
}

/** App 啟動時對帳：系統裡還活著、但對應訂單已結束（或不存在）的動態島一律結束 */
export async function reconcileActivities(): Promise<void> {
  const alive = LiveActivity.activeIds();
  if (!alive.length) return;
  const orders = await getOrders();
  const keep = new Set(activeOrders(orders).map((o) => o.activityId).filter(Boolean));
  await Promise.all(alive.filter((id) => !keep.has(id)).map((id) => LiveActivity.end(id).catch(() => undefined)));
}

let lastHandled: { url: string; at: number } | null = null;

export async function handleUrl(
  url: string | null | undefined,
  getDefaultEstimate: () => number,
  feedback?: Feedback,
): Promise<void> {
  const link = parseDeepLink(url);
  if (!link || !url) return;
  // 同一個 URL 在 3 秒內只處理一次（冷啟動 initialURL 與 url 事件可能重複）
  const now = Date.now();
  if (lastHandled && lastHandled.url === url && now - lastHandled.at < 3000) return;
  lastHandled = { url, at: now };

  if (link.action === 'start') {
    const min = link.min ?? getDefaultEstimate() ?? DEFAULT_ESTIMATE;
    feedback?.(`已開始：預估 ${clampEstimate(min)} 分`);
    await startOrder(min, feedback);
  } else {
    const done = await completeOrder();
    feedback?.(
      done
        ? `已送達：實際 ${done.actualMin} 分／預估 ${done.estimateMin} 分`
        : '沒有進行中的訂單',
    );
  }
}

/** 掛上 deep link：冷啟動的 initial URL ＋ 執行中收到的 url 事件 */
export function listenDeepLinks(getDefaultEstimate: () => number, feedback?: Feedback): () => void {
  const sub = Linking.addEventListener('url', ({ url }) => {
    void handleUrl(url, getDefaultEstimate, feedback);
  });
  void Linking.getInitialURL().then((url) => handleUrl(url, getDefaultEstimate, feedback));
  return () => sub.remove();
}
