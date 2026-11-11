// 原生（App Intents，背景、不跑 JS）寫進 UserDefaults 的事件 → 合併進 JS 訂單。純函式，只有 type import。
// 事件格式由 native/intents/DeliverActivityIntent.swift 的 PandaSharedStore 寫入：
//   start: { type:'start', id, acceptedAt, estimateMin, deadline, activityId?, notifIds? }   (時間皆 ms)
//   done:  { type:'done', at, orderId?, activityId? }
//     有 orderId → 只結那一單；否則有 activityId → 只結對應動態島那一單；都沒有 → 最早一筆進行中。
//     指定了但找不到（例如已在 App 內按過送達/取消）→ 忽略，不誤結別張單。
import type { Order } from './orders';

export type NativeStartEvent = {
  type: 'start';
  id: string;
  acceptedAt: number;
  estimateMin: number;
  deadline: number;
  activityId?: string;
  notifIds?: string[];
};
export type NativeDoneEvent = { type: 'done'; at: number; orderId?: string; activityId?: string };
export type NativeEvent = NativeStartEvent | NativeDoneEvent;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** 原生回來的 JSON 不可信：過濾掉欄位不完整的事件 */
export function parseNativeEvents(raw: unknown): NativeEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: NativeEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (r.type === 'start' && isStr(r.id) && isNum(r.acceptedAt) && isNum(r.estimateMin) && isNum(r.deadline)) {
      out.push({
        type: 'start',
        id: r.id,
        acceptedAt: r.acceptedAt,
        estimateMin: r.estimateMin,
        deadline: r.deadline,
        activityId: isStr(r.activityId) ? r.activityId : undefined,
        notifIds: Array.isArray(r.notifIds) ? r.notifIds.filter(isStr) : [],
      });
    } else if (r.type === 'done' && isNum(r.at)) {
      out.push({
        type: 'done',
        at: r.at,
        orderId: isStr(r.orderId) ? r.orderId : undefined,
        activityId: isStr(r.activityId) ? r.activityId : undefined,
      });
    }
  }
  return out;
}

function earliestActive(list: Order[]): Order | undefined {
  let best: Order | undefined;
  for (const o of list) if (o.status === 'active' && (!best || o.acceptedAt < best.acceptedAt)) best = o;
  return best;
}

/** 依序套用事件；回傳新陣列（新單放最前面，與 startOrder 一致） */
export function applyNativeEvents(orders: Order[], events: NativeEvent[]): Order[] {
  let list = orders.slice();
  for (const ev of events) {
    if (ev.type === 'start') {
      if (list.some((o) => o.id === ev.id)) continue; // 重複事件
      list = [
        {
          id: ev.id,
          acceptedAt: ev.acceptedAt,
          estimateMin: Math.min(180, Math.max(1, Math.round(ev.estimateMin))),
          deadline: ev.deadline,
          status: 'active',
          activityId: ev.activityId,
          notifIds: ev.notifIds ?? [],
        },
        ...list,
      ];
    } else {
      const target = ev.orderId
        ? list.find((o) => o.id === ev.orderId && o.status === 'active')
        : ev.activityId
          ? list.find((o) => o.activityId === ev.activityId && o.status === 'active')
          : earliestActive(list);
      if (!target) continue;
      const actualMin = Math.round(((ev.at - target.acceptedAt) / 60_000) * 10) / 10;
      list = list.map((o) =>
        o.id === target.id ? { ...o, status: 'delivered', deliveredAt: ev.at, actualMin } : o,
      );
    }
  }
  return list;
}

/** 寫給原生的「進行中訂單」鏡像（DeliveredIntent / 動態島送達按鈕以此為準） */
export function activeMirror(orders: Order[]) {
  return orders
    .filter((o) => o.status === 'active')
    .sort((a, b) => a.acceptedAt - b.acceptedAt)
    .map((o) => ({
      id: o.id,
      acceptedAt: o.acceptedAt,
      estimateMin: o.estimateMin,
      deadline: o.deadline,
      ...(o.activityId ? { activityId: o.activityId } : {}),
      notifIds: o.notifIds ?? [],
    }));
}
