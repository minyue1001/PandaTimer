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
//   v0.8 夾單：同一張邀請任一次 OCR 看到「夾單」（offer.stackedKeywords）→ offer.stacked=true（之後不會變回 false）。
//   v1.1 OCR 誤讀防護（11/13 實機：新邀請滑入時畫面同時有取餐頁，分鐘讀成 1 → 送了 offer.pending.1）：
//     分鐘 < suspectBelowMinutes（3）且同畫面命中接單後關鍵字（offerAccepted）→ 不當新邀請（suspect 事件，不送 pending），
//     當成「有接單鈕但分鐘還讀不出來」（offered 仍算在畫面上）；是目前這張的同一張則照常。0＝關閉。
//   v1.2（11/14 實機）：
//     ① 金額誤讀：分鐘相同、其中一個金額低於 fare(分鐘)−0.01（不可能的低值，例 11 分讀成 $11）→ 同一張（保留合理的那個金額）；
//        兩個金額都合理但不同 → 照舊當不同張（金額可能含小費）。
//     ② 常駐字不當接單證據：送單中畫面一直有「N筆訂單」「取餐體驗」（offer.weakAcceptedKeywords）。判定時只命中這些字 →
//        只有在「邀請出現前 BASELINE_SEC 秒內沒看過」或「N 比邀請前大」時才算接單，否則當沒命中（等到期走 ambiguousAs）。
//     ③ 組合單/小費：邀請畫面「送餐資訊」出現次數（bundle，取最大）與「包含額外 N 元」（tip）記在 Offer，接單後由
//        extension 拆單（src/offerBundle.ts splitBundle）。
//   v1.2.4（11/18 14:38、15:01 實機）：邀請消失後「第一次」沒接單鈕的畫面就是接單後畫面（抵達店家…），但 goneAfterMisses=2
//     時那一幀只算 miss、不看關鍵字；下一幀（地圖/空白）沒字 → 等到逾時判未接。→ 消失途中（未滿 goneAfterMisses）看到的
//     接單/未接證據先記著（missEvidence），進 deciding 那一幀自己沒證據就用它（acceptedAt 仍＝goneAt）；接單鈕又出現就清掉。
//   v1.2.8（11/22 09:17、09:19、09:31 實機：帶著單時沒接的邀請，消失後露出原本那張的「抵達店家/即將準備完成」→ 被判接單）：
//     接單證據必須是「邀請前沒有的新東西」——②的規則推廣到所有接單字：邀請前 BASELINE_SEC 秒內的非邀請畫面（任何狀態，
//     不只 idle）出現過的接單字（acceptTerms 摘要；OCR 少讀前後字也算看過：看過的字包含它即可）不算證據。仍成立：邀請前沒看過的接單字、
//     「N筆訂單」比邀請前大、只剩常駐字且邀請前沒看過常駐字。送達/取餐確認/別的 pandarider 頁之前的紀錄過期（resetLevel、
//     baselineOf）。證據不足 → 到期依 ambiguousAs（線上 reject）→ App「你有接嗎？」卡補記。
import { amountKey } from './ocrPick.ts';
import {
  DEFAULT_ACCEPTED_KEYWORDS,
  DEFAULT_BUNDLE_KEYWORDS,
  DEFAULT_REJECTED_KEYWORDS,
  DEFAULT_STACKED_KEYWORDS,
  DEFAULT_WEAK_ACCEPTED_KEYWORDS,
} from './screenInfo.ts';

export type Ambiguous = 'accept' | 'reject';

export type OfferSettings = {
  goneAfterMisses: number;
  decideWindowSec: number;
  acceptedKeywords: string;
  rejectedKeywords: string;
  ambiguousAs: Ambiguous;
  /** v0.8 邀請畫面上的夾單字樣（正則，去空白文字比對） */
  stackedKeywords: string;
  /** v1.1 分鐘數小於這個值又同時有接單後字樣 → 疑似誤讀，不當新邀請（0＝關閉） */
  suspectBelowMinutes: number;
  /** v1.2 送單中畫面常駐的接單字（單獨命中不算接單證據；正則，去空白文字比對） */
  weakAcceptedKeywords: string;
  /** v1.2 邀請畫面每位客人一個的區塊標題（出現 ≥2 次＝組合單） */
  bundleKeywords: string;
  /** v1.2 組合單最多拆幾張（1＝不拆） */
  maxBundle: number;
};

