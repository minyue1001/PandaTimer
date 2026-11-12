// 訂單雲端同步的純邏輯（無副作用，node --test 直接載入）。伺服器端對應 server/orders.mjs。
//
// 協定：POST /api/sync（header x-pt-sync＝同步碼）body {since, changes:{orders, baselines}} → {now, more, dbId, reset, changes, invalid}
//   - 每筆有 updatedAt；較新者勝（last-writer-wins），同時間＝伺服器為準。刪除＝墓碑（deleted:true）。
//   - since/now 是伺服器的變更序（不受手機時鐘影響）；dbId 變了或 reset:true＝伺服器資料庫換過 → 全部重傳。
// 本機「待上傳」不另存佇列：每筆訂單的 updatedAt 與 pushed[id]（伺服器已知的版本）不同就是待上傳；
//   刪掉的單看 prune 的墓碑（id → 刪除時間＝墓碑的 updatedAt）。離線時自然累積，下次同步一起送。
import type { Order } from './orders';
import { pruneTombstones, type Tombstones } from './prune.ts';
import type { Baseline } from './stats';

export type WireSource = 'manual' | 'auto' | 'import' | 'confirm' | 'admin';
export type WireOrder = {
  id: string;
  acceptedAt: number;
  estimateMin: number;
  deliveredAt: number | null;
  status: Order['status'];
  amount: number | null;
  stacked: boolean;
  source: WireSource;
  note: string;
  updatedAt: number;
  deleted: boolean;
  editedBy?: string;
};
export type WireTombstone = { id: string; updatedAt: number; deleted: true };
export type WireBaseline = {
  period: string;
  orders: number;
  onTimePct: number;
  overrunPct: number;
  income: number | null;
  updatedAt: number;
  deleted: boolean;
};
export type WireBaselineTombstone = { period: string; updatedAt: number; deleted: true };

/** 本機補登槽（AsyncStorage pandatimer.periodBaseline.v1）：補登，或刪除標記 */
export type BaselineSlot = Baseline | { periodId: string; deleted: true; updatedAt: number };

export type SyncState = {
  /** 伺服器資料庫身分；變了＝全部重傳 */
  dbId: string | null;
  /** 伺服器變更游標 */
  since: number;
  /** id → 伺服器已知的 updatedAt（上傳成功或從伺服器收到） */
  pushedOrders: Record<string, number>;
  pushedBaselines: Record<string, number>;
  lastAttemptAt?: number;
  lastOkAt?: number;
  /** 最後一次結果（顯示用）：成功摘要或錯誤 */
  lastResult?: string;
  lastOk?: boolean;
};
export const EMPTY_SYNC_STATE: Readonly<SyncState> = Object.freeze({ dbId: null, since: 0, pushedOrders: {}, pushedBaselines: {} });

/** 一次上傳的筆數（伺服器上限 300、64KB；100 筆約 25KB） */
export const PUSH_BATCH = 100;
export const DEBOUNCE_MS = 5_000;
export const PERIODIC_MS = 2 * 60_000;
export const MAX_NOTE = 100;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const SOURCES: readonly WireSource[] = ['manual', 'auto', 'import', 'confirm', 'admin'];
const STATUSES: readonly Order['status'][] = ['active', 'delivered', 'canceled'];
const SYNC_CODE_RE = /^[A-Z0-9]{8,32}$/;

