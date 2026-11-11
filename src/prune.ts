// 刪除紀錄的純邏輯（無副作用）：挑出要刪的 id、套用刪除、墓碑（防止原生事件佇列把已刪的單復活）。
// 時區一律台北（UTC+8，無夏令時間），與 stats.ts 的期別一致。
import type { NativeEvent } from './nativeEvents';
import type { Order } from './orders';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TAIPEI_OFFSET = 8 * HOUR;

/** 墓碑保留 7 天（原生佇列裡的舊事件不會留得比這更久） */
export const TOMBSTONE_TTL_MS = 7 * DAY;

/** id → 刪除時間 (ms) */
export type Tombstones = Record<string, number>;

export type PruneCriteria =
  | { kind: 'ids'; ids: string[] }
  | { kind: 'today'; now: number }
  | { kind: 'before'; ts: number }
  | { kind: 'all' };

export type PrunePlan = {
  /** 要刪的所有 id（含進行中） */
  ids: string[];
  /** 要刪的訂單中仍進行中的（需要收動態島／取消提醒） */
  active: Order[];
  count: number;
  activeCount: number;
};

/** 台北今天 00:00 的 ms */
export function taipeiStartOfDay(now: number): number {
  return Math.floor((now + TAIPEI_OFFSET) / DAY) * DAY - TAIPEI_OFFSET;
}

function inCriteria(o: Order, c: PruneCriteria): boolean {
  switch (c.kind) {
    case 'ids':
      return c.ids.includes(o.id);
    case 'today':
      return o.acceptedAt >= taipeiStartOfDay(c.now);
    case 'before':
      return o.acceptedAt < c.ts;
    case 'all':
      return true;
  }
}

/** 依條件挑出要刪的單（依接單時間；不論送達／取消／進行中）。補登不在 orders 裡，不受影響。 */
export function planPrune(orders: readonly Order[], c: PruneCriteria): PrunePlan {
  const hit = orders.filter((o) => inCriteria(o, c));
  const active = hit.filter((o) => o.status === 'active');
  return { ids: hit.map((o) => o.id), active, count: hit.length, activeCount: active.length };
}

export function applyPrune(orders: readonly Order[], ids: Iterable<string>): Order[] {
  const drop = new Set(ids);
  return orders.filter((o) => !drop.has(o.id));
}

/** 加墓碑並順便清掉過期的 */
export function addTombstones(t: Tombstones, ids: Iterable<string>, now: number): Tombstones {
  const next = pruneTombstones(t, now);
  for (const id of ids) next[id] = now;
  return next;
}

export function pruneTombstones(t: Tombstones, now: number): Tombstones {
  const out: Tombstones = {};
  for (const [id, at] of Object.entries(t)) {
    if (typeof at === 'number' && Number.isFinite(at) && now - at < TOMBSTONE_TTL_MS) out[id] = at;
  }
  return out;
}

/** 解析存回來的墓碑（不可信） */
export function parseTombstones(raw: unknown): Tombstones {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Tombstones = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

/** 濾掉已刪單的原生事件：start 以 id 擋；done 若指定 orderId 為已刪單也擋（其餘 done 找不到目標本來就忽略） */
export function dropTombstonedEvents(events: NativeEvent[], t: Tombstones): NativeEvent[] {
  return events.filter((e) => {
    if (e.type === 'start') return !(e.id in t);
    if (e.orderId && e.orderId in t) return false;
    return true;
  });
}

/** 輸入 "YYYY-MM-DD HH:mm"（台北時間）→ ms；格式或日期不合法 → null */
export function parseTaipeiDateTime(text: string): number | null {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(utc);
  // 擋掉 2/31 這種被自動進位的日期
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return utc - TAIPEI_OFFSET;
}

export function formatTaipeiDateTime(ms: number): string {
  const d = new Date(ms + TAIPEI_OFFSET);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 確認視窗內文：會刪幾筆、是否含進行中 */
export function describePlan(p: PrunePlan): string {
  const act = p.activeCount > 0 ? `\n其中含 ${p.activeCount} 筆進行中訂單（會一併關閉動態島、取消提醒）。` : '';
  return `將刪除 ${p.count} 筆紀錄。${act}\n補登的期初成績不受影響。刪除後無法復原。`;
}
