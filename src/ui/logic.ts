// v0.9 UI 改版：畫面用的純函式（無 React / RN 依賴，node --test 直接載入；測試見 test/uiLogic.test.mjs）。
//   detectPill    首頁偵測狀態膠囊（🟢偵測中／🟡等你接單・等待開始直播／🔴偵測已停止・沒有回應／⚪未開始）
//   actionHint    本期成績卡的一行行動提示（還能晚幾單／要連續準時幾單）
//   groupHistory  紀錄頁：依台北日期分組＋日小計
//   orderCountdown / orderAmount / sortActive  進行中訂單卡
//   parseTab / shouldJumpHome  分頁記憶與自動切回首頁
import { beatAgeSec, OFFER_PENDING_STALE_SEC, type DetectorStatus } from '../detector.ts';
import { formatClock, formatDuration, type Order } from '../orders.ts';
import { DEFAULT_PAY, fareFor, summarizeEarnings, type PayParams } from '../earnings.ts';
import {
  DEFAULT_STATS,
  isOnTime,
  summarize,
  taipeiDate,
  taipeiDayStart,
  type GoalProgress,
  type Goals,
  type StatsParams,
} from '../stats.ts';

const DAY_MS = 86_400_000;
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** 0.625 → 「62.5%」；null → 「—」 */
export function pctText(x: number | null | undefined): string {
  return x == null || !Number.isFinite(x) ? '—' : `${Math.round(x * 1000) / 10}%`;
}

// ── 偵測狀態膠囊 ──

export type Tone = 'green' | 'yellow' | 'red' | 'gray';
export type PillKind = 'idle' | 'starting' | 'running' | 'waiting' | 'stopped';
export type Pill = {
  kind: PillKind;
  tone: Tone;
  title: string;
  detail: string;
  /** 主按鈕：start＝開始偵測、restart＝重新開始偵測、picker＝叫出直播視窗、null＝不顯示 */
  action: 'start' | 'restart' | 'picker' | null;
  /** 偵測中（armed）→ 顯示「停止偵測」 */
  canStop: boolean;
};

/** 心跳超過這麼久（秒）＝偵測沒有回應（＝原生 beatTimeout 通知的門檻） */
export const BEAT_STALE_SEC = 150;
/** 按下「開始偵測」後這段時間內、還沒收到新心跳 → 顯示「等待開始直播」而不是紅燈 */
export const START_GRACE_SEC = 120;

/**
 * det＝原生 detectorStatus()；armedAt＝這次 App 程序內最後一次按「開始偵測」的時間（不知道 → null）。
 * 規則：沒原生/沒 armed → 未開始（曾非預期停止 → 🔴 已停止）；armed：邀請判定中 → 🟡；剛按開始、還沒新心跳 → 🟡 等待開始直播；
 * 心跳 >150 秒或從沒心跳 → 🔴 沒有回應；其餘 🟢。
 */
