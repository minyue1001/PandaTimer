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
  // v0.7 接單/未接判定用（offer.acceptedKeywords / rejectedKeywords 的預設詞；回報只送命中哪些詞）
  ['已拒絕', '已拒绝'],
  ['訂單已取消', '订单已取消'],
  ['逾時', '逾时'],
  ['已過期', '已过期'],
  ['已抵達', '已抵达'],
  ['抵達店家', '抵达店家'],
  ['聯絡店家', '联络店家', '联系店家'],
  ['取餐'],
  // v0.7 自動送達（delivery.completedKeywords 的預設詞；「完成訂單」已在上面）
  ['訂單已完成', '订单已完成'],
  ['已送達', '已送达'],
  ['送達完成', '送达完成'],
  ['確認送達', '确认送达'],
  ['完成送達', '完成送达'],
  // v0.8 首日實測畫面（夾單邀請、接單後、取餐/送達確認、送達後彈窗）
  ['夾單', '夹单'],
  ['訂單完成', '订单完成'],
  ['確認已送達', '确认已送达'],
  ['確認已取餐', '确认已取餐'],
  ['是否已取餐'],
  ['是否已送達', '是否已送达'],
  ['pickedup', 'Pickedup', 'PICKEDUP'],
  ['即將抵達', '即将抵达'],
  ['上傳照片', '上传照片'],
  ['無法聯繫', '无法联系', '無法聯絡'],
  ['筆訂單', '笔订单'],
  ['即將準備完成', '即将准备完成'],
  ['取餐體驗', '取餐体验'],
  ['每單收入', '每单收入'],
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
/** OCR 可能把小數點辨成全形句點/中點/逗號（數字之間才換） */
const KM_DOTS = /(?<=[0-9])\s*[．。·•∙・‧,，]\s*(?=[0-9])/g;

/**
 * 第一個「x.x 公里 / km」，0~99；沒有 → null。
 * v0.7 實機：「6.7公里」回報成 67——縮圖後小數點太小被 OCR 吃掉。補救：
 *   ① 數字間的全形句點/中點/逗號當小數點；② 兩位數整數且大於預估分鐘數（給了 minutes 時）→ 不合理（時速 >60），
 *   當作漏了小數點（67 → 6.7）。12 公里/27 分鐘 合理不動。
 */
export function extractKm(raw: string | null | undefined, minutes?: number | null): number | null {
  if (!raw) return null;
  const m = KM.exec(normalizeOcrText(raw).replace(KM_DOTS, '.'));
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (!(v >= 0 && v < 100)) return null;
  if (!m[1].includes('.') && v >= 10 && minutes != null && minutes > 0 && v > minutes) v = v / 10;
  return v;
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
  /** v0.7：邀請畫面消失後判斷「接了沒」——命中 offer.acceptedKeywords / rejectedKeywords（正則，比對去空白後的文字） */
  offerAccepted: boolean;
  offerRejected: boolean;
  /** 命中的那段文字裡含哪些白名單詞（正式名稱）；不在白名單的命中只回報 offerAccepted/Rejected，不回報文字 */
  offerHit: string[];
  /** v0.7 自動送達：命中 delivery.completedKeywords 或 finalKeywords（有接單鈕的邀請畫面不算） */
  delivered: boolean;
  deliveredHit: string[];
  /** v0.8：命中 delivery.finalKeywords（「訂單完成」彈窗＝最可信的送達時間；只看到「確認已送達」對話框時先待定） */
  deliveredFinal: boolean;
  /** v0.8：邀請畫面上有「夾單」（offer.stackedKeywords） */
  stacked: boolean;
  /** v1.2：去掉常駐字（offer.weakAcceptedKeywords：筆訂單/取餐體驗）後仍命中 acceptedKeywords＝強證據 */
  acceptStrong: boolean;
  /** v1.2：命中常駐字（送單中畫面本來就一直在的「N筆訂單」「取餐體驗」） */
  acceptWeak: boolean;
  /** v1.2：「N筆訂單」的 N（1~9；沒讀到數字 → null） */
  orders: number | null;
  /** v1.2：畫面有「疊單」字樣 */
  stackScreen: boolean;
  /** v1.2：「送餐資訊」出現次數（offer.bundleKeywords；邀請畫面 ≥2＝組合單） */
  bundle: number;
  /** v1.2：邀請金額下方「包含額外 N $ 元」＝小費（整數元 1~2000；沒有 → null） */
  tip: number | null;
};