/** 使用者輸入的同步碼 → 正規化（大寫、去空白/連字號）；不合法 → ''（與伺服器 normalizeSyncCode 一致） */
export function normalizeSyncCode(text: string | null | undefined): string {
  const s = String(text ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return SYNC_CODE_RE.test(s) ? s : '';
}

/** /api/config 的網址 → /api/sync（同一台伺服器） */
export function syncUrlFrom(configUrl: unknown): string | null {
  if (typeof configUrl !== 'string' || !/^https:\/\/[^/]+\/.*\/api\/config$/.test(configUrl)) return null;
  return configUrl.replace(/\/api\/config$/, '/api/sync');
}

// ── 訂單 ──

/** 沒有 updatedAt 的舊紀錄：送達/接單時間當版本（固定值，首次配對全部上傳一次） */
export function orderUpdatedAt(o: Order): number {
  return o.updatedAt ?? o.deliveredAt ?? o.acceptedAt;
}

/** 會同步的欄位（activityId/notifIds 是這台手機的本地狀態，不同步、改了也不算變更） */
export function syncFingerprint(o: Order): string {
  return JSON.stringify([
    o.acceptedAt, o.estimateMin, o.deliveredAt ?? null, o.status, o.amount ?? null, !!o.stacked, o.source ?? 'manual', o.note ?? '',
  ]);
}

/**
 * store.mutate 用：新單或同步欄位有變的單蓋上 updatedAt＝max(現在, 原本+1)（本機修改一定比收到的伺服器版本新）。
 * changed＝有任何同步欄位變動或有單被移除（觸發 5 秒後同步）。
 */
export function stampChanges(prev: readonly Order[], next: readonly Order[], now: number): { orders: Order[]; changed: boolean } {
  const before = new Map(prev.map((o) => [o.id, o]));
  let changed = false;
  const orders = next.map((o) => {
    const old = before.get(o.id);
    if (old === o) return o;
    if (old && syncFingerprint(old) === syncFingerprint(o)) {
      // 只改了本地欄位（activityId/notifIds）：保留版本
      return o.updatedAt === old.updatedAt ? o : { ...o, updatedAt: old.updatedAt };
    }
    changed = true;
    const base = old ? orderUpdatedAt(old) : 0;
    return { ...o, updatedAt: Math.max(now, base + 1) };
  });
  if (!changed && prev.length) {
    const ids = new Set(next.map((o) => o.id));
    changed = prev.some((o) => !ids.has(o.id));
  }
  return { orders, changed };
}

export function orderToWire(o: Order): WireOrder {
  return {
    id: o.id,
    acceptedAt: o.acceptedAt,
    estimateMin: o.estimateMin,
    deliveredAt: o.status === 'active' ? null : (o.deliveredAt ?? null),
    status: o.status,
    amount: o.amount ?? null,
    stacked: !!o.stacked,
    source: o.source ?? 'manual',
    note: (o.note ?? '').slice(0, MAX_NOTE),
    updatedAt: orderUpdatedAt(o),
    deleted: false,
  };
}

/** 伺服器回來的訂單（不可信）→ WireOrder；不合法 → null */
export function parseWireOrder(raw: unknown): WireOrder | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(r.id)) return null;
  if (!isNum(r.updatedAt) || typeof r.deleted !== 'boolean') return null;
  if (!isNum(r.acceptedAt) || !isNum(r.estimateMin) || r.estimateMin < 1 || r.estimateMin > 180) return null;
  if (!STATUSES.includes(r.status as Order['status'])) return null;
  if (r.deliveredAt != null && !isNum(r.deliveredAt)) return null;
  if (r.status === 'delivered' && r.deliveredAt == null) return null;
  if (r.amount != null && !isNum(r.amount)) return null;
  const source = SOURCES.includes(r.source as WireSource) ? (r.source as WireSource) : 'manual';
  return {
    id: r.id,
    acceptedAt: r.acceptedAt,
    estimateMin: r.estimateMin,
    deliveredAt: (r.deliveredAt as number | null | undefined) ?? null,
    status: r.status as Order['status'],
    amount: (r.amount as number | null | undefined) ?? null,
    stacked: r.stacked === true,
    source,
    note: typeof r.note === 'string' ? r.note.slice(0, MAX_NOTE) : '',
    updatedAt: r.updatedAt,
    deleted: r.deleted,
    ...(typeof r.editedBy === 'string' ? { editedBy: r.editedBy.slice(0, 16) } : {}),
  };
}

/** WireOrder → App 訂單；本地欄位（動態島 id、通知 id）沿用本機那筆 */
export function wireToOrder(w: WireOrder, local?: Order): Order {
  const done = w.status !== 'active' && w.deliveredAt != null;
  return {
    id: w.id,
    acceptedAt: w.acceptedAt,
    estimateMin: w.estimateMin,
    deadline: w.acceptedAt + w.estimateMin * 60_000,
    status: w.status,
    ...(done ? { deliveredAt: w.deliveredAt as number, actualMin: Math.round((((w.deliveredAt as number) - w.acceptedAt) / 60_000) * 10) / 10 } : {}),
    ...(local?.activityId ? { activityId: local.activityId } : {}),
    ...(local?.notifIds ? { notifIds: local.notifIds } : {}),
    ...(w.source !== 'manual' ? { source: w.source } : {}),
    ...(w.stacked ? { stacked: true } : {}),
    ...(w.amount != null ? { amount: w.amount } : {}),
    ...(w.note ? { note: w.note } : {}),
    updatedAt: w.updatedAt,
  };
}

