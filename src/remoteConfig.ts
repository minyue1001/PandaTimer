// v0.6 遠端設定（GET /api/config）：原生改動不能 OTA → extension/原生會想調的參數都由伺服器下發，改 server/config.json
// 跑 scripts/push-config.sh 即可，不用重裝 App。
// 這份是**規則的 TS 版**（測試替身＋push-config.sh 上傳前的嚴格驗證）：欄位缺漏或不合法 → 用預設值（並列出 problem）。
// ⚠️ 預設值與 server/config.default.json、Swift（MinutePicker.swift 的 PickerConfig、SampleHandler.swift 的
//    DetectorSettings、RemoteConfig.swift）一致；test/remoteConfig.test.mjs 比對。
import { DEFAULT_ACCEPT_PATTERN, DEFAULT_PICKER, type PickerConfig } from './ocrPick.ts';
import { UI_KEYWORDS } from './screenInfo.ts';
import { DEFAULT_OFFER, type OfferSettings } from './offerTracker.ts';
import { DEFAULT_STATS, type StatsParams } from './stats.ts';
import { DEFAULT_DELIVERY, type DeliverySettings } from './deliveryDetector.ts';

/** v0.7 extension OCR 記憶體保護 */
export type OcrSettings = { memSkipMB: number; memHighMB: number };
export const DEFAULT_OCR: Readonly<OcrSettings> = Object.freeze({ memSkipMB: 38, memHighMB: 44 });

export type DetectorSettings = {
  acceptPattern: string;
  dedupeSeconds: number;
  goneAfterMisses: number;
  ocrIntervalSeconds: number;
  idleOcrIntervalSeconds: number;
  idleAfterMisses: number;
  forceOcrSeconds: number;
  bottomFraction: number;
  maxLongEdge: number;
  minimumTextHeight: number;
  sameFrameMaxBits: number;
  heartbeatSeconds: number;
  memoryAlertMB: number;
  configRefreshSeconds: number;
};

export type TelemetrySettings = { keywords: string[][]; flushSeconds: number; batchSize: number };
export type AppSettings = { beatTimeoutSeconds: number };

export type RemoteConfig = {
  version: string;
  picker: PickerConfig;
  detector: DetectorSettings;
  telemetry: TelemetrySettings;
  app: AppSettings;
  /** v0.7 接單判定（OfferTracker）；v0.6 App 不認得這個區塊，忽略即可 */
  offer: OfferSettings;
  /** v0.7 統計算法參數（JS 讀；彈性線倍數、單筆超時比例上限） */
  stats: StatsParams;
  /** v0.7 自動送達（extension 看完成畫面、App 挑單） */
  delivery: DeliverySettings;
  /** v0.7 extension OCR 記憶體保護：目前 > memSkipMB 跳過該幀；OCR 中量到 > memHighMB → 之後 120 秒只認大字 */
  ocr: OcrSettings;
};

export const DEFAULT_DETECTOR: Readonly<DetectorSettings> = Object.freeze({
  acceptPattern: DEFAULT_ACCEPT_PATTERN,
  dedupeSeconds: 90,
  goneAfterMisses: 2,
  ocrIntervalSeconds: 1.5,
  idleOcrIntervalSeconds: 3,
  idleAfterMisses: 3,
  forceOcrSeconds: 10,
  bottomFraction: 0.5,
  maxLongEdge: 640,
  minimumTextHeight: 0.02,
  sameFrameMaxBits: 40,
  heartbeatSeconds: 60,
  memoryAlertMB: 40,
  configRefreshSeconds: 600,
});

export const DEFAULT_CONFIG: Readonly<RemoteConfig> = Object.freeze({
  version: 'default',
  picker: { ...DEFAULT_PICKER, keywords: [...DEFAULT_PICKER.keywords] },
  detector: { ...DEFAULT_DETECTOR },
  telemetry: { keywords: UI_KEYWORDS.map((r) => [...r]), flushSeconds: 30, batchSize: 10 },
  app: { beatTimeoutSeconds: 150 },
  offer: { ...DEFAULT_OFFER },
  stats: { ...DEFAULT_STATS },
  delivery: { ...DEFAULT_DELIVERY },
  ocr: { ...DEFAULT_OCR },
});

/** 數值欄位的合法範圍（[min, max, 是否整數]）；Swift 端用同一組範圍 */
export const RANGES: Record<string, [number, number, boolean]> = {
  'picker.minMinutes': [1, 90, true],
  'picker.maxMinutes': [1, 90, true], // App 只註冊 1~90 分的訊號名稱
  'picker.minAmount': [0, 10000, false],
  'picker.maxAmount': [1, 10000, false],
  'picker.ratePerMinute': [0.1, 100, false],
  'picker.minFare': [0, 1000, false],
  'picker.shortOrderMinutes': [1, 90, true],
  'detector.dedupeSeconds': [0, 3600, false],
  'detector.goneAfterMisses': [1, 20, true],
  'detector.ocrIntervalSeconds': [0.5, 10, false],
  'detector.idleOcrIntervalSeconds': [0.5, 30, false],
  'detector.idleAfterMisses': [1, 100, true],
  'detector.forceOcrSeconds': [1, 120, false],
  'detector.bottomFraction': [0.2, 1, false],
  'detector.maxLongEdge': [320, 1600, true],
  'detector.minimumTextHeight': [0, 0.2, false],
  'detector.sameFrameMaxBits': [0, 1000, true],
  'detector.heartbeatSeconds': [15, 600, true],
  'detector.memoryAlertMB': [10, 100, false],
  'detector.configRefreshSeconds': [60, 86400, true],
  'telemetry.flushSeconds': [5, 600, true],
  'telemetry.batchSize': [1, 50, true],
  'app.beatTimeoutSeconds': [60, 1800, true],
  'offer.goneAfterMisses': [1, 20, true],
  'offer.decideWindowSec': [5, 60, true], // 延遲訊號只編 0~60 秒
  'stats.graceFactor': [1, 2, false],
  'stats.overrunCap': [0.1, 10, false],
  'delivery.minOrderAgeSec': [0, 1800, true],
  'ocr.memSkipMB': [20, 60, false],
  'ocr.memHighMB': [25, 80, false],
};