export const DEFAULT_OFFER: Readonly<OfferSettings> = Object.freeze({
  goneAfterMisses: 2,
  decideWindowSec: 25,
  acceptedKeywords: DEFAULT_ACCEPTED_KEYWORDS,
  rejectedKeywords: DEFAULT_REJECTED_KEYWORDS,
  ambiguousAs: 'accept',
  stackedKeywords: DEFAULT_STACKED_KEYWORDS,
  suspectBelowMinutes: 3,
  weakAcceptedKeywords: DEFAULT_WEAK_ACCEPTED_KEYWORDS,
  bundleKeywords: DEFAULT_BUNDLE_KEYWORDS,
  maxBundle: 4,
});

/** v1.2：邀請出現前多少秒內的畫面算「邀請前」；v1.2.8 120 → 600（11/22 09:17 帶單畫面在邀請前 123 秒、09:31 在 531 秒） */
export const BASELINE_SEC = 600;
/** v1.2.8：邀請前這麼多秒內看過「N筆訂單」N≥2（手上不只一張，另一家店的頁面隨時會再出現）→ 別的頁不讓紀錄過期 */
export const MULTI_SEC = 300;
/** v1.2 常駐字/「N筆訂單」：邀請前這麼多秒內看過就算（不受過期標記影響＝v1.2 原規則；過期標記只管店家頁的接單字） */
export const WEAK_BASELINE_SEC = 120;
/** v1.2.8 紀錄最多幾幀（記憶體上限；＝Swift OfferTracker.maxLog） */
export const MAX_BASELINE_LOG = 800;

/** v1.2.8 邀請前紀錄的一幀（非邀請畫面）；reset：0＝無、1＝別的頁（soft）、2＝送達/取餐確認（hard） */
export type BaselineEntry = { at: number; weak: boolean; orders: number | null; terms: string[]; reset: 0 | 1 | 2 };

export type Baseline = { weak: boolean; orders: number | null; terms: string[] };

/** 狀態機只吃這些（ScreenSummary 的子集合）；OCR 原文不進來 */
export type OfferObservation = {
  accept: boolean;
  minutes: number | null;
  amount: number | null;
  offerAccepted: boolean;
  offerRejected: boolean;
  offerHit: string[];
  kw: string[];
  /** v0.8：這次 OCR 看到夾單字樣（舊樣本沒有這欄 → 當 false） */
  stacked?: boolean;
  /** v1.2：去掉常駐字後仍命中接單字（沒有這欄 → 視為 true＝舊行為） */
  acceptStrong?: boolean;
  /** v1.2：命中常駐字（筆訂單/取餐體驗） */
  acceptWeak?: boolean;
  /** v1.2：「N筆訂單」的 N */
  orders?: number | null;
  /** v1.2.8：去掉常駐字後命中的接單字摘要（沒有這欄 → 強證據一律算新的＝舊行為）；子字串摘要（邀請前紀錄用，沒有 → 用 acceptTerms） */
  acceptTerms?: string[];
  acceptTermParts?: string[];
  /** v1.2.8：送達畫面（delivery.completedKeywords）、取餐確認畫面（已取餐）→ 更早的紀錄過期（resetLevel 2） */
  delivered?: boolean;
  pickedUp?: boolean;
  /** v1.2.8：別的 pandarider 頁（ScreenSummary.otherPage）→ 更早的紀錄過期（resetLevel 1） */
  otherPage?: boolean;
  /** v1.2：「送餐資訊」出現次數 */
  bundle?: number;
  /** v1.2：小費（整數元） */
  tip?: number | null;
  /** v1.4：邀請畫面的店家名稱（ScreenSummary.store） */
  store?: string | null;
};

export type Offer = {
  minutes: number;
  amount: number | null;
  /** 「分鐘/金額取整」；金額補齊時一起更新 */
  key: string;
  firstSeen: number;
  lastSeen: number;
  /** v0.8 夾單 */
  stacked: boolean;
  /** v1.2 組合單張數（邀請期間看到的「送餐資訊」最大次數；<2＝一般單） */
  bundle: number;
  /** v1.2 小費（整數元；最近一次讀到的） */
  tip: number | null;
  /** v1.4 店家名稱（最近一次讀到的；隨 order/offer_decided telemetry 送，給訂單/拒單紀錄顯示） */
  store: string | null;
  /** v1.2 邀請出現前 BASELINE_SEC 秒內：有沒有看過常駐字、最大的「N筆訂單」 */
  baseWeak: boolean;
  baseOrders: number | null;
  /** v1.2.8 邀請前看過的接單字（子字串摘要，見 baselineOf） */
  baseTerms: string[];
};