/** 待上傳的訂單：版本 ≠ 伺服器已知版本的單＋還沒送出的刪除墓碑 */
export function pendingOrders(orders: readonly Order[], tombs: Tombstones, state: SyncState): Array<WireOrder | WireTombstone> {
  const out: Array<WireOrder | WireTombstone> = [];
  const have = new Set<string>();
  for (const o of orders) {
    have.add(o.id);
    if (state.pushedOrders[o.id] !== orderUpdatedAt(o)) out.push(orderToWire(o));
  }
  for (const [id, at] of Object.entries(tombs)) {
    if (!have.has(id) && state.pushedOrders[id] !== at) out.push({ id, updatedAt: at, deleted: true });
  }
  return out;
}

/** 已配對時，還沒送到伺服器的刪除墓碑不得過期（保留到同步完成） */
export function unsyncedTombstoneIds(tombs: Tombstones, state: SyncState, paired: boolean): Set<string> {
  const out = new Set<string>();
  if (!paired) return out;
  for (const [id, at] of Object.entries(tombs)) if (state.pushedOrders[id] !== at) out.add(id);
  return out;
}

/** 上傳成功：送出的那幾筆記成伺服器已知（被伺服器拒絕的，回應裡的伺服器版接著會蓋過去） */
export function markPushed(state: SyncState, orders: ReadonlyArray<{ id: string; updatedAt: number }>, baselines: ReadonlyArray<{ period: string; updatedAt: number }>): SyncState {
  const po = { ...state.pushedOrders };
  for (const o of orders) po[o.id] = o.updatedAt;
  const pb = { ...state.pushedBaselines };
  for (const b of baselines) pb[b.period] = b.updatedAt;
  return { ...state, pushedOrders: po, pushedBaselines: pb };
}

export type OrderMerge = {
  orders: Order[];
  tombs: Tombstones;
  pushedOrders: Record<string, number>;
  /** 原本進行中、被伺服器改成非進行中或刪掉的單（要收動態島、取消提醒） */
  ended: Order[];
  /** 實際改到本機的筆數 */
  applied: number;
};

/**
 * 合併伺服器的變更（LWW）：
 *   本機那筆還沒上傳且比較新 → 留本機（下次上傳）；否則伺服器版覆蓋（刪除＝移除＋墓碑）。
 *   本機已刪（墓碑）：墓碑沒上傳且比較新 → 維持刪除；否則伺服器的未刪版本＝還原（拿掉墓碑）。
 */
export function mergeServerOrders(
  orders: readonly Order[],
  tombs: Tombstones,
  pushed: Record<string, number>,
  incoming: readonly WireOrder[],
): OrderMerge {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const t: Tombstones = { ...tombs };
  const p = { ...pushed };
  const ended: Order[] = [];
  let applied = 0;
  let added = false;
  for (const w of incoming) {
    const local = byId.get(w.id);
    if (local) {
      const lu = orderUpdatedAt(local);
      if (p[w.id] !== lu && lu > w.updatedAt) continue;
      p[w.id] = w.updatedAt;
      if (w.deleted) {
        byId.delete(w.id);
        t[w.id] = w.updatedAt;
        if (local.status === 'active') ended.push(local);
        applied += 1;
        continue;
      }
      const next = wireToOrder(w, local);
      if (syncFingerprint(next) === syncFingerprint(local) && lu === w.updatedAt) continue;
      byId.set(w.id, next);
      if (local.status === 'active' && next.status !== 'active') ended.push(local);
      applied += 1;
      continue;
    }
    const tomb = t[w.id];
    if (tomb != null) {
      if (w.deleted) {
        p[w.id] = tomb; // 伺服器也刪了 → 墓碑不用再送
        continue;
      }
      if (p[w.id] !== tomb && tomb > w.updatedAt) continue; // 本機刪除較新，等著上傳
      delete t[w.id];
    }
    if (w.deleted) continue; // 本機沒有、伺服器也刪了
    byId.set(w.id, wireToOrder(w));
    p[w.id] = w.updatedAt;
    added = true;
    applied += 1;
  }
  let list = [...byId.values()];
  if (added) list = list.sort((a, b) => b.acceptedAt - a.acceptedAt);
  return { orders: list, tombs: t, pushedOrders: p, ended, applied };
}

/** 清掉 pushed 裡已不存在（不在紀錄也不在墓碑）的 id，避免無限長大 */
export function compactPushed(pushed: Record<string, number>, orders: readonly Order[], tombs: Tombstones): Record<string, number> {
  const keep = new Set([...orders.map((o) => o.id), ...Object.keys(tombs)]);
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(pushed)) if (keep.has(id)) out[id] = at;
  return out;
}

/** 刪除墓碑過期清理（已配對時沒上傳的不清） */
export function expireTombstones(tombs: Tombstones, state: SyncState, paired: boolean, now: number): Tombstones {
  return pruneTombstones(tombs, now, unsyncedTombstoneIds(tombs, state, paired));
}

