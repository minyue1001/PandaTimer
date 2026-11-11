// OCR 文字 → 預估分鐘數的挑選規則（純函式，無 import，可直接被 node --test 載入）。
// ⚠️ 與 native/intents/MinutePicker.swift（＝targets/broadcast/MinutePicker.swift）的 MinutePicker 必須是同一套規則；
//    改一邊就改另一邊，並跑 `node --test` 驗樣本。App 執行期實際用的是 Swift 版（背景 intent 不跑 JS）。
// v0.6：規則的正則/範圍/費率改成參數物件（PickerConfig），預設值＝下列常數；遠端設定（/api/config 的 "picker"）
//    可覆寫，不用重裝 App（解析與驗證見 src/remoteConfig.ts）。
//
// 規則：
//  1. 正規化：\r\n/\r → \n；全形數字 ０-９ → 0-9；全形空白 → 半形空白。
//  2. 候選＝minutePattern（預設「1~3 位整數 + 空白(含換行) + 分鐘|分钟|分|min」，數字前後不得緊鄰數字或小數點），
//     第 1 個捕捉群組＝分鐘數；不分大小寫。
//  3. 數值不在 minMinutes~maxMinutes 的候選丟棄。
//  4. 優先序：數字所在行含關鍵字（tier 0）> 上一行或下一行含關鍵字（tier 1）> 其他（tier 2）；
//     同 tier 取最先出現者。全無候選 → 規則 5（金額回推）。

export type PickerConfig = {
  minutePattern: string;
  minMinutes: number;
  maxMinutes: number;
  keywords: string[];
  amountAfterPattern: string;
  amountBeforePattern: string;
  minAmount: number;
  maxAmount: number;
  ratePerMinute: number;
  minFare: number;
  shortOrderMinutes: number;
};

export const MIN_MINUTES = 1;
export const MAX_MINUTES = 90;
export const KEYWORDS = [
  '送達', '預計', '預估', '抵達', '完成', '剩餘',
  // 簡體（OCR 偶爾會辨成簡體字形）
  '送达', '预计', '预估', '抵达', '剩余',
];
// ── 規則 5（備援）：畫面沒有「XX 分鐘」時，用新單金額回推 ──
// 依使用者 3 期報酬單 583 筆驗證：預估報酬 = max(45, 預估分鐘 × 4.08355)，無例外。
// 金額 ≤45 時分不出分鐘數（全部是 45 元），保守當 SHORT_ORDER_MINUTES。
// 金額候選＝「2~4 位數(可帶 1~2 位小數) + $/＄/元」或「$/＄/NT$ + 數字」，範圍 30~600，取第一個。
export const RATE_PER_MINUTE = 4.08355;
export const MIN_FARE = 45;
export const SHORT_ORDER_MINUTES = 8;

export const DEFAULT_PICKER: Readonly<PickerConfig> = Object.freeze({
  minutePattern: '(?<![0-9.])([0-9]{1,3})(?![0-9.])\\s*(?:分鐘|分钟|分|min)',
  minMinutes: MIN_MINUTES,
  maxMinutes: MAX_MINUTES,
  keywords: KEYWORDS,
  amountAfterPattern: '(?<![0-9.])([0-9]{2,4}(?:\\.[0-9]{1,2})?)\\s*(?:\\$|＄|元)',
  amountBeforePattern: '(?:NT)?(?:\\$|＄)\\s*([0-9]{2,4}(?:\\.[0-9]{1,2})?)(?![0-9])',
  minAmount: 30,
  maxAmount: 600,
  ratePerMinute: RATE_PER_MINUTE,
  minFare: MIN_FARE,
  shortOrderMinutes: SHORT_ORDER_MINUTES,
});

const regexCache = new Map<string, RegExp | null>();
/** 編譯並快取；編譯失敗 → null（呼叫端退回預設） */
function rx(pattern: string, flags: string): RegExp | null {
  const k = `${flags}/${pattern}`;
  if (!regexCache.has(k)) {
    let r: RegExp | null = null;
    try {
      r = new RegExp(pattern, flags);
    } catch {
      r = null;
    }
    regexCache.set(k, r);
  }
  return regexCache.get(k) ?? null;
}

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

