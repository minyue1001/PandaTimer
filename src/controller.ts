import { AppState, Linking } from 'react-native';
import * as LiveActivity from '../modules/live-activity';
import { activeMirror, applyNativeEvents, orphanActivityIds, parseNativeEvents } from './nativeEvents';
import { cancelReminders, scheduleReminders } from './notify';
import { activeOrders, clampEstimate, DEFAULT_ESTIMATE, parseDeepLink, type Order } from './orders';
import { addTombstones, applyPrune, dropTombstonedEvents, planPrune, type PruneCriteria, type PrunePlan } from './prune';
import { planImport, type ImportPlan, type ImportRow } from './importLink';
import { getOrders, loadTombstones, mutate, saveTombstones, subscribe } from './store';

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

/** v0.8 匯入預覽（確認視窗用；重複判定以目前紀錄為準） */
export async function previewImport(rows: readonly ImportRow[]): Promise<ImportPlan> {
  return planImport(await getOrders(), rows);
}

/**
 * v0.8 匯入補記單：在 mutate 內以最新紀錄重算重複（確認視窗開著時可能剛好入帳新單），只寫已送達單。
 * 不開動態島、不排通知（鏡像只含進行中單，所以原生也不受影響）。
 */
export async function importOrders(rows: readonly ImportRow[]): Promise<ImportPlan> {
  const plan = await mutate<ImportPlan>((list) => {
    const p = planImport(list, rows);
    return { orders: [...p.add, ...list], result: p };
  });
  return plan ?? planImport([], []);
}

/** 預覽：這個條件會刪哪些單（確認視窗用） */
export async function previewPrune(c: PruneCriteria): Promise<PrunePlan> {
  return planPrune(await getOrders(), c);
}

/**
 * 刪除紀錄（單筆／批次）。順序：
 *  1. 先寫墓碑，再 drain（把原生佇列清空；殘留的已刪單事件被墓碑擋掉）
 *  2. mutate 刪除（subscribe 會同步把「不含這些單」的鏡像寫回原生）
 *  3. 進行中的單收尾：結束動態島（偵測卡走 afterFinish 切下一單／回待命，同取消流程）、取消提醒
 */
export async function pruneOrders(c: PruneCriteria): Promise<PrunePlan> {
  const plan = planPrune(await getOrders(), c);
  if (!plan.count) return plan;
  const now = Date.now();
  await saveTombstones(addTombstones(await loadTombstones(), plan.ids, now));
  await drainFromNative().catch(() => undefined);
  // drain 之後才算最終要刪的 active（drain 可能剛併進新單；新單不在 plan.ids 內，不受影響）
  const removed = await mutate<Order[]>((list) => ({
    orders: applyPrune(list, plan.ids),
    result: list.filter((o) => plan.ids.includes(o.id)),
  }));
  const gone = (removed ?? []).filter((o) => o.status === 'active');
  // 同一張卡只收一次（afterFinish 會依鏡像切到剩下的單）
  const seen = new Set<string>();
  await Promise.all(
    gone.map((o) => {
      const key = o.activityId;
      const first = !key || !seen.has(key);
      if (key) seen.add(key);
      return first ? cleanup(o) : cancelReminders(o.notifIds);
    }),
  );
  return { ...plan, active: gone, activeCount: gone.length };
}

/**
 * App 啟動時對帳：系統裡還活著、但對應訂單已結束（或不存在）的動態島一律結束。
 * v0.3 例外：螢幕廣播偵測卡一律保留（規則見 nativeEvents.ts 的 orphanActivityIds）。
 */
export async function reconcileActivities(): Promise<void> {
  // 舊版原生沒有 activitySummaries → 退回只有 id 的舊行為（舊版也不會有偵測卡）
  const alive =
    LiveActivity.activitySummaries() ??
    LiveActivity.activeIds().map((id) => ({ id, mode: 'countdown', detector: false }));
  if (!alive.length) return;
  const orders = await getOrders();
  const orphans = orphanActivityIds(alive, activeOrders(orders).map((o) => o.activityId));
  await Promise.all(orphans.map((id) => LiveActivity.end(id).catch(() => undefined)));
}