// ── 補登 ──

const TAIPEI_MS = 8 * 3_600_000;
/** 舊補登沒有 updatedAt → 以期別起點當版本 */
export function periodStartMs(periodId: string): number {
  return Date.parse(`${periodId}T00:00:00Z`) - TAIPEI_MS;
}
const round1 = (x: number) => Math.round(x * 10_000) / 100; // 0.4567 → 45.67

/** 本機補登槽（不可信）→ BaselineSlot；壞掉 → null */
export function parseBaselineSlot(raw: unknown): BaselineSlot | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.periodId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.periodId)) return null;
  if (r.deleted === true) return isNum(r.updatedAt) ? { periodId: r.periodId, deleted: true, updatedAt: r.updatedAt } : null;
  const rate = (v: unknown) => isNum(v) && v >= 0 && v <= 1;
  if (!(Number.isInteger(r.count) && (r.count as number) >= 0) || !rate(r.onTimeRate) || !rate(r.overrunRate)) return null;
  return {
    periodId: r.periodId,
    count: r.count as number,
    onTimeRate: r.onTimeRate as number,
    overrunRate: r.overrunRate as number,
    ...(isNum(r.income) && r.income > 0 ? { income: r.income } : {}),
    ...(isNum(r.updatedAt) ? { updatedAt: r.updatedAt } : {}),
  };
}

export const slotUpdatedAt = (s: BaselineSlot): number => s.updatedAt ?? periodStartMs(s.periodId);
const isDeletedSlot = (s: BaselineSlot): s is { periodId: string; deleted: true; updatedAt: number } => 'deleted' in s && s.deleted === true;

export function slotToWire(s: BaselineSlot): WireBaseline | WireBaselineTombstone {
  if (isDeletedSlot(s)) return { period: s.periodId, updatedAt: s.updatedAt, deleted: true };
  return {
    period: s.periodId,
    orders: s.count,
    onTimePct: round1(s.onTimeRate),
    overrunPct: round1(s.overrunRate),
    income: s.income ?? null,
    updatedAt: slotUpdatedAt(s),
    deleted: false,
  };
}

export function pendingBaselines(slot: BaselineSlot | null, state: SyncState): Array<WireBaseline | WireBaselineTombstone> {
  if (!slot) return [];
  return state.pushedBaselines[slot.periodId] === slotUpdatedAt(slot) ? [] : [slotToWire(slot)];
}

export function parseWireBaseline(raw: unknown): WireBaseline | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const pct = (v: unknown) => isNum(v) && v >= 0 && v <= 100;
  if (typeof r.period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.period)) return null;
  if (!isNum(r.updatedAt) || typeof r.deleted !== 'boolean') return null;
  if (!(Number.isInteger(r.orders) && (r.orders as number) >= 0 && (r.orders as number) <= 2000) || !pct(r.onTimePct) || !pct(r.overrunPct)) return null;
  if (r.income != null && !isNum(r.income)) return null;
  return {
    period: r.period,
    orders: r.orders as number,
    onTimePct: r.onTimePct as number,
    overrunPct: r.overrunPct as number,
    income: (r.income as number | null | undefined) ?? null,
    updatedAt: r.updatedAt,
    deleted: r.deleted,
  };
}

/**
 * 伺服器的補登 → 本機補登槽（App 只存一期：本期）。只採用「本期」或「槽目前那一期」的紀錄；LWW 同訂單。
 * 回傳 slot：undefined＝槽不變。
 */
export function mergeServerBaselines(
  slot: BaselineSlot | null,
  pushed: Record<string, number>,
  incoming: readonly WireBaseline[],
  currentPeriodId: string,
): { slot: BaselineSlot | undefined; pushedBaselines: Record<string, number> } {
  const p = { ...pushed };
  let cur = slot;
  let changed = false;
  for (const w of incoming) {
    if (w.period !== currentPeriodId && w.period !== cur?.periodId) continue;
    if (cur && cur.periodId === w.period) {
      const lu = slotUpdatedAt(cur);
      if (p[w.period] !== lu && lu > w.updatedAt) continue;
    } else if (cur && cur.periodId === currentPeriodId) continue; // 槽是本期 → 別期的不蓋
    p[w.period] = w.updatedAt;
    cur = w.deleted
      ? { periodId: w.period, deleted: true, updatedAt: w.updatedAt }
      : {
          periodId: w.period,
          count: w.orders,
          onTimeRate: w.onTimePct / 100,
          overrunRate: w.overrunPct / 100,
          ...(w.income != null && w.income > 0 ? { income: w.income } : {}),
          updatedAt: w.updatedAt,
        };
    changed = true;
  }
  return { slot: changed ? (cur as BaselineSlot) : undefined, pushedBaselines: p };
}

