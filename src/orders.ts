// 純資料與統計邏輯（無副作用，方便測試）

export type OrderStatus = 'active' | 'delivered' | 'canceled';

export type Order = {
  id: string;
  /** 接單時間 (ms) */
  acceptedAt: number;
  /** 預估分鐘 */
  estimateMin: number;
  /** 截止時間 (ms) = acceptedAt + estimateMin 分 */
  deadline: number;
  status: OrderStatus;
  /** 送達時間 (ms) */
  deliveredAt?: number;
  /** 實際分鐘（小數一位） */
  actualMin?: number;
  /** Live Activity id */
  activityId?: string;
  /** 已排程的本地通知 id */
  notifIds?: string[];
  /** v0.4：'auto'＝螢幕廣播自動偵測開的單；v0.10 'confirm'＝未確認邀請按「有接」補開；v0.8 'import'＝deep link 匯入的補記單（其餘為手動/捷徑） */
  source?: 'auto' | 'import' | 'confirm' | 'admin';
  /** v0.8：夾單（邀請畫面有「夾單」字樣，或匯入時標記）；v1.1 也包含「疊單」（接單時手上已有其他進行中單） */
  stacked?: boolean;
  /** v1.1 stacked 的來源：'offer'＝邀請畫面寫「夾單」；'carry'＝接單時已有其他進行中單（只存本機，不同步） */
  stackKind?: 'offer' | 'carry';
  /** v0.8：匯入時帶的金額（元）與備註 */
  amount?: number;
  note?: string;
  /** 雲端同步：同步欄位最後修改時間 (ms)；store.mutate 自動蓋，LWW 用（'admin'＝管理網頁新增的單） */
  updatedAt?: number;
};

export const DEFAULT_ESTIMATE = 18;
export const SHORT_ORDER_MAX_MIN = 8;

/**
 * 預估報酬（＝ pandarider 邀請畫面金額）：時薪 245 元換算每分鐘（245/60），再加 1 分錢後無條件捨去到分，最低 45 元。
 * 依使用者 3 期報酬單 12~38 分全部金額驗證（12→49.01、13→53.09、14→57.17、15→61.26、20→81.67、21→85.76）。
 * 用整數分計算避免浮點誤差。
 */
export function exactFare(estimateMin: number): number {
  const cents = Math.floor((estimateMin * 24500) / 60 + 1 + 1e-9);
  return Math.max(4500, cents) / 100;
}

export function clampEstimate(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_ESTIMATE;
  return Math.min(180, Math.max(1, Math.round(n)));
}

export function isLate(o: Order): boolean {
  return o.actualMin != null && o.actualMin > o.estimateMin;
}

export function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type TodayStats = {
  count: number;
  onTimeRate: number | null;
  avgOverRatio: number | null;
  shortLate: number;
  shortCount: number;
};

/** 今日（依接單時間）已送達訂單的統計 */
export function todayStats(orders: Order[], now: number): TodayStats {
  const since = startOfToday(now);
  const done = orders.filter(
    (o) => o.status === 'delivered' && o.actualMin != null && o.acceptedAt >= since,
  );
  const count = done.length;
  if (count === 0) {
    return { count: 0, onTimeRate: null, avgOverRatio: null, shortLate: 0, shortCount: 0 };
  }
  const onTime = done.filter((o) => !isLate(o)).length;
  // foodpanda 超時率近似：每單 max(0, (實際-預估)/預估) 的平均（不含平台未公開的彈性時間）
  const overSum = done.reduce(
    (s, o) => s + Math.max(0, ((o.actualMin as number) - o.estimateMin) / o.estimateMin),
    0,
  );
  const short = done.filter((o) => o.estimateMin <= SHORT_ORDER_MAX_MIN);
  return {
    count,
    onTimeRate: onTime / count,
    avgOverRatio: overSum / count,
    shortLate: short.filter(isLate).length,
    shortCount: short.length,
  };
}

/** 進行中訂單，最早接單的在前 */
export function activeOrders(orders: Order[]): Order[] {
  return orders.filter((o) => o.status === 'active').sort((a, b) => a.acceptedAt - b.acceptedAt);
}

/** 最近 n 筆已送達 */
export function history(orders: Order[], n = 50): Order[] {
  return orders
    .filter((o) => o.status === 'delivered')
    .sort((a, b) => (b.deliveredAt ?? 0) - (a.deliveredAt ?? 0))
    .slice(0, n);
}

/** mm:ss（超過一小時 h:mm:ss） */
export function formatDuration(ms: number): string {
  const total = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type DeepLink = { action: 'start'; min: number | null } | { action: 'done' } | null;

/**
 * 解析 pandatimer://start?min=18 / pandatimer://done。
 * 不用 URL 物件（RN 的 URL polyfill 不完整），手動解析；min 取第一個數字（容忍 OCR 的「18分鐘」）。
 */
export function parseDeepLink(url: string | null | undefined): DeepLink {
  if (!url) return null;
  const m = /^pandatimer:\/*([a-zA-Z]+)\/?(?:\?(.*))?$/.exec(url.trim());
  if (!m) return null;
  const action = m[1].toLowerCase();
  if (action === 'done') return { action: 'done' };
  if (action !== 'start') return null;
  let min: number | null = null;
  for (const pair of (m[2] ?? '').split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k === 'min') {
      let text = v;
      try {
        text = decodeURIComponent(v);
      } catch {
        // OCR 文字可能帶孤立的 %，解碼失敗就用原字串找數字
      }
      const num = /\d+(?:\.\d+)?/.exec(text);
      if (num) min = clampEstimate(parseFloat(num[0]));
    }
  }
  return { action: 'start', min };
}
