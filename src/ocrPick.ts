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
  const m = AMOUNT_AFTER.exec(text) ?? AMOUNT_BEFORE.exec(text);
  return m ? minutesFromAmount(parseFloat(m[1])) : null;
}