/** 本機改補登：蓋上新版本；null＝刪除標記 */
export function stampBaseline(next: Baseline | null, prev: BaselineSlot | null, periodId: string, now: number): BaselineSlot {
  const base = prev && prev.periodId === (next?.periodId ?? periodId) ? slotUpdatedAt(prev) : 0;
  const updatedAt = Math.max(now, base + 1);
  return next ? { ...next, updatedAt } : { periodId, deleted: true, updatedAt };
}

// ── 伺服器回應 ──

export type SyncResponse = {
  now: number;
  more: boolean;
  dbId: string;
  reset: boolean;
  orders: WireOrder[];
  baselines: WireBaseline[];
  invalid: number;
};

export function parseSyncResponse(raw: unknown): SyncResponse | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!isNum(r.now) || typeof r.dbId !== 'string' || !r.changes || typeof r.changes !== 'object') return null;
  const ch = r.changes as Record<string, unknown>;
  const list = <T>(x: unknown, f: (v: unknown) => T | null): T[] => (Array.isArray(x) ? x.map(f).filter((v): v is T => v != null) : []);
  return {
    now: r.now,
    more: r.more === true,
    dbId: r.dbId,
    reset: r.reset === true,
    orders: list(ch.orders, parseWireOrder),
    baselines: list(ch.baselines, parseWireBaseline),
    invalid: Array.isArray(r.invalid) ? r.invalid.length : 0,
  };
}

/** 回應的資料庫身分和本機記的不同（或 reset）→ 從頭來：清掉已知版本，全部重傳 */
export function needsFullResync(state: SyncState, resp: Pick<SyncResponse, 'dbId' | 'reset'>): boolean {
  return resp.reset || (state.dbId != null && state.dbId !== resp.dbId);
}

export function parseSyncState(raw: unknown): SyncState {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ...EMPTY_SYNC_STATE, pushedOrders: {}, pushedBaselines: {} };
  const r = o as Record<string, unknown>;
  const nums = (x: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (x && typeof x === 'object' && !Array.isArray(x)) for (const [k, v] of Object.entries(x)) if (isNum(v)) out[k] = v;
    return out;
  };
  return {
    dbId: typeof r.dbId === 'string' ? r.dbId : null,
    since: isNum(r.since) && r.since >= 0 ? r.since : 0,
    pushedOrders: nums(r.pushedOrders),
    pushedBaselines: nums(r.pushedBaselines),
    ...(isNum(r.lastAttemptAt) ? { lastAttemptAt: r.lastAttemptAt } : {}),
    ...(isNum(r.lastOkAt) ? { lastOkAt: r.lastOkAt } : {}),
    ...(typeof r.lastResult === 'string' ? { lastResult: r.lastResult.slice(0, 120) } : {}),
    ...(typeof r.lastOk === 'boolean' ? { lastOk: r.lastOk } : {}),
  };
}

/** HTTP 狀態 → 顯示給使用者的錯誤 */
export function syncErrorText(status: number): string {
  if (status === 401) return '同步碼錯誤（到管理頁確認或重設）';
  if (status === 429) return '太頻繁或同步碼錯太多次，稍後再試';
  if (status === 503) return '伺服器資料庫暫時不可用';
  if (status === 413) return '資料太大';
  return `伺服器錯誤 HTTP ${status}`;
}

// ── 排程：debounce＋同時只跑一個（跑的時候又被叫 → 跑完再跑一次） ──

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (h: unknown) => void;
};

export class SyncScheduler {
  private readonly run: () => Promise<unknown>;
  private readonly debounceMs: number;
  private readonly timers: Timers;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(run: () => Promise<unknown>, debounceMs: number = DEBOUNCE_MS, timers?: Timers) {
    this.run = run;
    this.debounceMs = debounceMs;
    this.timers = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  /** 訂單變動：debounceMs 內再變就重新計時 */
  poke(): void {
    if (this.timer != null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.now();
    }, this.debounceMs);
  }

  get busy(): boolean {
    return this.running != null;
  }

  /** 立刻同步（取消等待中的 debounce）；正在跑 → 跑完再補一次，回傳的 promise 等到補跑結束 */
  now(): Promise<void> {
    if (this.timer != null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.run().catch(() => undefined);
        } while (this.again);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  dispose(): void {
    if (this.timer != null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
