// v0.6 遠端設定（GET /api/config）：原生改動不能 OTA → extension/原生會想調的參數都由伺服器下發，改 server/config.json
// 跑 scripts/push-config.sh 即可，不用重裝 App。
// 這份是**規則的 TS 版**（測試替身＋push-config.sh 上傳前的嚴格驗證）：欄位缺漏或不合法 → 用預設值（並列出 problem）。
// ⚠️ 預設值與 server/config.default.json、Swift（MinutePicker.swift 的 PickerConfig、SampleHandler.swift 的
//    DetectorSettings、RemoteConfig.swift）一致；test/remoteConfig.test.mjs 比對。
import { DEFAULT_ACCEPT_PATTERN, DEFAULT_PICKER, type PickerConfig } from './ocrPick.ts';
import { UI_KEYWORDS } from './screenInfo.ts';
import { DEFAULT_OFFER, type OfferSettings } from './offerTracker.ts';
import { DEFAULT_STATS, type StatsParams } from './stats.ts';
import { DEFAULT_PAY, type PayParams } from './earnings.ts';
import { DEFAULT_DELIVERY, type DeliverySettings } from './deliveryDetector.ts';
import { DEFAULT_GREEN, type GreenTriggerSettings } from './frameTrigger.ts';
import { DEFAULT_AWAY, DEFAULT_POWER, type AwaySettings, type PowerSettings } from './powerSaver.ts';

/** v0.7 extension OCR 記憶體保護；v0.8 每 rebuildEvery 次 OCR 重建 VNRecognizeTextRequest、englishToo=false 只用 zh-Hant */
export type OcrSettings = { memSkipMB: number; memHighMB: number; rebuildEvery: number; englishToo: boolean };
export const DEFAULT_OCR: Readonly<OcrSettings> = Object.freeze({ memSkipMB: 36, memHighMB: 44, rebuildEvery: 30, englishToo: false });

/** v0.8 telemetry.keywords 最多幾列（v0.7 是 40；超過時 v0.7 App 會整份改用內建白名單） */
export const MAX_KEYWORD_ROWS = 60;

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
  /** v0.8 偵測更快（src/frameTrigger.ts） */
  fastOcrIntervalSeconds: number;
  changeMinBits: number;
  changeMinGapSeconds: number;
  probeIntervalSeconds: number;
  greenTrigger: GreenTriggerSettings;
};

export type TelemetrySettings = { keywords: string[][]; flushSeconds: number; batchSize: number };
/** v0.9 cardRefreshSeconds：心跳的動態島 update 只在診斷字有實質變化、或距上次 update 滿這麼多秒才做 */
export type AppSettings = { beatTimeoutSeconds: number; cardRefreshSeconds: number };

/** v0.9 App 定位保活精度（App 只需要不被暫停、不需要精準位置；低精度可能被 iOS 暫停 → 預設維持 hundred，看 telemetry 再切） */
export type LocationAccuracy = 'hundred' | 'kilometer' | 'threeKilometers';
export const LOCATION_ACCURACIES: readonly LocationAccuracy[] = ['hundred', 'kilometer', 'threeKilometers'];
/** distanceFilterM 0＝kCLDistanceFilterNone */
export type KeepAliveSettings = { locationAccuracy: LocationAccuracy; distanceFilterM: number };
export const DEFAULT_KEEP_ALIVE: Readonly<KeepAliveSettings> = Object.freeze({ locationAccuracy: 'hundred', distanceFilterM: 50 });

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
  /** v0.8 收入（含補錢）算法參數（JS 讀） */
  pay: PayParams;
  /** v0.7 自動送達（extension 看完成畫面、App 挑單） */
  delivery: DeliverySettings;
  /** v0.7 extension OCR 記憶體保護：目前 > memSkipMB 跳過該幀；OCR 中量到 > memHighMB → 之後 120 秒只認大字 */
  ocr: OcrSettings;
  /** v0.9 省電：pandarider 不在畫面上（extension）、低電量/過熱倍率（extension＋App 偵測卡「省電中」）、定位保活精度（App） */
  away: AwaySettings;
  power: PowerSettings;
  keepAlive: KeepAliveSettings;
};