// v0.7 接單後/未接畫面的預設關鍵字（v0.8 加入首日實測接單後畫面：「預計7分鐘後抵達店家・1筆訂單」「再 8 分鐘即將準備完成」「取餐體驗如何呢?」；
//   調整改 server/config.json 的 offer.acceptedKeywords / rejectedKeywords，不用重裝）。
//   與 targets/broadcast/OfferTracker.swift 的 OfferSettings 預設一致（test 比對）。
export const DEFAULT_ACCEPTED_KEYWORDS =
  '前往取餐|抵達(?:店家|餐廳)|抵达(?:店家|餐厅)|確認取餐|确认取餐|已抵達|已抵达|取餐|導航|导航|訂單詳情|订单详情|聯絡店家|联络店家|联系店家|即將準備完成|即将准备完成|準備完成|准备完成|筆訂單|笔订单|取餐體驗|取餐体验';
export const DEFAULT_REJECTED_KEYWORDS = '已拒絕|已拒绝|訂單已取消|订单已取消|逾時|逾时|已過期|已过期|上線中|上线中';
// v0.7 自動送達畫面；v0.8 首日實測：送達確認對話框「…是否已送達?／確認已送達」、送達後彈窗「訂單完成」
export const DEFAULT_COMPLETED_KEYWORDS =
  '訂單完成|订单完成|完成訂單|完成订单|訂單已完成|订单已完成|已送達|已送达|送達完成|送达完成|確認送達|确认送达|完成送達|完成送达';
/** v0.8 優先：看到就以該時間結單（其他 completedKeywords 命中先待定 delivery.pendingSec 秒等它出現） */
export const DEFAULT_FINAL_KEYWORDS = '訂單完成|订单完成|訂單已完成|订单已完成';
/** v0.8 夾單邀請（上方小字「夾單訂單依系統顯示金額為主」） */
export const DEFAULT_STACKED_KEYWORDS = '夾單|夹单';
/** v1.2 送單中畫面常駐、不能單獨當接單證據的字（11/14 實機：送前一張時沒接新邀請，畫面一直有「1筆訂單」「取餐體驗」→ 被判接單）。
 *  先從文字中去掉它們再比對 acceptedKeywords（「取餐體驗」裡的「取餐」一起去掉）。 */
export const DEFAULT_WEAK_ACCEPTED_KEYWORDS = '筆訂單|笔订单|取餐體驗|取餐体验';
/** v1.2 組合單：邀請畫面每位客人一個「送餐資訊」區塊 */
export const DEFAULT_BUNDLE_KEYWORDS = '送餐資訊|送餐资讯|送餐資讯|送餐资訊';

/** v1.2「包含額外 30.00 $ 元」（愛心圖示）＝小費：去空白後比對，金額取整數元 */
const TIP_RX = /包含[額额]外(?:NT)?[$＄]?([0-9]{1,4}(?:[.．][0-9]{1,2})?)/;
/** v1.2「預計7分鐘後抵達店家・2筆訂單」→ 2（數字緊接「筆訂單」） */
const ORDERS_RX = /([1-9])(?:筆|笔)(?:訂單|订单)/;
const STACK_SCREEN_RX = /疊單|叠单/;

/** 去空白文字 → 小費整數元（1~2000）；沒有/不合理 → null */
export function extractTip(compact: string): number | null {
  const m = TIP_RX.exec(compact);
  if (!m) return null;
  const v = Math.round(parseFloat(m[1].replace('．', '.')));
  return Number.isFinite(v) && v >= 1 && v <= 2000 ? v : null;
}

/** 去空白文字 → 「N筆訂單」的 N；沒有 → null */
export function extractOrderCount(compact: string): number | null {
  const m = ORDERS_RX.exec(compact);
  return m ? Number(m[1]) : null;
}

/** pattern 在去空白文字裡（不重疊）出現幾次；編不過 → 用 fallback；空字串命中不算 */
function countMatches(compact: string, pattern: string | undefined, fallback: string): number {
  let r: RegExp;
  try {
    r = new RegExp(pattern ?? fallback, 'g');
  } catch {
    r = new RegExp(fallback, 'g');
  }
  let n = 0;
  for (const m of compact.matchAll(r)) if (m[0].length > 0) n++;
  return n;
}

/** 常駐字換成分隔符（不是空字串：避免前後兩段黏成假命中） */
function stripWeak(compact: string, pattern: string | undefined): string {
  let r: RegExp;
  try {
    r = new RegExp(pattern ?? DEFAULT_WEAK_ACCEPTED_KEYWORDS, 'g');
  } catch {
    r = new RegExp(DEFAULT_WEAK_ACCEPTED_KEYWORDS, 'g');
  }
  return compact.replace(r, (m) => (m.length ? '|' : m));
}