export function detectPill(det: DetectorStatus | null, now: number, armedAt: number | null = null): Pill {
  if (!det || !det.armed) {
    if (det?.stoppedUnexpectedAt != null) {
      return {
        kind: 'stopped',
        tone: 'red',
        title: '偵測已停止',
        detail: `螢幕廣播在 ${formatClock(det.stoppedUnexpectedAt)} 停了，按下面重新開始`,
        action: 'restart',
        canStop: false,
      };
    }
    return { kind: 'idle', tone: 'gray', title: '未開始偵測', detail: '上線接單前先按「開始偵測」', action: 'start', canStop: false };
  }
  if (det.offerPendingAt != null) {
    const age = Math.max(0, Math.round((now - det.offerPendingAt) / 1000));
    if (age <= OFFER_PENDING_STALE_SEC) {
      const m = det.offerPendingMinutes != null ? ` ${det.offerPendingMinutes} 分` : '';
      // v1.0（使用者回饋：要看到「偵測成功」才敢按接受）→ 標題直接說可以按
      return { kind: 'waiting', tone: 'yellow', title: '✓ 可以按接受', detail: `已偵測到邀請${m}・${age} 秒前`, action: null, canStop: true };
    }
  }
  const age = beatAgeSec(det, now);
  const freshStart =
    armedAt != null && now - armedAt < START_GRACE_SEC * 1000 && (det.lastBeatAt == null || det.lastBeatAt < armedAt);
  if (freshStart) {
    return {
      kind: 'starting',
      tone: 'yellow',
      title: '等待開始直播',
      detail: '在系統視窗按「開始直播」；沒跳出就點右邊圓鈕',
      action: 'picker',
      canStop: true,
    };
  }
  if (age == null || age > BEAT_STALE_SEC) {
    return {
      kind: 'stopped',
      tone: 'red',
      title: '偵測沒有回應',
      detail: age == null ? '還沒收到心跳（螢幕廣播可能沒開）' : `最後心跳 ${age} 秒前，螢幕廣播可能停了`,
      action: 'restart',
      canStop: true,
    };
  }
  const parts = [`心跳 ${age} 秒前`, det.keepAlive || '保活未知'];
  if (det.power?.saver || det.power?.lowPower) parts.push('省電中');
  // v1.0：extension 在 away 模式（畫面上不是 pandarider → 放慢辨識）
  if (det.power?.extMode === 'away') parts.push('放慢辨識');
  return { kind: 'running', tone: 'green', title: '偵測中', detail: parts.join('・'), action: null, canStop: true };
}

/**
 * v1.0 設定頁診斷「省電/記憶體」：省電倍率中/低電量模式/正常・偵測放慢（away）・溫度等級・電量・偵測記憶體 目前/峰值MB
 * （記憶體是 extension 最近一次心跳回報的值）
 */
export function powerLine(pw: NonNullable<DetectorStatus['power']>): string {
  const mem =
    pw.memMB != null
      ? `偵測記憶體 ${Math.round(pw.memMB)}${pw.peakMB != null ? `/${Math.round(pw.peakMB)}` : ''}MB`
      : pw.peakMB != null
        ? `偵測記憶體峰值 ${Math.round(pw.peakMB)}MB`
        : '';
  return [
    pw.saver ? '省電倍率中' : pw.lowPower ? '低電量模式' : '正常',
    pw.extMode === 'away' ? '放慢辨識（非外送畫面）' : '',
    pw.thermal != null ? `溫度等級 ${pw.thermal}` : '',
    pw.batt != null ? `電量 ${Math.round(pw.batt)}%${pw.charging ? '（充電中）' : ''}` : '',
    mem,
  ]
    .filter(Boolean)
    .join('・');
}

// ── 本期成績的行動提示 ──

export type Hint = { main: string; tone: Tone; overrun: string | null };

/** 一行行動提示（準時率）＋超時率未達標時的第二行 */
export function actionHint(gp: GoalProgress, goals: Goals): Hint {
  const goal = pctText(goals.onTimeRate);
  const floor = pctText(Math.min(goals.onTimeFloor, goals.onTimeRate));
  let main = '本期還沒有單';
  let tone: Tone = 'gray';
  if (gp.onTimeLevel === 'met') {
    tone = 'green';
    main =
      gp.slackGoal == null
        ? `已達 ${goal}，晚到不影響目標`
        : gp.slackGoal === 0
          ? `剛好 ${goal}：下一單要準時`
          : `還能晚 ${gp.slackGoal} 單仍達 ${goal}`;
  } else if (gp.onTimeLevel === 'between') {
    tone = 'yellow';
    const slack = gp.slackFloor == null ? '不限' : String(gp.slackFloor);
    main = `再準時 ${gp.needToGoal ?? '—'} 單達 ${goal}・還能晚 ${slack} 單守 ${floor}`;
  } else if (gp.onTimeLevel === 'below') {
    tone = 'red';
    main = gp.needToFloor == null ? `低於底線 ${floor}，本期回不去了` : `要連續準時 ${gp.needToFloor} 單回到 ${floor}`;
  }
  let overrun: string | null = null;
  if (gp.overrunMet === false) {
    const og = pctText(goals.overrunRate);
    overrun = gp.overrunNeed == null ? `超時率超過 ${og}` : `要連續 ${gp.overrunNeed} 單不超時，超時率回到 ${og}`;
  }
  return { main, tone, overrun };
}

