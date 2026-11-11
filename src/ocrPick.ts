// OCR 文字 → 預估分鐘數的挑選規則（純函式，無 import，可直接被 node --test 載入）。
// ⚠️ 與 native/intents/MinutePicker.swift 的 MinutePicker.pick 必須是同一套規則；改一邊就改另一邊，
//    並跑 `node --test` 驗樣本。App 執行期實際用的是 Swift 版（背景 intent 不跑 JS）。
//
// 規則：
//  1. 正規化：\r\n/\r → \n；全形數字 ０-９ → 0-9；全形空白 → 半形空白。
//  2. 候選＝「1~3 位整數 + 空白(含換行) + 分鐘|分钟|分|min」，數字前後不得緊鄰數字或小數點
//     （排除 3.2 公里、1234 這類）；容忍 OCR 把「18」與「分鐘」拆成兩行。
//  3. 數值不在 1~90 的候選丟棄。
//  4. 優先序：數字所在行含關鍵字（tier 0）> 上一行或下一行含關鍵字（tier 1）> 其他（tier 2）；
//     同 tier 取最先出現者。全無候選 → null。

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 90;
export const KEYWORDS = [
  '送達', '預計', '預估', '抵達', '完成', '剩餘',
  // 簡體（OCR 偶爾會辨成簡體字形）
  '送达', '预计', '预估', '抵达', '剩余',
];

const CANDIDATE = /(?<![0-9.])([0-9]{1,3})(?![0-9.])\s*(?:分鐘|分钟|分|min)/gi;

export function normalizeOcrText(raw: string): string {
  let out = '';
  for (const ch of raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xff10 + 0x30);
    else if (c === 0x3000) out += ' ';
    else out += ch;
  }
  return out;
}

function lineHasKeyword(lines: string[], i: number): boolean {
  if (i < 0 || i >= lines.length) return false;
  return KEYWORDS.some((k) => lines[i].includes(k));
}

export function pickMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = normalizeOcrText(raw);
  const lines = text.split('\n');
  let best: { tier: number; value: number } | null = null;
  CANDIDATE.lastIndex = 0;
  for (const m of text.matchAll(CANDIDATE)) {
    const value = parseInt(m[1], 10);
    if (!(value >= MIN_MINUTES && value <= MAX_MINUTES)) continue;
    const start = m.index ?? 0;
    const lineIdx = text.slice(0, start).split('\n').length - 1;
    const tier = lineHasKeyword(lines, lineIdx)
      ? 0
      : lineHasKeyword(lines, lineIdx - 1) || lineHasKeyword(lines, lineIdx + 1)
        ? 1
        : 2;
    if (!best || tier < best.tier) best = { tier, value };
  }
  return best?.value ?? pickMinutesFromAmount(text);
}

// ── 規則 5（備援）：畫面沒有「XX 分鐘」時，用新單金額回推 ──
// 依使用者 3 期報酬單 583 筆驗證：預估報酬 = max(45, 預估分鐘 × 4.08355)，無例外。
// 金額 ≤45 時分不出分鐘數（全部是 45 元），保守當 SHORT_ORDER_MINUTES。
// 金額候選＝「2~4 位數(可帶 1~2 位小數) + $/＄/元」或「$/＄/NT$ + 數字」，範圍 30~600，取第一個。
export const RATE_PER_MINUTE = 4.08355;
export const MIN_FARE = 45;
export const SHORT_ORDER_MINUTES = 8;
const AMOUNT_AFTER = /(?<![0-9.])([0-9]{2,4}(?:\.[0-9]{1,2})?)\s*(?:\$|＄|元)/;
const AMOUNT_BEFORE = /(?:NT)?(?:\$|＄)\s*([0-9]{2,4}(?:\.[0-9]{1,2})?)(?![0-9])/i;

export function minutesFromAmount(amount: number): number | null {
  if (!(amount >= 30 && amount <= 600)) return null;
  if (amount <= MIN_FARE + 0.005) return SHORT_ORDER_MINUTES;
  const m = Math.round(amount / RATE_PER_MINUTE);
  return m >= MIN_MINUTES && m <= MAX_MINUTES ? m : null;
}

export function pickMinutesFromAmount(text: string): number | null {
  const amount = firstAmount(text);
  return amount == null ? null : minutesFromAmount(amount);
}

function firstAmount(text: string): number | null {
  const m = AMOUNT_AFTER.exec(text) ?? AMOUNT_BEFORE.exec(text);
  return m ? parseFloat(m[1]) : null;
}

/**
 * v0.6：畫面上的第一個金額（「110.26 $」優先，其次「$ 110.26」）；沒有 → null。
 * 螢幕廣播偵測用「分鐘數＋金額」辨識是不是同一張新單（與 MinutePicker.pickAmount 同規則）。
 */
export function pickAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  return firstAmount(normalizeOcrText(raw));
}

/** 金額 → 訊號/去重用的整數鍵（四捨五入，0~999；抓不到或超出範圍 → 0） */
export function amountKey(amount: number | null | undefined): number {
  if (amount == null || !Number.isFinite(amount)) return 0;
  const k = Math.round(amount);
  return k >= 1 && k <= 999 ? k : 0;
}

// ── v0.3 螢幕廣播自動偵測：只有「新單畫面」才觸發 ──
// ⚠️ 與 targets/broadcast/OrderDetector.swift 同一套規則；改一邊就改另一邊。
// 新單畫面的特徵＝畫面上有「接受訂單」按鈕（地圖待命、訂單詳情、取餐/送餐頁都沒有）。
// OCR 可能在字間插空白、或辨成簡體字形 → 先去掉所有空白再比對繁/簡兩種寫法；
// 前面緊接「已」的（已接受訂單…）不算。
const ACCEPT_MARKER = /(?<!已)接受(?:訂單|订单)/;

export function hasAcceptButton(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const compact = normalizeOcrText(raw).replace(/\s+/g, '');
  return ACCEPT_MARKER.test(compact);
}

/** 新單畫面 → 預估分鐘數；不是新單畫面或挑不出分鐘數 → null */
export function detectNewOrderMinutes(raw: string | null | undefined): number | null {
  if (!hasAcceptButton(raw)) return null;
  return pickMinutes(raw);
}
