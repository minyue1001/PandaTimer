// v0.8 偵測更快、不漏邀請：extension 每幀的「要不要現在 OCR」規則（純函式；Swift 在 WSL 不能跑，以這份測試為準）。
// ⚠️ 與 targets/broadcast/SampleHandler.swift 的 FrameProbe / GreenEdge / OcrPlanner 同一套規則；改一邊改兩邊。
//
// 首日實測：邀請只在畫面上 1~3 秒（使用者很快按接受），v0.7 閒置 3 秒一次 OCR＋同畫面跳過 → 常常漏。
// v0.8：
//   ① 每 probeIntervalSeconds（0.2）對 ReplayKit 原始幀做「點取樣」：64×64 亮度雜湊＋下方 greenTrigger.regionFraction
//      的 96×160 色彩取樣（YUV 只多讀 CbCr 平面、BGRA 讀同一批點）→ 不建任何圖，額外記憶體只有幾 KB。
//   ② 亮綠色金額觸發：取樣點中「亮綠色」比例 ≥ minRatio → 疑似邀請 → 立刻 OCR（距上次 ≥ changeMinGapSeconds），
//      之後 holdSec 秒維持 fastOcrIntervalSeconds（0.6）。綠色＝BT.601 全幅 YCbCr：Y ≥ yMin、Cb ≤ cbMax、Cr ≤ crMax
//      （暗色主題金額 ≈ RGB(60,220,60) → Y154/Cb75/Cr61；淺色主題綠字 ≈ RGB(0,160,0) → Y94/Cb75/Cr61；
//       黃、青、粉紅、灰都至少有一個色差 >128 → 不算）。邊緣觸發：綠色要先消失（連 2 次取樣沒有）才會再觸發。
//   ③ 畫面變化觸發：與「上次 OCR 的畫面」差 > changeMinBits 位元、且與上一個取樣幾乎相同（已靜止，避免影片/捲動時連續 OCR）
//      → 立刻 OCR（距上次 ≥ changeMinGapSeconds）。
//   ④ 其餘照固定間隔：疑似邀請狀態（綠色 hold 中／OfferTracker 等判定中／上次 OCR 有接單鈕）fastOcrIntervalSeconds，
//      否則 ocrIntervalSeconds，連 idleAfterMisses 次沒接單鈕 idleOcrIntervalSeconds（v0.8 預設 1.5）；
//      到了間隔但畫面跟上次 OCR 幾乎相同（≤ sameFrameMaxBits）→ 跳過，最多 forceOcrSeconds 強制一次。

export type GreenTriggerSettings = {
  enabled: boolean;
  /** 取樣點中亮綠色的最低比例（0.002＝0.2%） */
  minRatio: number;
  yMin: number;
  cbMax: number;
  crMax: number;
  /** 觸發後維持快速 OCR 的秒數 */
  holdSec: number;
  /** 取樣畫面下方多少比例（邀請卡在下 55%） */
  regionFraction: number;
};

export const DEFAULT_GREEN: Readonly<GreenTriggerSettings> = Object.freeze({
  enabled: true,
  minRatio: 0.002,
  yMin: 60,
  cbMax: 110,
  crMax: 110,
  holdSec: 10,
  regionFraction: 0.55,
});

/** 取樣格數（Swift FrameProbe 同值） */
export const GREEN_GRID_W = 96;
export const GREEN_GRID_H = 160;
export const HASH_GRID = 64;
/** 綠色連幾次取樣沒出現才算消失（之後才能再觸發） */
export const GREEN_GONE_AFTER = 2;

/** BT.601 全幅（JPEG）RGB → YCbCr，整數（Swift 版用同一組係數：×1000 定點） */
export function rgbToYCbCr(r: number, g: number, b: number): [number, number, number] {
  const y = (299 * r + 587 * g + 114 * b) / 1000;
  const cb = 128 + (-169 * r - 331 * g + 500 * b) / 1000;
  const cr = 128 + (500 * r - 419 * g - 81 * b) / 1000;
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return [c(y), c(cb), c(cr)];
}

export function isGreenYCbCr(y: number, cb: number, cr: number, s: GreenTriggerSettings = DEFAULT_GREEN): boolean {
  return y >= s.yMin && cb <= s.cbMax && cr <= s.crMax;
}