/** 取走原生（App Intents）事件並合併進 AsyncStorage 訂單；回傳事件數 */
export async function drainFromNative(): Promise<number> {
  // 已刪的單（墓碑）不得被原生佇列裡殘留的 start/done 事件復活
  const events = dropTombstonedEvents(parseNativeEvents(LiveActivity.drainNativeEvents()), await loadTombstones());
  if (!events.length) return 0;
  await mutate((list) => ({ orders: applyNativeEvents(list, events) }));
  return events.length;
}

let lastMirror: string | null = null;
function pushMirror(orders: Order[]) {
  const json = JSON.stringify(activeMirror(orders));
  if (json === lastMirror) return;
  lastMirror = json;
  LiveActivity.syncActiveOrders(json);
}

/**
 * 原生 ↔ JS 同步。順序是鐵律：
 *  1. drain（把背景 intent 開的單併進來）→ 2. reconcileActivities（否則原生剛開的動態島會被當孤兒關掉）
 *  → 3. 之後每次訂單變動都把進行中鏡像寫回原生。每次回到前景再 drain 一次。
 */
export function initNativeBridge(feedback?: Feedback): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  const report = (n: number) => {
    if (n > 0) feedback?.(`已同步捷徑／動態島的 ${n} 筆紀錄`);
  };
  void (async () => {
    try {
      report(await drainFromNative());
    } catch {
      // 讀不到就照舊；鏡像會在下面重寫
    }
    await reconcileActivities().catch(() => undefined);
    if (disposed) return;
    unsubscribe = subscribe(pushMirror);
  })();
  const appSub = AppState.addEventListener('change', (s) => {
    if (s === 'active') void drainFromNative().then(report).catch(() => undefined);
  });
  // v0.4：自動偵測新單／動態島送達（App Intents）→ 原生已寫好事件佇列，這裡立刻 drain 入帳。
  // App 在背景時靠音訊保活 JS 仍在跑；就算沒跑到，回前景的 drain 也會補上（事件留在佇列裡）。
  const detSub = LiveActivity.addDetectorListener((ev) => {
    // v0.5：回前景（含點「偵測到新單」通知）原生已把最新自動單的倒數補推到動態島
    if (ev.type === 'restored') {
      if (ev.how) feedback?.(`回前景補推倒數：${ev.how}`);
      return;
    }
    if (ev.type !== 'order' && ev.type !== 'drain') return;
    void drainFromNative()
      .then((n) => {
        if (ev.type === 'order') {
          feedback?.(`自動偵測新單：${ev.minutes ?? '?'} 分（已記錄）${ev.check ? `・${ev.check}` : ''}`);
        }
        else report(n);
      })
      .catch(() => undefined);
  });
  return () => {
    disposed = true;
    unsubscribe?.();
    appSub.remove();
    detSub();
  };
}

let lastHandled: { url: string; at: number } | null = null;

/** v0.8 pandatimer://import?d=…（UI 端跳確認視窗，見 App.tsx） */
export type ImportLinkHandler = (url: string) => void;
const isImportUrl = (url: string) => /^pandatimer:\/*import\b/i.test(url.trim());

export async function handleUrl(
  url: string | null | undefined,
  getDefaultEstimate: () => number,
  feedback?: Feedback,
  onImport?: ImportLinkHandler,
): Promise<void> {
  if (!url) return;
  const importing = isImportUrl(url);
  const link = importing ? null : parseDeepLink(url);
  if (!link && !importing) return;
  // 同一個 URL 在 3 秒內只處理一次（冷啟動 initialURL 與 url 事件可能重複）
  const now = Date.now();
  if (lastHandled && lastHandled.url === url && now - lastHandled.at < 3000) return;
  lastHandled = { url, at: now };
  if (importing) {
    if (onImport) onImport(url);
    else feedback?.('這個版本還不能匯入訂單');
    return;
  }
  if (!link) return;

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
export function listenDeepLinks(
  getDefaultEstimate: () => number,
  feedback?: Feedback,
  onImport?: ImportLinkHandler,
): () => void {
  const sub = Linking.addEventListener('url', ({ url }) => {
    void handleUrl(url, getDefaultEstimate, feedback, onImport);
  });
  void Linking.getInitialURL().then((url) => handleUrl(url, getDefaultEstimate, feedback, onImport));
  return () => sub.remove();
}
