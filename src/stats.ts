// v0.7（需求 F）：本期統計對齊 foodpanda 報酬單＋目標追蹤（純函式，無副作用，node --test 直接載入）。
//
// 算法（使用者三期報酬單反推的近似；平台實際算法未公開）：
//   彈性線 L＝預估分鐘 × graceFactor（預設 1.05）；準時＝實際 ≤ L；
//   單筆超時比例＝min(overrunCap, max(0, (實際 − L) / L))（上限預設 1）；超時率＝所有單的平均。取消單不計。
//   graceFactor / overrunCap 可由遠端設定 /api/config 的 stats 區塊覆寫（src/remoteConfig.ts 驗證）。
// 報酬週期：每 14 天一期，錨點 2026-09-28（週一）00:00 Asia/Taipei → 9/28、10/12、10/26、11/09、11/23…
//   台灣沒有日光節約，固定 UTC+8，直接用毫秒運算（不依賴裝置時區）。
import type { Order } from './orders';

export type StatsParams = { graceFactor: number; overrunCap: number };
export const DEFAULT_STATS: Readonly<StatsParams> = Object.freeze({ graceFactor: 1.05, overrunCap: 1 });

/** 準時率兩層：目標（onTimeRate，預設 50%）與底線（onTimeFloor，預設 40%）；超時率單一門檻（≤ overrunRate，預設 20%） */
export type Goals = { onTimeRate: number; onTimeFloor: number; overrunRate: number };
export const DEFAULT_GOALS: Readonly<Goals> = Object.freeze({ onTimeRate: 0.5, onTimeFloor: 0.4, overrunRate: 0.2 });
export const GOALS_STORAGE_KEY = 'pandatimer.goals.v1';

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;
export const PERIOD_DAYS = 14;
/** 2026-09-28 00:00 Asia/Taipei（＝2026-09-27 16:00 UTC） */
export const PERIOD_ANCHOR_MS = Date.UTC(2026, 8, 27, 16, 0, 0);

export type Sample = { est: number; act: number };

export function graceLine(est: number, p: StatsParams = DEFAULT_STATS): number {
  return est * p.graceFactor;
}

/** 浮點誤差：16 × 1.05 = 16.8000000001 之類，實際 16.8 要算準時 */
const EPS = 1e-9;

export function isOnTime(s: Sample, p: StatsParams = DEFAULT_STATS): boolean {
  return s.act <= graceLine(s.est, p) + EPS;
}

export function overrunRatio(s: Sample, p: StatsParams = DEFAULT_STATS): number {
  const line = graceLine(s.est, p);
  if (!(line > 0)) return 0;
  return Math.min(p.overrunCap, Math.max(0, (s.act - line) / line));
}

export type Summary = {
  count: number;
  onTime: number;
  onTimeRate: number | null;
  /** 超時比例總和（目標推算用） */
  overrunSum: number;
  overrunRate: number | null;
};

export function summarize(samples: readonly Sample[], p: StatsParams = DEFAULT_STATS): Summary {
  const count = samples.length;
  let onTime = 0;
  let overrunSum = 0;
  for (const s of samples) {
    if (isOnTime(s, p)) onTime += 1;
    overrunSum += overrunRatio(s, p);
  }
  return {
    count,
    onTime,
    onTimeRate: count ? onTime / count : null,
    overrunSum,
    overrunRate: count ? overrunSum / count : null,
  };
}

// ── 期間（台北時區） ──

/** ms 所在的台北日 00:00（ms） */
export function taipeiDayStart(ms: number): number {
  return Math.floor((ms + TAIPEI_OFFSET_MS) / DAY_MS) * DAY_MS - TAIPEI_OFFSET_MS;
}

