// v0.6 遠端狀態回報（telemetry）用的畫面摘要：只產生**結構化欄位**，絕不輸出 OCR 原文。
// ⚠️ 與 targets/broadcast/OrderDetector.swift 的 ScreenInfo 同一套規則（Swift 在 WSL 不能跑，這份是測試替身），
//    白名單關鍵字另與 server/index.mjs 的 TELEMETRY_KEYWORDS 一致（伺服器會再過濾一次）；改一邊改三邊（test 會比對）。
// 隱私鐵律：不得上傳 OCR 原文、地址、店名、顧客資訊 → 只回報「白名單關鍵字命中清單」、分鐘數、金額、公里數、畫面分類。
import {
  amountKey,
  DEFAULT_ACCEPT_PATTERN,
  DEFAULT_PICKER,
  hasAcceptButton,
  normalizeOcrText,
  pickAmount,
  pickMinutes,
  type PickerConfig,
} from './ocrPick.ts';

/** [正式名稱, ...OCR 可能辨成的寫法（簡體）]；回報只用正式名稱 */
export const UI_KEYWORDS: readonly (readonly string[])[] = [
  ['接受訂單', '接受订单'],
  ['拒絕', '拒绝'],
  ['前往取餐'],
  ['抵達餐廳', '抵达餐厅'],
  ['已取餐'],
  ['前往送餐'],
  ['抵達', '抵达'],
  ['送達', '送达'],
  ['完成訂單', '完成订单'],
  ['上線中', '上线中'],
  ['休息中'],
  ['訂單詳情', '订单详情'],
  ['聯絡', '联络', '聯繫', '联系'],
  ['導航', '导航'],
  ['拍照'],
  ['確認取餐', '确认取餐'],
  ['取消'],
];

export const KEYWORD_NAMES: readonly string[] = UI_KEYWORDS.map((k) => k[0]);

export type ScreenKind = 'newOrder' | 'detail' | 'delivering' | 'pickup' | 'idle' | 'other' | 'none';

/** 白名單關鍵字命中清單（正式名稱，依白名單順序，不重複） */
export function matchKeywords(raw: string | null | undefined, rows: readonly (readonly string[])[] = UI_KEYWORDS): string[] {
  if (!raw) return [];
  const compact = normalizeOcrText(raw).replace(/\s+/g, '');
  return rows.filter((forms) => forms.some((f) => compact.includes(f))).map((forms) => forms[0]);
}

const KM = /(?<![0-9.])([0-9]{1,2}(?:\.[0-9]{1,2})?)\s*(?:公里|km)/i;

/** 第一個「x.x 公里 / km」，0~99；沒有 → null */
export function extractKm(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = KM.exec(normalizeOcrText(raw));
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= 0 && v < 100 ? v : null;
}

/** 依命中的關鍵字分類畫面（優先序由上到下） */
export function classifyScreen(accept: boolean, hits: readonly string[]): ScreenKind {
  const has = (...names: string[]) => names.some((n) => hits.includes(n));
  if (accept) return 'newOrder';
  if (has('訂單詳情')) return 'detail';
  if (has('前往送餐', '已取餐', '完成訂單')) return 'delivering';
  if (has('前往取餐', '抵達餐廳', '確認取餐')) return 'pickup';
  if (has('上線中', '休息中')) return 'idle';
  return hits.length ? 'other' : 'none';
}

export type ScreenSummary = {
  accept: boolean;
  minutes: number | null;
  amount: number | null;
  km: number | null;
  kw: string[];
  screen: ScreenKind;
};

export type ScreenRules = {
  picker: PickerConfig;
  acceptPattern: string;
  keywords: readonly (readonly string[])[];
};
export const DEFAULT_SCREEN_RULES: ScreenRules = { picker: DEFAULT_PICKER, acceptPattern: DEFAULT_ACCEPT_PATTERN, keywords: UI_KEYWORDS };

/** OCR 文字 → 結構化摘要（Swift 版 ScreenInfo.analyze）。minutes 只在有接單鈕時才挑（同 OrderDetector.detect）。
 *  v0.6：規則可用遠端設定覆寫（picker / detector.acceptPattern / telemetry.keywords） */
export function summarizeScreen(raw: string | null | undefined, rules: ScreenRules = DEFAULT_SCREEN_RULES): ScreenSummary {
  const accept = hasAcceptButton(raw, rules.acceptPattern);
  const kw = matchKeywords(raw, rules.keywords);
  return {
    accept,
    minutes: accept ? pickMinutes(raw, rules.picker) : null,
    amount: pickAmount(raw, rules.picker),
    km: extractKm(raw),
    kw,
    screen: classifyScreen(accept, kw),
  };
}

/** 新單的辨識鍵：分鐘數＋金額取整（同一組在 90 秒內不重複觸發） */
export function orderKey(minutes: number, amount: number | null | undefined): string {
  return `${minutes}/${amountKey(amount)}`;
}