export function isGreenRGB(r: number, g: number, b: number, s: GreenTriggerSettings = DEFAULT_GREEN): boolean {
  const [y, cb, cr] = rgbToYCbCr(r, g, b);
  return isGreenYCbCr(y, cb, cr, s);
}

/** 取樣統計 → 是否疑似邀請（enabled 且比例 ≥ minRatio） */
export function greenHit(green: number, total: number, s: GreenTriggerSettings = DEFAULT_GREEN): boolean {
  return s.enabled && total > 0 && green / total >= s.minRatio;
}

/** 綠色邊緣觸發（時間：秒）：從沒有變成有 → true；連 GREEN_GONE_AFTER 次取樣沒有才算消失 */
export class GreenEdge {
  private on = false;
  private misses = 0;

  observe(hit: boolean): boolean {
    if (hit) {
      this.misses = 0;
      if (this.on) return false;
      this.on = true;
      return true;
    }
    if (this.on && ++this.misses >= GREEN_GONE_AFTER) {
      this.on = false;
      this.misses = 0;
    }
    return false;
  }
}

/** 汎明距離（雜湊用 bigint 陣列或 0/1 陣列都可；測試用 0/1 陣列） */
export function hamming(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export type ScheduleSettings = {
  ocrIntervalSeconds: number;
  idleOcrIntervalSeconds: number;
  idleAfterMisses: number;
  fastOcrIntervalSeconds: number;
  changeMinBits: number;
  changeMinGapSeconds: number;
  sameFrameMaxBits: number;
  forceOcrSeconds: number;
};

/** 目前的固定間隔：疑似邀請→fast；連續沒接單鈕→idle；否則一般 */
export function chooseInterval(fast: boolean, missStreak: number, s: ScheduleSettings): number {
  if (fast) return s.fastOcrIntervalSeconds;
  return missStreak >= s.idleAfterMisses ? s.idleOcrIntervalSeconds : s.ocrIntervalSeconds;
}

/** 疑似邀請狀態：綠色 hold 中、OfferTracker 有邀請在判定、或上次 OCR 有接單鈕 */
export function isFast(now: number, fastUntil: number | null, offerActive: boolean, lastSawAccept: boolean): boolean {
  return offerActive || lastSawAccept || (fastUntil != null && now < fastUntil);
}

export type OcrWhy = 'first' | 'green' | 'change' | 'interval' | 'force';
export type OcrPlan = { run: true; why: OcrWhy } | { run: false; skip: 'wait' | 'same' };

/** 疑似邀請狀態下，同畫面最多跳過這麼久（秒；一般狀態用 forceOcrSeconds） */
export const FAST_FORCE_SEC = 2;

/**
 * 這個取樣點要不要 OCR（時間：秒）。
 * diffFromOcr＝與上次 OCR 時雜湊的距離（沒有 → null）；diffFromPrev＝與上一個取樣的距離（沒有 → null）；
 * greenPending＝綠色觸發過、還沒 OCR（呼叫端在 OCR 真的跑了才清掉，觸發時剛好太近上次 OCR 也不會漏）。
 */
export function planOcr(input: {
  now: number;
  lastOcrAt: number | null;
  interval: number;
  fast: boolean;
  diffFromOcr: number | null;
  diffFromPrev: number | null;
  greenPending: boolean;
  s: ScheduleSettings;
}): OcrPlan {
  const { now, lastOcrAt, interval, fast, diffFromOcr, diffFromPrev, greenPending, s } = input;
  if (lastOcrAt == null) return { run: true, why: 'first' };
  const since = now - lastOcrAt;
  if (since >= s.changeMinGapSeconds) {
    if (greenPending) return { run: true, why: 'green' };
    const settled = diffFromPrev != null && diffFromPrev <= s.sameFrameMaxBits;
    if (diffFromOcr != null && diffFromOcr > s.changeMinBits && settled) return { run: true, why: 'change' };
  }
  if (since < interval) return { run: false, skip: 'wait' };
  const same = diffFromOcr != null && diffFromOcr <= s.sameFrameMaxBits;
  if (!same) return { run: true, why: 'interval' };
  const force = fast ? Math.min(s.forceOcrSeconds, FAST_FORCE_SEC) : s.forceOcrSeconds;
  return since >= force ? { run: true, why: 'force' } : { run: false, skip: 'same' };
}