/** 超時率顏色：未有單 gray、≤上限 green、超過 red */
export function overrunTone(gp: GoalProgress): Tone {
  return gp.overrunMet == null ? 'gray' : gp.overrunMet ? 'green' : 'red';
}

/** 準時率顏色：≥目標 green、底線～目標 yellow、<底線 red */
export function onTimeTone(gp: GoalProgress): Tone {
  return gp.onTimeLevel === 'met' ? 'green' : gp.onTimeLevel === 'between' ? 'yellow' : gp.onTimeLevel === 'below' ? 'red' : 'gray';
}

// ── 進行中訂單 ──

/** 進行中訂單，最早截止的在前（同截止 → 先接的在前） */
export function sortActive(orders: readonly Order[]): Order[] {
  return orders
    .filter((o) => o.status === 'active')
    .sort((a, b) => a.deadline - b.deadline || a.acceptedAt - b.acceptedAt);
}

export type Countdown = {
  leftMs: number;
  late: boolean;
  /** 已超時幾分（整數，無條件捨去；未超時 0） */
  lateMin: number;
  /** 剩不到 3 分 */
  urgent: boolean;
  /** mm:ss（超時也顯示經過的 mm:ss） */
  timeText: string;
};

export function orderCountdown(o: Pick<Order, 'deadline'>, now: number): Countdown {
  const leftMs = o.deadline - now;
  const late = leftMs < 0;
  return {
    leftMs,
    late,
    lateMin: late ? Math.floor(-leftMs / 60_000) : 0,
    urgent: !late && leftMs < 3 * 60_000,
    timeText: formatDuration(leftMs),
  };
}

/** 卡片/紀錄的金額：匯入帶的金額優先；否則用預估報酬（max(最低, 預估分×費率)），estimated=true 顯示「約」 */
export function orderAmount(o: Pick<Order, 'amount' | 'estimateMin'>, p: PayParams = DEFAULT_PAY): { value: number; estimated: boolean } {
  if (o.amount != null && Number.isFinite(o.amount) && o.amount > 0) return { value: o.amount, estimated: false };
  // 預估分鐘換算的金額與平台算法逐分吻合，視為確切值
  return { value: fareFor(o.estimateMin, p), estimated: false };
}

/** 標籤：自動／匯入／夾單 */
export function orderTags(o: Pick<Order, 'source' | 'stacked'>): string[] {
  const t: string[] = [];
  if (o.source === 'auto') t.push('自動');
  if (o.source === 'import') t.push('匯入');
  if (o.source === 'confirm') t.push('補認');
  if (o.stacked) t.push('夾單');
  return t;
}

// ── 紀錄頁：依日期分組 ──

export type HistRow = {
  order: Order;
  /** 接單 HH:mm（台北） */
  time: string;
  est: number;
  act: number;
  onTime: boolean;
  /** 實際 − 預估（分，小數一位） */
  overMin: number;
  amount: number;
  amountEstimated: boolean;
  tags: string[];
};

export type DaySubtotal = { count: number; onTimeRate: number | null; overrunRate: number | null; payout: number; stacked: number };

export type DayGroup = {
  /** 台北日期 YYYY-MM-DD */
  key: string;
  /** 「11/12（四）」 */
  label: string;
  /** 「今天」「昨天」或空字串 */
  relative: string;
  rows: HistRow[];
  /** 整天（不受 limit 影響）的小計 */
  subtotal: DaySubtotal;
  /** 這天被 limit 截掉沒顯示的筆數 */
  hidden: number;
};

const WEEKDAY = '日一二三四五六';
const pad2 = (n: number) => String(n).padStart(2, '0');

