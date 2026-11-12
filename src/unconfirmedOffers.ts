// 未確認邀請（純函式）：收到原生 offerPending 後，若在 decideWindowSec+10 秒內沒有同分鐘的 order 事件入帳，
// 就列為「未確認邀請」讓人工補救（偵測中斷、或模糊判定被當成拒單時，使用者其實有接）。
// 狀態存 AsyncStorage（key OFFERS_STORAGE_KEY），App 被殺掉重開仍在；超過 30 分鐘自動消失；最多保留最近 3 張。

export const OFFERS_STORAGE_KEY = 'pandatimer.unconfirmedOffers.v1';
export const DEFAULT_DECIDE_WINDOW_SEC = 25;
/** 判定窗之外再多等幾秒（order 事件入帳有延遲） */
export const GRACE_SEC = 10;
export const FALLBACK_WAIT_SEC = 35;
export const MAX_UNCONFIRMED = 3;
export const EXPIRE_MS = 30 * 60_000;
/** 補單時，接單時間＝邀請時間＋這麼多秒 */
export const CONFIRM_ACCEPT_DELAY_SEC = 5;
/** 同分鐘的 offerPending 在這麼多毫秒內重複（訊號重送）視為同一張 */
const DEDUPE_MS = 90_000;

export type OfferEntry = { id: string; min: number; at: number };
export type OfferState = { pending: OfferEntry[]; unconfirmed: OfferEntry[] };

export const EMPTY_STATE: OfferState = Object.freeze({ pending: [], unconfirmed: [] }) as OfferState;

/** 等待秒數＝decideWindowSec + 10；讀不到／不合法 → 35 */
export function waitSecFor(decideWindowSec: unknown): number {
  return typeof decideWindowSec === 'number' && Number.isFinite(decideWindowSec) && decideWindowSec >= 5 && decideWindowSec <= 60
    ? Math.round(decideWindowSec) + GRACE_SEC
    : FALLBACK_WAIT_SEC;
}

const byAtDesc = (a: OfferEntry, b: OfferEntry) => b.at - a.at;

/** 收到 offerPending。minutes 非 1~90 整數 → 忽略；同分鐘 90 秒內重複 → 忽略 */
export function recordOffer(s: OfferState, min: number, at: number, id: string): OfferState {
  if (!Number.isInteger(min) || min < 1 || min > 90) return s;
  const dup = [...s.pending, ...s.unconfirmed].some((e) => e.min === min && Math.abs(at - e.at) <= DEDUPE_MS);
  if (dup) return s;
  return { ...s, pending: [...s.pending, { id, min, at }] };
}

/** 收到同分鐘的 order 事件（含延遲入帳）：移除最早的一筆同分鐘邀請（pending 或 unconfirmed） */
export function matchOrder(s: OfferState, min: number): OfferState {
  const all = [...s.pending, ...s.unconfirmed].filter((e) => e.min === min);
  if (!all.length) return s;
  const target = all.reduce((a, b) => (b.at < a.at ? b : a));
  return {
    pending: s.pending.filter((e) => e.id !== target.id),
    unconfirmed: s.unconfirmed.filter((e) => e.id !== target.id),
  };
}

/** 使用者按「沒接」或「有接」之後移除 */
export function removeEntry(s: OfferState, id: string): OfferState {
  return {
    pending: s.pending.filter((e) => e.id !== id),
    unconfirmed: s.unconfirmed.filter((e) => e.id !== id),
  };
}

/** 時間推進：逾等待秒數的 pending → unconfirmed；超過 30 分鐘的全部丟掉；unconfirmed 只留最近 3 張（新的在前） */
export function tick(s: OfferState, now: number, waitSec: number): OfferState {
  const alive = (e: OfferEntry) => now - e.at < EXPIRE_MS;
  const due = s.pending.filter((e) => alive(e) && now - e.at >= waitSec * 1000);
  const pending = s.pending.filter((e) => alive(e) && now - e.at < waitSec * 1000);
  const unconfirmed = [...s.unconfirmed.filter(alive), ...due].sort(byAtDesc).slice(0, MAX_UNCONFIRMED);
  if (!due.length && pending.length === s.pending.length && unconfirmed.length === s.unconfirmed.length) return s;
  return { pending, unconfirmed };
}

/** 補單的接單時間 */
export function confirmAcceptedAt(e: OfferEntry): number {
  return e.at + CONFIRM_ACCEPT_DELAY_SEC * 1000;
}

/** AsyncStorage 內容（不可信）→ 狀態；壞資料 → 空 */
export function parseOfferState(raw: unknown): OfferState {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return { pending: [], unconfirmed: [] };
    }
  }
  const list = (x: unknown): OfferEntry[] =>
    Array.isArray(x)
      ? x
          .filter(
            (e): e is OfferEntry =>
              !!e && typeof e === 'object' && typeof e.id === 'string' && Number.isInteger(e.min) && e.min >= 1 && e.min <= 90 && Number.isFinite(e.at),
          )
          .map((e) => ({ id: e.id, min: e.min, at: e.at }))
      : [];
  if (!v || typeof v !== 'object') return { pending: [], unconfirmed: [] };
  const o = v as Record<string, unknown>;
  return { pending: list(o.pending), unconfirmed: list(o.unconfirmed) };
}