/** 台北日期 M/D、YYYY-MM-DD */
function taipeiParts(ms: number): { y: number; m: number; d: number } {
  const t = new Date(ms + TAIPEI_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const pad = (n: number) => String(n).padStart(2, '0');
export function taipeiDate(ms: number): string {
  const { y, m, d } = taipeiParts(ms);
  return `${y}-${pad(m)}-${pad(d)}`;
}
function taipeiMD(ms: number): string {
  const { m, d } = taipeiParts(ms);
  return `${pad(m)}/${pad(d)}`;
}

export type Period = {
  /** 第幾期（錨點那期＝0；更早為負） */
  index: number;
  /** 起（含）ms */
  start: number;
  /** 迄（不含）ms＝下一期起點 */
  end: number;
  /** 「11/09–11/22」 */
  label: string;
  /** 「2026-11-09」＝報酬單的期別 */
  id: string;
};

export function periodOf(ms: number): Period {
  const span = PERIOD_DAYS * DAY_MS;
  const index = Math.floor((ms - PERIOD_ANCHOR_MS) / span);
  const start = PERIOD_ANCHOR_MS + index * span;
  const end = start + span;
  return { index, start, end, label: `${taipeiMD(start)}–${taipeiMD(end - DAY_MS)}`, id: taipeiDate(start) };
}

/** 已送達、有實際分鐘、接單時間在 [since, until) 的單（取消/進行中不計）；v0.8 excludeStacked＝不含夾單 */
export function samplesBetween(orders: readonly Order[], since: number, until: number, excludeStacked = false): Sample[] {
  return orders
    .filter((o) => o.status === 'delivered' && o.actualMin != null && o.acceptedAt >= since && o.acceptedAt < until)
    .filter((o) => !(excludeStacked && o.stacked))
    .map((o) => ({ est: o.estimateMin, act: o.actualMin as number }));
}

/** 本期（報酬週期）與今日（台北日）的統計 */
// ── 本期補登（期初基準）：App 上線前本期已跑的單，使用者手動輸入 單數/準時率/超時率 ──

export type Baseline = {
  /** 綁定的期別（Period.id，例如 "2026-11-09"）；換期自動失效 */
  periodId: string;
  count: number;
  onTimeRate: number;
  overrunRate: number;
  /** v0.8：補登期間已領/應領的收入（元，可省略） */
  income?: number;
};
export const BASELINE_STORAGE_KEY = 'pandatimer.periodBaseline.v1';
export const MAX_BASELINE_COUNT = 2000;

/** AsyncStorage 裡的補登（不可信）→ 合法補登；壞掉 → null。currentPeriodId 給了且不同期 → null（換期失效） */
export function parseBaseline(raw: unknown, currentPeriodId?: string): Baseline | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const rate = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (typeof r.periodId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.periodId)) return null;
  if (!(typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0 && r.count <= MAX_BASELINE_COUNT)) return null;
  if (!rate(r.onTimeRate) || !rate(r.overrunRate)) return null;
  if (currentPeriodId != null && r.periodId !== currentPeriodId) return null;
  const out: Baseline = { periodId: r.periodId, count: r.count, onTimeRate: r.onTimeRate as number, overrunRate: r.overrunRate as number };
  if (typeof r.income === 'number' && Number.isFinite(r.income) && r.income > 0 && r.income <= 10_000_000) out.income = r.income;
  return out;
}

/**
 * 補登與 App 紀錄加權合併：準時率＝(N0·P0 + 準時單數)/(N0 + 單數)；超時率＝(N0·T0 + Σ單筆超時比例)/(N0 + 單數)。
 * onTime/overrunSum 可能是小數（N0·P0）——目標推算照樣適用。baseline 為 null 或 N0=0 → 原樣。
 */
export function mergeBaseline(s: Summary, b: Baseline | null): Summary & { baselineCount: number } {
  if (!b || b.count <= 0) return { ...s, baselineCount: 0 };
  const count = s.count + b.count;
  const onTime = s.onTime + b.count * b.onTimeRate;
  const overrunSum = s.overrunSum + b.count * b.overrunRate;
  return { count, onTime, onTimeRate: onTime / count, overrunSum, overrunRate: overrunSum / count, baselineCount: b.count };
}

/** 本期（報酬週期，含同期的補登）與今日（台北日，不含補登）的統計 */
export function periodAndToday(
  orders: readonly Order[],
  now: number,
  p: StatsParams = DEFAULT_STATS,
  baseline: Baseline | null = null,
) {
  const period = periodOf(now);
  const day = taipeiDayStart(now);
  const own = summarize(samplesBetween(orders, period.start, period.end), p);
  const b = baseline && baseline.periodId === period.id ? baseline : null;
  const ownNoStacked = summarize(samplesBetween(orders, period.start, period.end, true), p);
  const today = summarize(samplesBetween(orders, day, day + DAY_MS), p);
  const todayNoStacked = summarize(samplesBetween(orders, day, day + DAY_MS, true), p);
  return {
    period,
    /** App 自己的紀錄（不含補登） */
    own,
    current: mergeBaseline(own, b),
    today,
    /** v0.8 不含夾單（補登不分夾單 → 這組不併補登，只看 App 紀錄）；stackedCount＝本期/今日已送達的夾單數 */
    noStacked: {
      period: ownNoStacked,
      today: todayNoStacked,
      stackedCount: own.count - ownNoStacked.count,
      stackedToday: today.count - todayNoStacked.count,
    },
  };
}

// ── 目標 ──

/** 準時率等級：met＝≥目標（綠）、between＝底線～目標（黃）、below＝<底線（紅）；null＝零單 */
export type OnTimeLevel = 'met' | 'between' | 'below';

export type GoalProgress = {
  onTimeLevel: OnTimeLevel | null;
  /** 還要「連續準時」幾單才達到目標（已達標 → 0；目標 100% 且已有晚到 → null＝不可能） */
  needToGoal: number | null;
  /** 還要「連續準時」幾單才回到底線（已在底線以上 → 0；底線 100% 且已有晚到 → null） */
  needToFloor: number | null;
  /** 還能晚幾單仍達目標（未達標 → 0；目標 0% → null＝無限） */
  slackGoal: number | null;
  /** 還能晚幾單仍在底線以上（低於底線 → 0；底線 0% → null＝無限） */
  slackFloor: number | null;
  overrunMet: boolean | null;
  /** 目前超時率 − 目標（正＝超過目標） */
  overrunGap: number | null;
  /** 未達標：還要「連續不超時（比例 0）」幾單才回到目標（目標 0 且已有超時 → null） */
  overrunNeed: number | null;
};