/** 台北時間 HH:mm（不依賴裝置時區） */
export function taipeiClock(ms: number): string {
  const t = new Date(ms + TAIPEI_OFFSET_MS);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}

/** 台北日 → 「11/12（四）」 */
export function taipeiDayLabel(ms: number): string {
  const t = new Date(taipeiDayStart(ms) + TAIPEI_OFFSET_MS);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}（${WEEKDAY[t.getUTCDay()]}）`;
}

/**
 * 已送達的單依接單時間的台北日分組（新的日期在前；同一天依送達時間新→舊），每組附整天小計。
 * limit＝最多顯示幾列（跨組累計）；小計永遠算整天。
 */
export function groupHistory(
  orders: readonly Order[],
  opts: { now: number; limit?: number; stats?: StatsParams; pay?: PayParams },
): { groups: DayGroup[]; total: number; shown: number } {
  const stats = opts.stats ?? DEFAULT_STATS;
  const pay = opts.pay ?? DEFAULT_PAY;
  const limit = opts.limit ?? Infinity;
  const done = orders
    .filter((o) => o.status === 'delivered' && o.actualMin != null)
    .sort((a, b) => (b.deliveredAt ?? b.acceptedAt) - (a.deliveredAt ?? a.acceptedAt));
  const byDay = new Map<string, Order[]>();
  for (const o of done) {
    const k = taipeiDate(o.acceptedAt);
    const list = byDay.get(k);
    if (list) list.push(o);
    else byDay.set(k, [o]);
  }
  const todayKey = taipeiDate(opts.now);
  const yesterdayKey = taipeiDate(opts.now - DAY_MS);
  const keys = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const groups: DayGroup[] = [];
  let shown = 0;
  for (const key of keys) {
    if (shown >= limit) break;
    const list = byDay.get(key) as Order[];
    const samples = list.map((o) => ({ est: o.estimateMin, act: o.actualMin as number }));
    const sum = summarize(samples, stats);
    const earn = summarizeEarnings(samples, pay);
    const take = list.slice(0, Math.max(0, limit - shown));
    shown += take.length;
    groups.push({
      key,
      label: taipeiDayLabel(list[0].acceptedAt),
      relative: key === todayKey ? '今天' : key === yesterdayKey ? '昨天' : '',
      rows: take.map((o) => {
        const act = o.actualMin as number;
        const amt = orderAmount(o, pay);
        return {
          order: o,
          time: taipeiClock(o.acceptedAt),
          est: o.estimateMin,
          act,
          onTime: isOnTime({ est: o.estimateMin, act }, stats),
          overMin: Math.round((act - o.estimateMin) * 10) / 10,
          amount: amt.value,
          amountEstimated: amt.estimated,
          tags: orderTags(o),
        };
      }),
      subtotal: {
        count: sum.count,
        onTimeRate: sum.onTimeRate,
        overrunRate: sum.overrunRate,
        payout: earn.payout,
        stacked: list.filter((o) => o.stacked).length,
      },
      hidden: list.length - take.length,
    });
  }
  return { groups, total: done.length, shown };
}

// ── 分頁 ──

export type Tab = 'home' | 'history' | 'settings';
export const TABS: readonly Tab[] = ['home', 'history', 'settings'];
export const TAB_STORAGE_KEY = 'pandatimer.ui.tab.v1';

export function parseTab(raw: unknown): Tab | null {
  return typeof raw === 'string' && (TABS as readonly string[]).includes(raw) ? (raw as Tab) : null;
}

export type Attention = { kind: PillKind; activeCount: number };

/**
 * 自動切回首頁：膠囊「變成」🔴停止／🟡等你接單（邊緣觸發，停在同一狀態不會一直拉回），或進行中單數變多（新單）。
 * prev＝null（第一次觀察）：只看膠囊狀態。
 */
export function shouldJumpHome(prev: Attention | null, next: Attention): boolean {
  const alarming = next.kind === 'stopped' || next.kind === 'waiting';
  if (alarming && prev?.kind !== next.kind) return true;
  return prev != null && next.activeCount > prev.activeCount;
}