export type ScreenRules = {
  picker: PickerConfig;
  acceptPattern: string;
  keywords: readonly (readonly string[])[];
  acceptedKeywords?: string;
  rejectedKeywords?: string;
  completedKeywords?: string;
  finalKeywords?: string;
  stackedKeywords?: string;
  weakAcceptedKeywords?: string;
  bundleKeywords?: string;
};
export const DEFAULT_SCREEN_RULES: ScreenRules = {
  picker: DEFAULT_PICKER,
  acceptPattern: DEFAULT_ACCEPT_PATTERN,
  keywords: UI_KEYWORDS,
  acceptedKeywords: DEFAULT_ACCEPTED_KEYWORDS,
  rejectedKeywords: DEFAULT_REJECTED_KEYWORDS,
  completedKeywords: DEFAULT_COMPLETED_KEYWORDS,
  finalKeywords: DEFAULT_FINAL_KEYWORDS,
  stackedKeywords: DEFAULT_STACKED_KEYWORDS,
  weakAcceptedKeywords: DEFAULT_WEAK_ACCEPTED_KEYWORDS,
  bundleKeywords: DEFAULT_BUNDLE_KEYWORDS,
};

const offerRx = new Map<string, RegExp | null>();
function compileOffer(pattern: string): RegExp | null {
  if (!offerRx.has(pattern)) {
    let r: RegExp | null = null;
    try {
      r = new RegExp(pattern, '');
    } catch {
      r = null;
    }
    offerRx.set(pattern, r);
  }
  return offerRx.get(pattern) ?? null;
}

/** 去空白文字裡第一段命中 pattern 的字（編不過 → 用 fallback；空字串命中當沒命中） */
function firstOfferMatch(compact: string, pattern: string | undefined, fallback: string): string | null {
  const r = compileOffer(pattern ?? fallback) ?? compileOffer(fallback);
  const m = r?.exec(compact);
  return m && m[0].length > 0 ? m[0] : null;
}

/** OCR 文字 → 結構化摘要（Swift 版 ScreenInfo.analyze）。minutes 只在有接單鈕時才挑（同 OrderDetector.detect）。
 *  v0.6：規則可用遠端設定覆寫（picker / detector.acceptPattern / telemetry.keywords） */
export function summarizeScreen(raw: string | null | undefined, rules: ScreenRules = DEFAULT_SCREEN_RULES): ScreenSummary {
  const accept = hasAcceptButton(raw, rules.acceptPattern);
  const kw = matchKeywords(raw, rules.keywords);
  const compact = raw ? normalizeOcrText(raw).replace(/\s+/g, '') : '';
  const acc = compact ? firstOfferMatch(compact, rules.acceptedKeywords, DEFAULT_ACCEPTED_KEYWORDS) : null;
  const rej = compact ? firstOfferMatch(compact, rules.rejectedKeywords, DEFAULT_REJECTED_KEYWORDS) : null;
  const hit = [acc, rej].filter((x): x is string => x != null).join('|'); // 分隔符不是空白：避免兩段黏在一起湊出假命中
  const finalHit = compact && !accept ? firstOfferMatch(compact, rules.finalKeywords, DEFAULT_FINAL_KEYWORDS) : null;
  const done = compact && !accept ? (firstOfferMatch(compact, rules.completedKeywords, DEFAULT_COMPLETED_KEYWORDS) ?? finalHit) : null;
  const stacked = compact ? firstOfferMatch(compact, rules.stackedKeywords, DEFAULT_STACKED_KEYWORDS) != null : false;
  const minutes = accept ? pickMinutes(raw, rules.picker) : null;
  const weak = compact && acc ? firstOfferMatch(compact, rules.weakAcceptedKeywords, DEFAULT_WEAK_ACCEPTED_KEYWORDS) : null;
  const strong = acc && weak ? firstOfferMatch(stripWeak(compact, rules.weakAcceptedKeywords), rules.acceptedKeywords, DEFAULT_ACCEPTED_KEYWORDS) : acc;
  return {
    accept,
    minutes,
    amount: pickAmount(raw, rules.picker),
    km: extractKm(raw, minutes),
    kw,
    screen: classifyScreen(accept, kw),
    offerAccepted: acc != null,
    offerRejected: rej != null,
    offerHit: hit ? matchKeywords(hit, rules.keywords) : [],
    delivered: done != null,
    deliveredHit: done ? matchKeywords(done, rules.keywords) : [],
    deliveredFinal: finalHit != null,
    stacked,
    acceptStrong: strong != null,
    acceptWeak: weak != null,
    orders: compact ? extractOrderCount(compact) : null,
    stackScreen: compact ? STACK_SCREEN_RX.test(compact) : false,
    bundle: compact ? countMatches(compact, rules.bundleKeywords, DEFAULT_BUNDLE_KEYWORDS) : 0,
    tip: compact ? extractTip(compact) : null,
  };
}

/** 新單的辨識鍵：分鐘數＋金額取整（同一組在 90 秒內不重複觸發） */
export function orderKey(minutes: number, amount: number | null | undefined): string {
  return `${minutes}/${amountKey(amount)}`;
}