export const DEFAULT_DETECTOR: Readonly<DetectorSettings> = Object.freeze({
  acceptPattern: DEFAULT_ACCEPT_PATTERN,
  dedupeSeconds: 90,
  goneAfterMisses: 2,
  ocrIntervalSeconds: 1.5,
  idleOcrIntervalSeconds: 1.5,
  idleAfterMisses: 3,
  forceOcrSeconds: 10,
  bottomFraction: 0.5,
  maxLongEdge: 640,
  minimumTextHeight: 0.02,
  sameFrameMaxBits: 40,
  heartbeatSeconds: 60,
  memoryAlertMB: 40,
  configRefreshSeconds: 600,
  fastOcrIntervalSeconds: 0.6,
  changeMinBits: 120,
  changeMinGapSeconds: 0.6,
  probeIntervalSeconds: 0.2,
  greenTrigger: { ...DEFAULT_GREEN },
});

export const DEFAULT_CONFIG: Readonly<RemoteConfig> = Object.freeze({
  version: 'default',
  picker: { ...DEFAULT_PICKER, keywords: [...DEFAULT_PICKER.keywords] },
  detector: { ...DEFAULT_DETECTOR, greenTrigger: { ...DEFAULT_GREEN } },
  telemetry: { keywords: UI_KEYWORDS.map((r) => [...r]), flushSeconds: 60, batchSize: 10 },
  app: { beatTimeoutSeconds: 150, cardRefreshSeconds: 300 },
  offer: { ...DEFAULT_OFFER },
  stats: { ...DEFAULT_STATS },
  pay: { ...DEFAULT_PAY },
  delivery: { ...DEFAULT_DELIVERY },
  ocr: { ...DEFAULT_OCR },
  away: { ...DEFAULT_AWAY },
  power: { ...DEFAULT_POWER },
  keepAlive: { ...DEFAULT_KEEP_ALIVE },
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
  'detector.fastOcrIntervalSeconds': [0.3, 10, false],
  'detector.changeMinBits': [1, 4096, true],
  'detector.changeMinGapSeconds': [0.2, 10, false],
  'detector.probeIntervalSeconds': [0.05, 2, false],
  'detector.greenTrigger.minRatio': [0.0001, 0.5, false],
  'detector.greenTrigger.yMin': [0, 255, true],
  'detector.greenTrigger.cbMax': [0, 255, true],
  'detector.greenTrigger.crMax': [0, 255, true],
  'detector.greenTrigger.holdSec': [1, 120, false],
  'detector.greenTrigger.regionFraction': [0.2, 1, false],
  'telemetry.flushSeconds': [5, 600, true],
  'telemetry.batchSize': [1, 50, true],
  'app.beatTimeoutSeconds': [60, 1800, true],
  'app.cardRefreshSeconds': [60, 1800, true],
  'offer.goneAfterMisses': [1, 20, true],
  'offer.decideWindowSec': [5, 60, true], // 延遲訊號只編 0~60 秒
  'stats.graceFactor': [1, 2, false],
  'stats.overrunCap': [0.1, 10, false],
  'pay.ratePerMinute': [0.1, 100, false],
  'pay.minFare': [0, 1000, false],
  'delivery.minOrderAgeSec': [0, 1800, true],
  'delivery.pendingSec': [0, 60, true], // 延遲訊號只編 0~60 秒
  'ocr.memSkipMB': [20, 60, false],
  'ocr.memHighMB': [25, 80, false],
  'ocr.rebuildEvery': [1, 1000, true],
  'away.afterMisses': [1, 100, true],
  'away.intervalSec': [1, 60, false],
  'away.probeIntervalSec': [0.05, 2, false],
  'power.saverFactor': [1, 5, false],
  'power.thermalLevel': [1, 4, true], // 4＝不看溫度
  'keepAlive.distanceFilterM': [0, 5000, true], // 0＝kCLDistanceFilterNone
};

/** 布林欄位 */
const BOOL_FIELDS = new Set([
  'delivery.enabled', 'pay.assumeStarredLate', 'ocr.englishToo', 'detector.greenTrigger.enabled', 'away.enabled', 'power.onLowPower',
]);

/** 正則欄位：要編得過，且（需要的）至少 1 個捕捉群組 */
const REGEX_FIELDS: Record<string, { flags: string; groups: number }> = {
  'picker.minutePattern': { flags: 'gi', groups: 1 },
  'picker.amountAfterPattern': { flags: 'i', groups: 1 },
  'picker.amountBeforePattern': { flags: 'i', groups: 1 },
  'detector.acceptPattern': { flags: '', groups: 0 },
  'offer.acceptedKeywords': { flags: '', groups: 0 },
  'offer.rejectedKeywords': { flags: '', groups: 0 },
  'offer.stackedKeywords': { flags: '', groups: 0 },
  'delivery.completedKeywords': { flags: '', groups: 0 },
  'delivery.finalKeywords': { flags: '', groups: 0 },
  'away.keywords': { flags: '', groups: 0 },
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

  for (const section of ['picker', 'detector', 'telemetry', 'app', 'offer', 'stats', 'pay', 'delivery', 'ocr', 'away', 'power', 'keepAlive'] as const) {
    const s = src[section];
    if (s !== undefined && !isObj(s)) problems.push(`${section} 不是物件`);
    const sec = isObj(s) ? s : {};
    checkFields(section, sec, out[section] as Record<string, unknown>, problems);
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

/** 一個區塊（或巢狀物件，例如 detector.greenTrigger）的欄位逐一驗證；target 先放預設，合法才覆寫 */
function checkFields(prefix: string, sec: Record<string, unknown>, target: Record<string, unknown>, problems: string[]): void {
  for (const key of Object.keys(target)) {
      const path = `${prefix}.${key}`;
      if (!(key in sec)) {
        problems.push(`${path} 缺漏 → 用預設`);
        continue;
      }
      const v = sec[key];
      if (isObj(target[key])) {
        if (isObj(v)) checkFields(path, v, target[key] as Record<string, unknown>, problems);
        else problems.push(`${path} 不是物件 → 用預設`);
        continue;
      }
      const range = RANGES[path];
      const regex = REGEX_FIELDS[path];
      if (range) {
        const [min, max, int] = range;
        if (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!int || Number.isInteger(v))) target[key] = v;
        else problems.push(`${path}=${JSON.stringify(v)} 不在 ${min}~${max}${int ? '（整數）' : ''} → 用預設`);
      } else if (regex) {
        const g = typeof v === 'string' && v.length > 0 && v.length <= 300 ? captureGroups(v, regex.flags) : null;
        // 能命中空字串的（例如 'a|' 或 '.*'）一律不收：每個畫面都會「命中」
        if (g != null && g >= regex.groups && !((path.startsWith('offer.') || path.startsWith('delivery.') || path.startsWith('away.')) && new RegExp(v as string, regex.flags).test(''))) target[key] = v;
        else problems.push(`${path} 正則編不過或捕捉群組不足 → 用預設`);
      } else if (BOOL_FIELDS.has(path)) {
        if (typeof v === 'boolean') target[key] = v;
        else problems.push(`${path} 要是 true/false → 用預設`);
      } else if (path === 'keepAlive.locationAccuracy') {
        if (LOCATION_ACCURACIES.includes(v as LocationAccuracy)) target[key] = v;
        else problems.push(`${path} 要是 ${LOCATION_ACCURACIES.map((x) => `"${x}"`).join('/')} → 用預設`);
      } else if (path === 'offer.ambiguousAs') {
        if (v === 'accept' || v === 'reject') target[key] = v;
        else problems.push(`${path} 要是 "accept" 或 "reject" → 用預設`);
      } else if (path === 'picker.keywords') {
        if (Array.isArray(v) && v.length >= 1 && v.length <= 40 && v.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 10)) target[key] = [...v];
        else problems.push(`${path} 要是 1~40 個 1~10 字的字串 → 用預設`);
      } else if (path === 'telemetry.keywords') {
        const ok = Array.isArray(v) && v.length >= 1 && v.length <= MAX_KEYWORD_ROWS &&
          v.every((row) => Array.isArray(row) && row.length >= 1 && row.length <= 6 &&
            row.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 12));
        if (ok) target[key] = (v as string[][]).map((r) => [...r]);
        else problems.push(`${path} 要是 1~${MAX_KEYWORD_ROWS} 列 [[正式名稱, 異體...], ...]（每字 ≤12）→ 用預設`);
      }
  }
}