/** 正則欄位：要編得過，且（需要的）至少 1 個捕捉群組 */
const REGEX_FIELDS: Record<string, { flags: string; groups: number }> = {
  'picker.minutePattern': { flags: 'gi', groups: 1 },
  'picker.amountAfterPattern': { flags: 'i', groups: 1 },
  'picker.amountBeforePattern': { flags: 'i', groups: 1 },
  'detector.acceptPattern': { flags: '', groups: 0 },
  'offer.acceptedKeywords': { flags: '', groups: 0 },
  'offer.rejectedKeywords': { flags: '', groups: 0 },
  'delivery.completedKeywords': { flags: '', groups: 0 },
};

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

function captureGroups(pattern: string, flags: string): number | null {
  try {
    new RegExp(pattern, flags);
    return (new RegExp(`${pattern}|`, flags).exec('') ?? []).length - 1;
  } catch {
    return null;
  }
}

/** 遠端 JSON（不可信）→ 完整設定；每個缺漏/不合法的欄位用預設值並記一條 problem */
export function validateConfig(raw: unknown): { config: RemoteConfig; problems: string[] } {
  const problems: string[] = [];
  const src = isObj(raw) ? raw : {};
  if (!isObj(raw)) problems.push('整份設定不是 JSON 物件 → 全用預設');
  const out: RemoteConfig = structuredClone(DEFAULT_CONFIG) as RemoteConfig;
  if (typeof src.version === 'string' && src.version.length > 0 && src.version.length <= 40) out.version = src.version;
  else problems.push('version 缺漏或不是 1~40 字的字串');

  for (const section of ['picker', 'detector', 'telemetry', 'app', 'offer', 'stats', 'delivery', 'ocr'] as const) {
    const s = src[section];
    if (s !== undefined && !isObj(s)) problems.push(`${section} 不是物件`);
    const sec = isObj(s) ? s : {};
    const target = out[section] as Record<string, unknown>;
    for (const key of Object.keys(target)) {
      const path = `${section}.${key}`;
      if (!(key in sec)) {
        problems.push(`${path} 缺漏 → 用預設`);
        continue;
      }
      const v = sec[key];
      const range = RANGES[path];
      const regex = REGEX_FIELDS[path];
      if (range) {
        const [min, max, int] = range;
        if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))) target[key] = v;
        else problems.push(`${path}=${JSON.stringify(v)} 不在 ${min}~${max}${int ? '（整數）' : ''} → 用預設`);
      } else if (regex) {
        const g = typeof v === 'string' && v.length > 0 && v.length <= 300 ? captureGroups(v, regex.flags) : null;
        // 能命中空字串的（例如 'a|' 或 '.*'）一律不收：每個畫面都會「命中」
        if (g != null && g >= regex.groups && !((path.startsWith('offer.') || path.startsWith('delivery.')) && new RegExp(v as string, regex.flags).test(''))) target[key] = v;
        else problems.push(`${path} 正則編不過或捕捉群組不足 → 用預設`);
      } else if (path === 'delivery.enabled') {
        if (typeof v === 'boolean') target[key] = v;
        else problems.push(`${path} 要是 true/false → 用預設`);
      } else if (path === 'offer.ambiguousAs') {
        if (v === 'accept' || v === 'reject') target[key] = v;
        else problems.push(`${path} 要是 "accept" 或 "reject" → 用預設`);
      } else if (path === 'picker.keywords') {
        if (Array.isArray(v) && v.length >= 1 && v.length <= 40 && v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 10)) target[key] = [...v];
        else problems.push(`${path} 要是 1~40 個 1~10 字的字串 → 用預設`);
      } else if (path === 'telemetry.keywords') {
        const ok = Array.isArray(v) && v.length >= 1 && v.length <= 40 &&
          v.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 6 &&
            row.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 12));
        if (ok) target[key] = (v as string[][]).map((r) => [...r]);
        else problems.push(`${path} 要是 [[正式名稱, 異體...], ...]（每字 ≤12）→ 用預設`);
      }
    }
  }
  // 交叉檢查
  if (out.picker.minMinutes > out.picker.maxMinutes) {
    problems.push('picker.minMinutes > maxMinutes → 兩個都用預設');
    out.picker.minMinutes = DEFAULT_PICKER.minMinutes;
    out.picker.maxMinutes = DEFAULT_PICKER.maxMinutes;
  }
  if (out.picker.minAmount >= out.picker.maxAmount) {
    problems.push('picker.minAmount >= maxAmount → 兩個都用預設');
    out.picker.minAmount = DEFAULT_PICKER.minAmount;
    out.picker.maxAmount = DEFAULT_PICKER.maxAmount;
  }
  return { config: out, problems };
}
