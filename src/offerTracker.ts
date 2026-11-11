// v0.7「接單後才開始倒數」：新單邀請畫面的狀態機（純邏輯，無 import 副作用；時間一律用「秒」）。
// ⚠️ 與 targets/broadcast/OfferTracker.swift 同一套規則（Swift 在 WSL 不能跑 → 這份是測試替身，以這份為準；
//    改一邊就改另一邊，並跑 `node --test`，樣本在 test/fixtures/offer-cases.json）。
//
// 狀態：
//   idle ──看到邀請（接單鈕＋分鐘數）──▶ offered（不送訂單訊號，只回報 offer_seen、送 offer.pending.<分>）
//   offered ──連續 goneAfterMisses 次 OCR 沒有接單鈕──▶ deciding(goneAt＝第一次沒看到的時間)
//   offered ──邀請直接換成另一張（分鐘/金額不同）──▶ 前一張「未接」(replaced)，新一張 offered
//   deciding（decideWindowSec 秒內持續看畫面）：
//     只命中 acceptedKeywords → 接單（acceptedAt＝goneAt）；只命中 rejectedKeywords → 未接；
//     兩邊都命中或都沒命中 → 繼續看；視窗到期 → 依 ambiguousAs（預設 accept：寧可多記也不要漏倒數）；
//     同一張（分鐘, 金額）又出現 → 回 offered（只是被短暫切走）；
//     出現另一張邀請 → 前一張依 ambiguousAs (superseded)，再進新一張的 offered。
//   接單的（分鐘, 金額）dedupeSeconds 內又出現 → dup（不算新邀請；例：逾時判接單後切回來邀請還在）。
//   v0.7 實機修正：「同一張」＝分鐘相同且（金額相同或任一方沒抓到金額）；offered 期間後來才抓到金額 → 補齊，不算新單
//   （v0.6 實機：第一次 OCR 金額沒抓到、25 秒後抓到 110.26 → 被當成兩單）。
//   廣播停止 → offered 當未接、deciding 依 ambiguousAs (stopped)。
import { amountKey } from './ocrPick.ts';
import { DEFAULT_ACCEPTED_KEYWORDS, DEFAULT_REJECTED_KEYWORDS } from './screenInfo.ts';

export type Ambiguous = 'accept' | 'reject';

export type OfferSettings = {
  goneAfterMisses: number;
  decideWindowSec: number;
  acceptedKeywords: string;
  rejectedKeywords: string;
  ambiguousAs: Ambiguous;
};

export const DEFAULT_OFFER: Readonly<OfferSettings> = Object.freeze({
  goneAfterMisses: 2,
  decideWindowSec: 25,
  acceptedKeywords: DEFAULT_ACCEPTED_KEYWORDS,
  rejectedKeywords: DEFAULT_REJECTED_KEYWORDS,
  ambiguousAs: 'accept',
});

/** 狀態機只吃這些（ScreenSummary 的子集合）；OCR 原文不進來 */
export type OfferObservation = {
  accept: boolean;
  minutes: number | null;
  amount: number | null;
  offerAccepted: boolean;
  offerRejected: boolean;
  offerHit: string[];
  kw: string[];
};

export type Offer = {
  minutes: number;
  amount: number | null;
  /** 「分鐘/金額取整」；金額補齊時一起更新 */
  key: string;
  firstSeen: number;
  lastSeen: number;
};

export type DecisionReason = 'accepted' | 'rejected' | 'timeout' | 'superseded' | 'replaced' | 'stopped';