/** (onTime + n) / (count + n) ≥ g 的最小 n（g ≥ 1 且有晚到 → null） */
function needFor(onTime: number, count: number, g: number): number | null {
  if (onTime / count >= g - EPS) return 0;
  if (g >= 1) return null;
  return Math.max(0, Math.ceil((g * count - onTime) / (1 - g) - EPS));
}

/** onTime / (count + k) ≥ g 的最大 k（未達 → 0；g ≤ 0 → null＝無限） */
function slackFor(onTime: number, count: number, g: number): number | null {
  if (g <= 0) return null;
  if (onTime / count < g - EPS) return 0;
  return Math.max(0, Math.floor(onTime / g - count + EPS));
}

export function goalProgress(s: Summary, goals: Goals): GoalProgress {
  if (s.count === 0) {
    return {
      onTimeLevel: null, needToGoal: null, needToFloor: null, slackGoal: null, slackFloor: null,
      overrunMet: null, overrunGap: null, overrunNeed: null,
    };
  }
  const rate = s.onTime / s.count;
  const goal = goals.onTimeRate;
  const floor = Math.min(goals.onTimeFloor, goal);
  const onTimeLevel: OnTimeLevel = rate >= goal - EPS ? 'met' : rate >= floor - EPS ? 'between' : 'below';
  const over = s.overrunSum / s.count;
  const og = goals.overrunRate;
  const overrunMet = over <= og + EPS;
  // sum / (count + n) ≤ og → n ≥ sum / og − count
  const overrunNeed = overrunMet ? 0 : og <= 0 ? null : Math.max(0, Math.ceil(s.overrunSum / og - s.count - EPS));
  return {
    onTimeLevel,
    needToGoal: needFor(s.onTime, s.count, goal),
    needToFloor: needFor(s.onTime, s.count, floor),
    slackGoal: slackFor(s.onTime, s.count, goal),
    slackFloor: slackFor(s.onTime, s.count, floor),
    overrunMet,
    overrunGap: over - og,
    overrunNeed,
  };
}

/** AsyncStorage 裡的目標（不可信）→ 合法目標；壞掉/缺漏 → 預設。百分比存 0~1；底線高於目標 → 底線＝目標 */
export function parseGoals(raw: unknown): Goals {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      o = null;
    }
  }
  const r = o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  const ok = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const onTimeRate = ok(r.onTimeRate) ? (r.onTimeRate as number) : DEFAULT_GOALS.onTimeRate;
  const floorRaw = ok(r.onTimeFloor) ? (r.onTimeFloor as number) : DEFAULT_GOALS.onTimeFloor;
  return {
    onTimeRate,
    onTimeFloor: Math.min(floorRaw, onTimeRate),
    overrunRate: ok(r.overrunRate) ? (r.overrunRate as number) : DEFAULT_GOALS.overrunRate,
  };
}

/** 使用者輸入的百分比字串（「50」「47.5」「50%」）→ 0~1；不合法 → null */
export function parsePercentInput(text: string): number | null {
  const m = /^\s*([0-9]{1,3}(?:\.[0-9]+)?)\s*%?\s*$/.exec(text);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return v >= 0 && v <= 100 ? v / 100 : null;
}

const pctText = (x: number) => `${Math.round(x * 1000) / 10}%`;

/** 目標進度的說明文字（準時率三層、超時率單一門檻） */
export function goalText(gp: GoalProgress, goals: Goals): { onTime: string; overrun: string } {
  const goal = pctText(goals.onTimeRate);
  const floor = pctText(Math.min(goals.onTimeFloor, goals.onTimeRate));
  const late = (k: number | null) => (k == null ? '不限' : `${k}`);
  let onTime = '還沒有單';
  if (gp.onTimeLevel === 'met') {
    onTime = `準時率達標：還能晚 ${late(gp.slackGoal)} 單仍達目標 ${goal}`;
  } else if (gp.onTimeLevel === 'between') {
    onTime = `再準時 ${gp.needToGoal ?? '—'} 單達到目標 ${goal}／還能晚 ${late(gp.slackFloor)} 單仍在底線 ${floor} 以上`;
  } else if (gp.onTimeLevel === 'below') {
    onTime = gp.needToFloor == null
      ? `準時率低於底線 ${floor}（已不可能回到底線）`
      : `還要連續準時 ${gp.needToFloor} 單才回到底線 ${floor}`;
  }
  let overrun = '還沒有單';
  if (gp.overrunMet != null && gp.overrunGap != null) {
    const pts = Math.round(Math.abs(gp.overrunGap) * 1000) / 10;
    overrun = gp.overrunMet
      ? `超時率達標（低於目標 ${pctText(goals.overrunRate)} ${pts} 個百分點）`
      : `超時率未達標（高於目標 ${pctText(goals.overrunRate)} ${pts} 個百分點` +
        (gp.overrunNeed == null ? '）' : `，要連續 ${gp.overrunNeed} 單不超時）`);
  }
  return { onTime, overrun };
}
