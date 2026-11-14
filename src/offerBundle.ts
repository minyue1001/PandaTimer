// v1.2 組合單拆分＋送單畫面「N 筆訂單」提示（純函式，無副作用；時間一律用「秒」）。
// ⚠️ 與 targets/broadcast/OfferTracker.swift 的 BundleSplit / ScreenOrdersWatch 同一套規則（Swift 在 WSL 不能跑，以這份＋
//    test/offerBundle.test.mjs 為準；改一邊改兩邊）。
//
// 組合單（11/14 12:28 實機）：一張邀請「每單收入 94.01 $ / 23 分鐘」下面有兩個「送餐資訊」區塊（兩位客人）＝其實是
//   12 分 $49.01 ＋ 11 分 $45 兩張單。拆法：總分鐘 T、總金額 A（先扣小費）、N 張 → 找每張 ≥1 分、和為 T 的分鐘組合
//   （不計順序），使 Σfare 與 A 相差 ≤0.02；恰好一組 → 用它（大的在前）；v1.2.1 起多組/無解 → 不拆（平均分已拿掉）。
// 送單畫面「N 筆訂單」（11/14 12:13：疊單的第二張沒有邀請畫面 → 漏記）：extension 不知道 App 有幾張單 → 只要沒有邀請進行中、
//   連續 ≥2 次 OCR 讀到同一個 N（2~5；v1.2.1 起只認「N筆訂單」數字，「疊單」字樣不算）就送 com.pandatimer.screenorders.<N>，同 N 5 分鐘只送一次、
//   接單後 15 秒內不送（組合單的第二張訊號還在路上）；App 比對進行中單數 < N 才提示補記。
import { fareCents } from './offerTracker.ts';

export const MAX_BUNDLE = 4;

/** 平均分：餘數給前面（23/2 → [12, 11]） */
export function evenSplit(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

/**
 * 組合單拆分。totalMin＝邀請分鐘數、amount＝邀請金額（含小費）、n＝「送餐資訊」個數、tip＝小費（沒有 → null）。
 * n < 2、分鐘數不合理或不夠分 → [totalMin]（不拆）；n 上限 MAX_BUNDLE。
 * v1.2.1：只在「恰好一組」分鐘組合對得上金額才拆，其餘（金額<N×45、單張也對得上、多解、無解、沒金額）一律不拆。
 */
export function splitBundle(totalMin: number, amount: number | null, n: number, tip: number | null = null): number[] {
  const k = Math.min(MAX_BUNDLE, Math.floor(n));
  if (!Number.isInteger(totalMin) || totalMin < 1 || !(k >= 2) || totalMin < k) return [totalMin];
  // v1.2.1：金額不明、不到 N×45（每張最低報酬）、單張就對得上、多解、無解 → 一律不拆（當一張）
  if (amount == null || !Number.isFinite(amount)) return [totalMin];
  const target = Math.round((amount - (tip ?? 0)) * 100);
  if (target < k * 4500 - 1) return [totalMin];
  if (Math.abs(fareCents(totalMin) - target) <= 2) return [totalMin];
  const found: number[][] = [];
  // 不增序列（大的在前）列舉：每張 ≥1、總和 T；找到第 2 組就停（多解＝平均分）
  const walk = (left: number, slots: number, maxPart: number, acc: number[], cents: number) => {
    if (found.length > 1) return;
    if (slots === 0) {
      if (left === 0 && Math.abs(cents - target) <= 2) found.push(acc.slice());
      return;
    }
    const hi = Math.min(maxPart, left - (slots - 1));
    const lo = Math.ceil(left / slots);
    for (let m = hi; m >= lo; m--) {
      acc.push(m);
      walk(left - m, slots - 1, m, acc, cents + fareCents(m));
      acc.pop();
    }
  };
  walk(totalMin, k, totalMin, [], 0);
  return found.length === 1 ? found[0] : [totalMin];
}

/** v1.2.2 疊單字樣要距最近一次送達訊號至少這麼久才算（delivery.stackScreenGapSec，0~600；剛送完單殘留字樣會誤報） */
export const STACK_SCREEN_GAP_SEC = 120;

/**
 * 送單畫面上的訂單數：max(「N筆訂單」的 N, 疊單字樣 ? 2 : 0)；都沒有 → null。
 * 「疊單」字樣只在 sinceDeliveredSec（距最近一次送達訊號的秒數；從沒送過＝Infinity/null）>= gapSec 才算；「N筆訂單」不受限。
 */
export function screenOrderCount(
  orders: number | null | undefined,
  stackScreen?: boolean,
  sinceDeliveredSec: number | null = null,
  gapSec: number = STACK_SCREEN_GAP_SEC,
): number | null {
  const stackOk = !!stackScreen && (sinceDeliveredSec == null || sinceDeliveredSec >= gapSec);
  const n = Math.max(orders ?? 0, stackOk ? 2 : 0);
  return n > 0 ? n : null;
}

export const SCREEN_ORDERS_MIN = 2;
export const SCREEN_ORDERS_MAX = 5;

/** extension：送單畫面「N 筆訂單」去抖（連續 minStreak 次同 N、同 N repeatSec 內只送一次、接單後 quietSec 內不送） */
export class ScreenOrdersWatch {
  repeatSec: number;
  minStreak: number;
  quietSec: number;
  private streakN: number | null = null;
  private streak = 0;
  private quietUntil = -Infinity;
  private sentAt = new Map<number, number>();
  /** v1.2.2 最近一次送出送達訊號的時間（從沒送過＝-Infinity） */
  private lastDeliveredAt = -Infinity;
  stackGapSec = STACK_SCREEN_GAP_SEC;

  constructor(repeatSec = 300, minStreak = 2, quietSec = 15) {
    this.repeatSec = repeatSec;
    this.minStreak = minStreak;
    this.quietSec = quietSec;
  }

  /** 接單訊號送出時呼叫（組合單/疊單接單後畫面會出現「2筆訂單」，App 還沒收齊訊號） */
  accepted(now: number): void {
    this.quietUntil = now + this.quietSec;
    this.streakN = null;
    this.streak = 0;
  }

  /** 送出任何送達訊號（delivered / delivered.seq / 含 noNumber、unbound）時呼叫 */
  delivered(now: number): void {
    this.lastDeliveredAt = now;
  }

  /** 距最近一次送達訊號的秒數（從沒送過＝Infinity） */
  sinceDelivered(now: number): number {
    return now - this.lastDeliveredAt;
  }

  /** 每次 OCR：n＝screenOrderCount(orders, stackScreen, watch.sinceDelivered(now), watch.stackGapSec)；busy＝邀請進行中或畫面有接單鈕。回傳要送的 N（2~5）或 null */
  observe(now: number, n: number | null, busy: boolean): number | null {
    if (busy || n == null || n < SCREEN_ORDERS_MIN) {
      this.streakN = null;
      this.streak = 0;
      return null;
    }
    const v = Math.min(SCREEN_ORDERS_MAX, n);
    if (v === this.streakN) this.streak += 1;
    else {
      this.streakN = v;
      this.streak = 1;
    }
    if (this.streak < this.minStreak || now < this.quietUntil) return null;
    const last = this.sentAt.get(v);
    if (last != null && now - last < this.repeatSec) return null;
    this.sentAt.set(v, now);
    return v;
  }
}