export type OfferEvent =
  | { type: 'seen'; offer: Offer }
  | { type: 'resumed'; offer: Offer; awaySec: number }
  | { type: 'dup'; minutes: number; amount: number | null }
  | {
      type: 'decided';
      offer: Offer;
      result: Ambiguous;
      reason: DecisionReason;
      /** 接單時間（＝goneAt，按下接受的時間點）；未接 → null */
      acceptedAt: number | null;
      decidedAt: number;
      /** 從邀請消失到決定的秒數（0.1 秒）；沒消失過（replaced/stopped in offered）→ 0 */
      waitSec: number;
      /** 決定當下畫面的白名單關鍵字 */
      kw: string[];
      /** 命中 accepted/rejected 的那段文字裡的白名單詞（timeout 等 → []） */
      hit: string[];
    };

type State =
  | { kind: 'idle' }
  | { kind: 'offered'; offer: Offer; misses: number; firstMissAt: number | null }
  | { kind: 'deciding'; offer: Offer; goneAt: number; lastKw: string[] };

export function offerKeyOf(minutes: number, amount: number | null): string {
  return `${minutes}/${amountKey(amount)}`;
}

/** 同一張邀請？分鐘相同，且金額相同或任一方沒抓到（amountKey＝0） */
export function sameOffer(minutesA: number, amountA: number | null, minutesB: number, amountB: number | null): boolean {
  if (minutesA !== minutesB) return false;
  const a = amountKey(amountA);
  const b = amountKey(amountB);
  return a === 0 || b === 0 || a === b;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export class OfferTracker {
  settings: OfferSettings;
  dedupeSeconds: number;
  private state: State = { kind: 'idle' };
  /** idle 時「出現中但判定為 dup」的鍵（同一次出現只回報一次 dup） */
  private ignored: { minutes: number; amount: number | null } | null = null;
  private idleMisses = 0;
  private recentAccepted: { minutes: number; amount: number | null; at: number }[] = [];

  constructor(settings: OfferSettings = DEFAULT_OFFER, dedupeSeconds = 90) {
    this.settings = { ...settings };
    this.dedupeSeconds = dedupeSeconds;
  }

  get kind(): State['kind'] {
    return this.state.kind;
  }

  /** deciding 時：視窗到期的時間（給呼叫端排計時器；畫面靜止時 ReplayKit 不送幀，不能只靠 OCR 推進） */
  get deadline(): number | null {
    return this.state.kind === 'deciding' ? this.state.goneAt + this.settings.decideWindowSec : null;
  }

  /** 每次 OCR 完呼叫 */
  observe(now: number, o: OfferObservation): OfferEvent[] {
    const out: OfferEvent[] = [];
    const s = this.settings;
    if (o.accept) {
      this.idleMisses = 0;
      const st = this.state;
      if (o.minutes == null) {
        // 有接單鈕但還挑不出分鐘數（動畫中）：offered 視為仍在畫面上；其他狀態等下一次 OCR
        if (st.kind === 'offered') {
          st.offer.lastSeen = now;
          st.misses = 0;
          st.firstMissAt = null;
        }
        return out.concat(this.tick(now));
      }
      const minutes = o.minutes;
      const same = (x: { minutes: number; amount: number | null }) => sameOffer(x.minutes, x.amount, minutes, o.amount);
      if (st.kind === 'offered') {
        if (same(st.offer)) {
          st.offer.lastSeen = now;
          st.misses = 0;
          st.firstMissAt = null;
          this.fillAmount(st.offer, o.amount);
          return out;
        }
        out.push(this.decide(now, 'reject', 'replaced', null, o.kw, []));
      } else if (st.kind === 'deciding') {
        if (same(st.offer)) {
          const offer = { ...st.offer, lastSeen: now };
          this.fillAmount(offer, o.amount);
          this.state = { kind: 'offered', offer, misses: 0, firstMissAt: null };
          out.push({ type: 'resumed', offer, awaySec: round1(now - st.goneAt) });
          return out;
        }
        out.push(this.decide(now, s.ambiguousAs, 'superseded', st.goneAt, o.kw, []));
      } else if (this.ignored && same(this.ignored)) {
        return out;
      }
      // 新的一張邀請
      this.recentAccepted = this.recentAccepted.filter((r) => now - r.at < this.dedupeSeconds);
      if (this.recentAccepted.some(same)) {
        this.ignored = { minutes, amount: o.amount };
        out.push({ type: 'dup', minutes, amount: o.amount });
        return out;
      }
      this.ignored = null;
      const offer: Offer = { minutes, amount: o.amount, key: offerKeyOf(minutes, o.amount), firstSeen: now, lastSeen: now };
      this.state = { kind: 'offered', offer, misses: 0, firstMissAt: null };
      out.push({ type: 'seen', offer });
      return out;
    }

    // 畫面上沒有接單鈕
    const st = this.state;
    if (st.kind === 'idle') {
      this.idleMisses += 1;
      if (this.idleMisses >= s.goneAfterMisses) this.ignored = null;
      return out;
    }
    if (st.kind === 'offered') {
      st.misses += 1;
      if (st.firstMissAt == null) st.firstMissAt = now;
      if (st.misses < s.goneAfterMisses) return out;
      this.state = { kind: 'deciding', offer: st.offer, goneAt: st.firstMissAt, lastKw: o.kw };
    }
    const d = this.state as Extract<State, { kind: 'deciding' }>;
    d.lastKw = o.kw;
    if (o.offerAccepted && !o.offerRejected) {
      out.push(this.decide(now, 'accept', 'accepted', d.goneAt, o.kw, o.offerHit));
      return out;
    }
    if (o.offerRejected && !o.offerAccepted) {
      out.push(this.decide(now, 'reject', 'rejected', d.goneAt, o.kw, o.offerHit));
      return out;
    }
    return out.concat(this.tick(now));
  }

  /** 計時器/每次 OCR：deciding 視窗到期 → 依 ambiguousAs */
  tick(now: number): OfferEvent[] {
    const st = this.state;
    if (st.kind !== 'deciding' || now - st.goneAt < this.settings.decideWindowSec) return [];
    return [this.decide(now, this.settings.ambiguousAs, 'timeout', st.goneAt, st.lastKw, [])];
  }

  /** 廣播停止：offered → 未接；deciding → 依 ambiguousAs */
  finish(now: number): OfferEvent[] {
    const st = this.state;
    if (st.kind === 'offered') return [this.decide(now, 'reject', 'stopped', null, [], [])];
    if (st.kind === 'deciding') return [this.decide(now, this.settings.ambiguousAs, 'stopped', st.goneAt, st.lastKw, [])];
    return [];
  }

  /** 先前沒抓到金額、這次抓到 → 補上（key 一起更新） */
  private fillAmount(offer: Offer, amount: number | null): void {
    if (amountKey(offer.amount) === 0 && amountKey(amount) !== 0) {
      offer.amount = amount;
      offer.key = offerKeyOf(offer.minutes, amount);
    }
  }

  private decide(
    now: number,
    result: Ambiguous,
    reason: DecisionReason,
    goneAt: number | null,
    kw: string[],
    hit: string[],
  ): OfferEvent {
    const st = this.state as Exclude<State, { kind: 'idle' }>;
    const offer = st.offer;
    this.state = { kind: 'idle' };
    this.idleMisses = 0;
    if (result === 'accept') this.recentAccepted.push({ minutes: offer.minutes, amount: offer.amount, at: now });
    return {
      type: 'decided',
      offer,
      result,
      reason,
      acceptedAt: result === 'accept' ? (goneAt ?? now) : null,
      decidedAt: now,
      waitSec: goneAt == null ? 0 : round1(now - goneAt),
      kw: [...kw],
      hit: [...hit],
    };
  }
}

/** extension → App 的延遲秒數（App 用「收到時間 − 延遲」還原 acceptedAt）：四捨五入、夾在 0…60 */
export function acceptDelaySeconds(decidedAt: number, acceptedAt: number): number {
  const d = Math.round(decidedAt - acceptedAt);
  return Math.min(60, Math.max(0, Number.isFinite(d) ? d : 0));
}
