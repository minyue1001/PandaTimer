// v0.9 省電：extension 的辨識頻率自適應（純函式／狀態機；Swift 在 WSL 不能跑，以這份測試為準）。
// ⚠️ 與 targets/broadcast/SampleHandler.swift 的 AwayTracker / PowerTiming、RemoteConfig.swift 的 AwaySettings /
//    PowerSettings / isSaver 同一套規則；改一邊改兩邊（test/powerSaver.test.mjs 比對字串）。
//
// ① away 模式（pandarider 不在畫面上）：連續 away.afterMisses 次 OCR 都沒有 pandarider 特徵詞（away.keywords，比對去空白文字）
//    且沒有接單鈕、OfferTracker 沒在判定 → away：取消「畫面變化觸發」（只留綠色金額觸發）、固定間隔改 away.intervalSec（6 秒）、
//    取樣改 away.probeIntervalSec（0.5 秒）。看到特徵詞／接單鈕或綠色觸發 → 立刻回正常。
//    依據：OCR 只看畫面下半部；pandarider 以外的 App（地圖、LINE…）上看不到邀請卡，只會看到系統橫幅（在上半部，本來就看不到），
//    所以 away 時能抓到的只剩「切回 pandarider 正好跳邀請」——那靠綠色金額觸發（0.5 秒取樣）。
// ② 省電倍率：低電量模式（power.onLowPower）或 thermalState ≥ power.thermalLevel（2＝serious）→ 所有間隔 ×power.saverFactor（1.5）。
import { normalizeOcrText } from './ocrPick.ts';
import type { ScheduleSettings } from './frameTrigger.ts';

export type AwaySettings = {
  enabled: boolean;
  /** 連續幾次 OCR 沒有特徵詞 → away */
  afterMisses: number;
  /** away 時的固定 OCR 間隔（秒；同畫面仍照 forceOcrSeconds 強制） */
  intervalSec: number;
  /** away 時的取樣間隔（秒；正常模式用 detector.probeIntervalSeconds） */
  probeIntervalSec: number;
  /** pandarider 特徵詞（正則，比對去空白文字；不得命中空字串） */
  keywords: string;
};

export const DEFAULT_AWAY_KEYWORDS =
  '上線中|上线中|休息中|抵達|抵达|取餐|送達|送达|每單收入|每单收入|接受訂單|接受订单|訂單|订单|預計|预计|夾單|夹单|導航|导航';

export const DEFAULT_AWAY: Readonly<AwaySettings> = Object.freeze({
  enabled: true,
  afterMisses: 5,
  intervalSec: 6,
  probeIntervalSec: 0.5,
  keywords: DEFAULT_AWAY_KEYWORDS,
});

export type PowerSettings = {
  /** 省電時所有間隔乘上這個倍率（1＝不省電） */
  saverFactor: number;
  /** ProcessInfo.thermalState ≥ 這個值就省電（0 nominal、1 fair、2 serious、3 critical；4＝不看溫度） */
  thermalLevel: number;
  /** 低電量模式就省電 */
  onLowPower: boolean;
};

export const DEFAULT_POWER: Readonly<PowerSettings> = Object.freeze({ saverFactor: 1.5, thermalLevel: 2, onLowPower: true });

/** thermalState → 數字（同 ProcessInfo.ThermalState.rawValue） */
export const THERMAL = Object.freeze({ nominal: 0, fair: 1, serious: 2, critical: 3 });

export function isSaver(lowPower: boolean, thermal: number, p: PowerSettings = DEFAULT_POWER): boolean {
  return (p.onLowPower && lowPower) || thermal >= p.thermalLevel;
}

const rxCache = new Map<string, RegExp | null>();
function compile(pattern: string): RegExp | null {
  if (!rxCache.has(pattern)) {
    let r: RegExp | null = null;
    try {
      r = new RegExp(pattern, '');
    } catch {
      r = null;
    }
    rxCache.set(pattern, r);
  }
  return rxCache.get(pattern) ?? null;
}

/** OCR 文字裡有沒有 pandarider 特徵詞（去空白比對；編不過用預設；空字串命中當沒命中）。有接單鈕一律算有 */
export function pandaPresent(raw: string | null | undefined, accept: boolean, pattern: string = DEFAULT_AWAY_KEYWORDS): boolean {
  if (accept) return true;
  if (!raw) return false;
  const compact = normalizeOcrText(raw).replace(/\s+/g, '');
  if (!compact) return false;
  const r = compile(pattern) ?? compile(DEFAULT_AWAY_KEYWORDS);
  const m = r?.exec(compact);
  return !!m && m[0].length > 0;
}

export type AwayChange = { mode: 'away' | 'normal'; reason: 'noPanda' | 'panda' | 'green' | 'offer' | 'disabled' } | null;

/** away 狀態機（Swift AwayTracker；呼叫端持 lock） */
export class AwayTracker {
  away = false;
  misses = 0;

  /** 每次 OCR 後。panda＝有特徵詞或接單鈕；offerActive＝OfferTracker 有邀請在判定（視同在 pandarider） */
  observeOcr(panda: boolean, offerActive: boolean, s: AwaySettings = DEFAULT_AWAY): AwayChange {
    if (!s.enabled) {
      this.misses = 0;
      if (!this.away) return null;
      this.away = false;
      return { mode: 'normal', reason: 'disabled' };
    }
    if (panda || offerActive) {
      this.misses = 0;
      if (!this.away) return null;
      this.away = false;
      return { mode: 'normal', reason: panda ? 'panda' : 'offer' };
    }
    this.misses += 1;
    if (this.away || this.misses < s.afterMisses) return null;
    this.away = true;
    return { mode: 'away', reason: 'noPanda' };
  }

  /** 綠色金額觸發（疑似邀請）→ 立刻回正常 */
  observeGreen(): AwayChange {
    this.misses = 0;
    if (!this.away) return null;
    this.away = false;
    return { mode: 'normal', reason: 'green' };
  }
}

export type Timing = { s: ScheduleSettings; probeInterval: number; changeEnabled: boolean };

/**
 * 依模式算出這次取樣用的排程參數（Swift PowerTiming.make）：
 * away → 一般/閒置間隔＝away.intervalSec、取樣＝away.probeIntervalSec、不做畫面變化觸發；
 * saver → 所有間隔（取樣、一般、閒置、快速、變化/綠色最小間隔、同畫面強制）× saverFactor。
 */
export function effectiveTiming(
  base: ScheduleSettings,
  probeInterval: number,
  mode: { away: boolean; saver: boolean },
  a: AwaySettings = DEFAULT_AWAY,
  p: PowerSettings = DEFAULT_POWER,
): Timing {
  const f = mode.saver ? p.saverFactor : 1;
  const ocr = mode.away ? a.intervalSec : base.ocrIntervalSeconds;
  const idle = mode.away ? a.intervalSec : base.idleOcrIntervalSeconds;
  const probe = mode.away ? a.probeIntervalSec : probeInterval;
  return {
    s: {
      ...base,
      ocrIntervalSeconds: ocr * f,
      idleOcrIntervalSeconds: idle * f,
      fastOcrIntervalSeconds: base.fastOcrIntervalSeconds * f,
      changeMinGapSeconds: base.changeMinGapSeconds * f,
      forceOcrSeconds: base.forceOcrSeconds * f,
    },
    probeInterval: probe * f,
    changeEnabled: !mode.away,
  };
}