export type DecisionReason = 'accepted' | 'rejected' | 'timeout' | 'superseded' | 'replaced' | 'stopped';

export type OfferEvent =
  | { type: 'seen'; offer: Offer }
  | { type: 'resumed'; offer: Offer; awaySec: number }
  | { type: 'dup'; minutes: number; amount: number | null }
  /** v1.1 疑似誤讀的邀請（分鐘太小＋同畫面有接單後字樣）：不送 pending */
  | { type: 'suspect'; minutes: number }
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

/** 平台報酬（整數分）＝src/orders.ts exactFare：max(4500, floor(分×24500/60)+1)（Swift OfferTracker.fareCents） */
export function fareCents(minutes: number): number {
  return Math.max(4500, Math.floor((minutes * 24500) / 60) + 1);
}

/** v1.2 金額合理？≥ fare(分鐘)−0.01（含小費只會更高）；沒抓到金額 → true（不當誤讀） */
export function plausibleAmount(minutes: number, amount: number | null | undefined): boolean {
  if (amount == null || !Number.isFinite(amount)) return true;
  return Math.round(amount * 100) >= fareCents(minutes) - 1;
}

/** 同一張邀請？分鐘相同，且金額相同或任一方沒抓到（amountKey＝0）；v1.2 或其中一方金額不可能地低（誤讀） */
export function sameOffer(minutesA: number, amountA: number | null, minutesB: number, amountB: number | null): boolean {
  if (minutesA !== minutesB) return false;
  if (!plausibleAmount(minutesA, amountA) || !plausibleAmount(minutesB, amountB)) return true;
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
  /** v1.2 非邀請畫面紀錄（常駐字/N筆訂單；v1.2.8 加接單字與過期標記、任何狀態都記），只留 BASELINE_SEC 秒 */
  private idleLog: BaselineEntry[] = [];
  /** v1.2.4 offered 消失途中（misses < goneAfterMisses）第一個有證據的畫面 */
  private missEvidence: { accept: boolean; reject: boolean; kw: string[]; hit: string[] } | null = null;

  constructor(settings: OfferSettings = DEFAULT_OFFER, dedupeSeconds = 90) {
    this.settings = { ...settings };
    this.dedupeSeconds = dedupeSeconds;
  }

  get kind(): State['kind'] {
    return this.state.kind;
  }

  /** v0.8：offered/deciding 中（extension 用來維持快速 OCR） */
  get active(): boolean {
    return this.state.kind !== 'idle';
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
      this.missEvidence = null;
      const st = this.state;
      const current = st.kind === 'idle' ? null : st.offer;
      const suspect =
        o.minutes != null && s.suspectBelowMinutes > 0 && o.minutes < s.suspectBelowMinutes && o.offerAccepted &&
        !(current && sameOffer(current.minutes, current.amount, o.minutes, o.amount));
      if (suspect) out.push({ type: 'suspect', minutes: o.minutes as number });
      if (o.minutes == null || suspect) {
        // 有接單鈕但還挑不出分鐘數（動畫中）：offered 視為仍在畫面上；其他狀態等下一次 OCR
        if (st.kind === 'offered') {
          st.offer.lastSeen = now;
          st.misses = 0;
          st.firstMissAt = null;
          if (o.stacked) st.offer.stacked = true;
          this.noteExtras(st.offer, o);
        }
        return out.concat(this.tick(now));
      }
      const minutes = o.minutes as number;
      const same = (x: { minutes: number; amount: number | null }) => sameOffer(x.minutes, x.amount, minutes, o.amount);
      if (st.kind === 'offered') {
        if (same(st.offer)) {
          st.offer.lastSeen = now;
          st.misses = 0;
          st.firstMissAt = null;
          this.fillAmount(st.offer, o.amount);
          if (o.stacked) st.offer.stacked = true;
          this.noteExtras(st.offer, o);
          return out;
        }
        out.push(this.decide(now, 'reject', 'replaced', null, o.kw, []));
      } else if (st.kind === 'deciding') {
        if (same(st.offer)) {
          const offer = { ...st.offer, lastSeen: now, stacked: st.offer.stacked || !!o.stacked };
          this.fillAmount(offer, o.amount);
          this.noteExtras(offer, o);
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
      const base = baselineOf(this.idleLog, now);
      const offer: Offer = {
        minutes, amount: o.amount, key: offerKeyOf(minutes, o.amount), firstSeen: now, lastSeen: now, stacked: !!o.stacked,
        bundle: 0, tip: null, store: null, baseWeak: base.weak, baseOrders: base.orders, baseTerms: base.terms,
      };
      this.noteExtras(offer, o);
      this.state = { kind: 'offered', offer, misses: 0, firstMissAt: null };
      out.push({ type: 'seen', offer });
      return out;
    }

    // 畫面上沒有接單鈕：v1.2.8 任何狀態都記進邀請前紀錄（判定中/消失途中的畫面對「下一張」也是邀請前）
    this.noteScreen(now, o);
    const st = this.state;
    if (st.kind === 'idle') {
      this.idleMisses += 1;
      if (this.idleMisses >= s.goneAfterMisses) this.ignored = null;
      return out;
    }
    if (st.kind === 'offered') {
      st.misses += 1;
      if (st.firstMissAt == null) st.firstMissAt = now;
      if (st.misses < s.goneAfterMisses) {
        // v1.2.4 還沒確定消失：這一幀的證據先記著（只留第一個）
        const acc = acceptEvidence(st.offer, o);
        if (!this.missEvidence && (acc || o.offerRejected)) {
          this.missEvidence = { accept: acc, reject: o.offerRejected, kw: [...o.kw], hit: [...o.offerHit] };
        }
        return out;
      }
      this.state = { kind: 'deciding', offer: st.offer, goneAt: st.firstMissAt, lastKw: o.kw };
    }
    const d = this.state as Extract<State, { kind: 'deciding' }>;
    d.lastKw = o.kw;
    let accepted = acceptEvidence(d.offer, o);
    let rejected = o.offerRejected;
    let kw = o.kw;
    let hit = o.offerHit;
    const early = this.missEvidence;
    this.missEvidence = null;
    if (!accepted && !rejected && early) {
      accepted = early.accept;
      rejected = early.reject;
      kw = early.kw;
      hit = early.hit;
    }
    if (accepted && !rejected) {
      out.push(this.decide(now, 'accept', 'accepted', d.goneAt, kw, hit));
      return out;
    }
    if (rejected && !accepted) {
      out.push(this.decide(now, 'reject', 'rejected', d.goneAt, kw, hit));
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

  /** 先前沒抓到金額、這次抓到 → 補上（key 一起更新）；v1.2 先前的是誤讀（不可能地低）、這次合理 → 換成這次的 */
  private fillAmount(offer: Offer, amount: number | null): void {
    if (amountKey(amount) === 0) return;
    const missing = amountKey(offer.amount) === 0;
    const better = !plausibleAmount(offer.minutes, offer.amount) && plausibleAmount(offer.minutes, amount);
    if (missing || better) {
      offer.amount = amount;
      offer.key = offerKeyOf(offer.minutes, amount);
    }
  }

  /** v1.2.8 非邀請畫面進紀錄（只留 BASELINE_SEC 秒；過期標記見 resetLevel） */
  private noteScreen(now: number, o: OfferObservation): void {
    this.idleLog = this.idleLog.filter((e) => now - e.at <= BASELINE_SEC);
    const terms = o.acceptTermParts ?? o.acceptTerms ?? [];
    this.idleLog.push({ at: now, weak: !!o.acceptWeak, orders: o.orders ?? null, terms, reset: resetLevel(o) });
    if (this.idleLog.length > MAX_BASELINE_LOG) this.idleLog.splice(0, this.idleLog.length - MAX_BASELINE_LOG);
  }

  /** v1.2 組合單張數取最大、小費取最近讀到的；v1.4 店名取最近讀到的 */
  private noteExtras(offer: Offer, o: OfferObservation): void {
    if (o.bundle != null && o.bundle > offer.bundle) offer.bundle = o.bundle;
    if (o.tip != null) offer.tip = o.tip;
    if (o.store) offer.store = o.store;
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
    this.missEvidence = null;
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

/**
 * v1.2.8 這個非邀請畫面讓更早看過的接單字過期到什麼程度（這一幀自己照算）：
 *   2（hard）送達畫面（delivered：完成訂單/已送達…，前一張結束）、取餐確認（pickedUp：已取餐，那家店的頁面不會再出現；
 *     11/15 02:45、02:48 實機：剛按已取餐就接疊單）；
 *   1（soft）別的 pandarider 頁（otherPage：送達$/取消/送餐段/地圖…；或「1筆訂單」且沒有強接單字）＝使用者離開過店家頁，
 *     之後再出現店家頁＝App 換頁了（11/15 13:29、19:02、11/17 19:05、22:26、11/19 20:51 實機：取消上一張→接新單，
 *     中間都有「送達 $金額」頁；11/22 10:05：8 分鐘前的抵達店家）。
 */
export function resetLevel(o: OfferObservation): 0 | 1 | 2 {
  if (o.delivered || o.pickedUp) return 2;
  if (o.otherPage || (o.orders === 1 && !(o.acceptTerms ?? []).length)) return 1;
  return 0;
}

/**
 * v1.2.8 邀請出現時（now）的「邀請前」：BASELINE_SEC 秒內從最新往回累積接單字/常駐字/最大 N，遇到過期標記就停（那一幀算進去）；
 * 常駐字/N 另外 WEAK_BASELINE_SEC 秒內看過就算（v1.2 原規則，不看過期標記；11/15 02:02 實機：邀請滑入前一幀只有「夾單」）。
 * hard 一定停；soft 只在「MULTI_SEC 秒內沒看過 N≥2」時停（手上兩張以上時另一家店的頁面會再出現：11/22 09:31 實機，
 * 送餐段「2筆訂單」頁、「送達 $」頁之後跳邀請，消失後露出 9 分鐘前那家店的頁面）。
 */
export function baselineOf(log: readonly BaselineEntry[], now: number): Baseline {
  const recent = log.filter((e) => e.at <= now && now - e.at <= BASELINE_SEC);
  const multi = recent.some((e) => now - e.at <= MULTI_SEC && e.orders != null && e.orders >= 2);
  const out: Baseline = { weak: false, orders: null, terms: [] };
  const take = (e: BaselineEntry) => {
    if (e.weak) out.weak = true;
    if (e.orders != null && (out.orders == null || e.orders > out.orders)) out.orders = e.orders;
  };
  for (const e of recent) if (now - e.at <= WEAK_BASELINE_SEC) take(e);
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i];
    take(e);
    for (const t of e.terms) if (!out.terms.includes(t)) out.terms.push(t);
    if (e.reset === 2 || (e.reset === 1 && !multi)) break;
  }
  return out;
}

/**
 * 判定中這次畫面算不算「接了」：沒命中 acceptedKeywords → 否；「N筆訂單」比邀請前大（疊單 1→2）→ 是；
 * v1.2.8 去掉常駐字還命中（強證據）→ 其中有邀請前沒看過的接單字才算（邀請前看過的字包含它＝看過：OCR 少讀前後字）；
 * v1.2 只剩常駐字 → 邀請前沒看過常駐字（例：空手接單後才出現「1筆訂單」）才算。
 */
export function acceptEvidence(
  offer: Pick<Offer, 'baseWeak' | 'baseOrders'> & { baseTerms?: string[] },
  o: OfferObservation,
): boolean {
  if (!o.offerAccepted) return false;
  if (o.orders != null && offer.baseOrders != null && o.orders > offer.baseOrders) return true;
  if (!(o.acceptStrong ?? true)) return !offer.baseWeak;
  if (!o.acceptTerms) return true;
  const base = offer.baseTerms ?? [];
  return o.acceptTerms.some((t) => !base.includes(t));
}

/** extension → App 的延遲秒數（App 用「收到時間 − 延遲」還原 acceptedAt）：四捨五入、夾在 0…60 */
export function acceptDelaySeconds(decidedAt: number, acceptedAt: number): number {
  const d = Math.round(decidedAt - acceptedAt);
  return Math.min(60, Math.max(0, Number.isFinite(d) ? d : 0));
}