function lineHasKeyword(lines: string[], i: number, keywords: readonly string[]): boolean {
  if (i < 0 || i >= lines.length) return false;
  return keywords.some((k) => lines[i].includes(k));
}

export function pickMinutes(raw: string | null | undefined, cfg: PickerConfig = DEFAULT_PICKER): number | null {
  if (!raw) return null;
  const text = normalizeOcrText(raw);
  const lines = text.split('\n');
  const candidate = rx(cfg.minutePattern, 'gi') ?? (rx(DEFAULT_PICKER.minutePattern, 'gi') as RegExp);
  let best: { tier: number; value: number } | null = null;
  candidate.lastIndex = 0;
  for (const m of text.matchAll(candidate)) {
    const value = parseInt(m[1], 10);
    if (!(value >= cfg.minMinutes && value <= cfg.maxMinutes)) continue;
    const start = (m.index ?? 0) + Math.max(0, m[0].indexOf(m[1]));
    const lineIdx = text.slice(0, start).split('\n').length - 1;
    const tier = lineHasKeyword(lines, lineIdx, cfg.keywords)
      ? 0
      : lineHasKeyword(lines, lineIdx - 1, cfg.keywords) || lineHasKeyword(lines, lineIdx + 1, cfg.keywords)
        ? 1
        : 2;
    if (!best || tier < best.tier) best = { tier, value };
  }
  return best?.value ?? pickMinutesFromAmount(text, cfg);
}

export function minutesFromAmount(amount: number, cfg: PickerConfig = DEFAULT_PICKER): number | null {
  if (!(amount >= cfg.minAmount && amount <= cfg.maxAmount)) return null;
  if (amount <= cfg.minFare + 0.005) return cfg.shortOrderMinutes;
  const m = Math.round(amount / cfg.ratePerMinute);
  return m >= cfg.minMinutes && m <= cfg.maxMinutes ? m : null;
}

export function pickMinutesFromAmount(text: string, cfg: PickerConfig = DEFAULT_PICKER): number | null {
  const amount = firstAmount(text, cfg);
  return amount == null ? null : minutesFromAmount(amount, cfg);
}

function firstAmount(text: string, cfg: PickerConfig): number | null {
  const after = rx(cfg.amountAfterPattern, 'i') ?? rx(DEFAULT_PICKER.amountAfterPattern, 'i');
  const before = rx(cfg.amountBeforePattern, 'i') ?? rx(DEFAULT_PICKER.amountBeforePattern, 'i');
  for (const r of [after, before]) {
    const m = r?.exec(text);
    if (!m || m[1] == null) continue;
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * v0.6：畫面上的第一個金額（「110.26 $」優先，其次「$ 110.26」）；沒有 → null。
 * 螢幕廣播偵測用「分鐘數＋金額」辨識是不是同一張新單（與 MinutePicker.pickAmount 同規則）。
 */
export function pickAmount(raw: string | null | undefined, cfg: PickerConfig = DEFAULT_PICKER): number | null {
  if (!raw) return null;
  return firstAmount(normalizeOcrText(raw), cfg);
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
// 前面緊接「已」的（已接受訂單…）不算。v0.6：正則可由遠端設定 detector.acceptPattern 覆寫。
export const DEFAULT_ACCEPT_PATTERN = '(?<!已)接受(?:訂單|订单)';

export function hasAcceptButton(raw: string | null | undefined, acceptPattern: string = DEFAULT_ACCEPT_PATTERN): boolean {
  if (!raw) return false;
  const compact = normalizeOcrText(raw).replace(/\s+/g, '');
  const marker = rx(acceptPattern, '') ?? (rx(DEFAULT_ACCEPT_PATTERN, '') as RegExp);
  return marker.test(compact);
}

/** 新單畫面 → 預估分鐘數；不是新單畫面或挑不出分鐘數 → null */
export function detectNewOrderMinutes(
  raw: string | null | undefined,
  cfg: PickerConfig = DEFAULT_PICKER,
  acceptPattern: string = DEFAULT_ACCEPT_PATTERN,
): number | null {
  if (!hasAcceptButton(raw, acceptPattern)) return null;
  return pickMinutes(raw, cfg);
}
