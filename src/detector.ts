// v0.4 螢幕廣播偵測：extension → App 的 Darwin 訊號名稱規則、原生狀態解析、今日自動單數（純函式，只有 type import）。
// ⚠️ 名稱規則與 modules/live-activity/ios/DetectorHub.swift（DetectorHub.parse）、
//    targets/broadcast/SampleHandler.swift（PandaSignal）一致；改一邊改三邊。Swift 在 WSL 不能跑，這份是測試替身。
import type { Order } from './orders';

export const ORDER_SIGNAL_PREFIX = 'com.pandatimer.order.';
export const STATE_SIGNALS = {
  started: 'com.pandatimer.broadcast.started',
  stopped: 'com.pandatimer.broadcast.stopped',
  heartbeat: 'com.pandatimer.broadcast.heartbeat',
  drain: 'com.pandatimer.drain',
} as const;
export const MAX_SIGNAL_MINUTES = 90;

export type DetectorSignal =
  | { kind: 'order'; minutes: number }
  | { kind: 'started' | 'stopped' | 'heartbeat' | 'drain' };

/** Darwin 通知名稱 → 訊號。order.N 只接受純數字 1…90（不接受 07、+5、5.0 這類） */
export function parseSignalName(name: unknown): DetectorSignal | null {
  if (typeof name !== 'string') return null;
  for (const [kind, full] of Object.entries(STATE_SIGNALS)) {
    if (name === full) return { kind: kind as keyof typeof STATE_SIGNALS };
  }
  if (!name.startsWith(ORDER_SIGNAL_PREFIX)) return null;
  const rest = name.slice(ORDER_SIGNAL_PREFIX.length);
  if (!/^[1-9][0-9]?$/.test(rest)) return null;
  const minutes = Number(rest);
  return minutes >= 1 && minutes <= MAX_SIGNAL_MINUTES ? { kind: 'order', minutes } : null;
}

/** App 要註冊的全部名稱（4 個狀態＋90 個 order.N）＝原生 DetectorHub.registerIfNeeded 的清單 */
export function allSignalNames(): string[] {
  const names: string[] = Object.values(STATE_SIGNALS);
  for (let n = 1; n <= MAX_SIGNAL_MINUTES; n++) names.push(`${ORDER_SIGNAL_PREFIX}${n}`);
  return names;
}

export type DetectorStatus = {
  armed: boolean;
  /** v0.5：無／等待定位授權／定位中／音訊中(備援)／音訊備援中斷／音訊備援失敗 */
  keepAlive: string;
  /** none / auth / location / audio */
  keepAliveMode: string;
  /** unknown / notDetermined / whenInUse / always / denied / restricted */
  locationAuth: string;
  keepAliveError?: string;
  /** 最近一次定位時間（只存記憶體，以後做到點提醒用） */
  lastFixAt: number | null;
  /** 最近一次動態島更新的回讀結果，例如「動態島：已更新✓（背景）」 */
  islandCheck: string;
  lastBeatAt: number | null;
  lastOrderMinutes: number | null;
  lastOrderAt: number | null;
  lastOrderHow: string;
  autoCountSinceLaunch: number;
};

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 原生 detectorStatus() 回來的 JSON 字串（不可信）→ 狀態；壞掉回 null */
export function parseDetectorStatus(raw: unknown): DetectorStatus | null {
  if (typeof raw !== 'string' || !raw) return null;
  let r: unknown;
  try {
    r = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  return {
    armed: o.armed === true,
    keepAlive: typeof o.keepAlive === 'string' ? o.keepAlive : '未知',
    keepAliveMode: typeof o.keepAliveMode === 'string' ? o.keepAliveMode : 'none',
    locationAuth: typeof o.locationAuth === 'string' ? o.locationAuth : 'unknown',
    keepAliveError: typeof o.keepAliveError === 'string' ? o.keepAliveError : undefined,
    lastFixAt: num(o.lastFixAt),
    islandCheck: typeof o.islandCheck === 'string' ? o.islandCheck : '',
    lastBeatAt: num(o.lastBeatAt),
    lastOrderMinutes: num(o.lastOrderMinutes),
    lastOrderAt: num(o.lastOrderAt),
    lastOrderHow: typeof o.lastOrderHow === 'string' ? o.lastOrderHow : '',
    autoCountSinceLaunch: num(o.autoCountSinceLaunch) ?? 0,
  };
}

/** 今日（依接單時間）自動偵測開的單數，不含已取消 */
export function countAutoToday(orders: Order[], now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const since = d.getTime();
  return orders.filter((o) => o.source === 'auto' && o.status !== 'canceled' && o.acceptedAt >= since).length;
}

/** v0.5：定位授權還沒有結果（尚未建立 CLLocationManager 或系統詢問視窗還沒按）→ 開廣播選擇器前要等 */
export function locationAuthPending(status: DetectorStatus | null): boolean {
  if (!status || !status.armed) return false;
  return status.keepAliveMode === 'auth' || status.locationAuth === 'notDetermined' || status.locationAuth === 'unknown';
}

/** 心跳多久前（秒）；沒有心跳 → null */
export function beatAgeSec(status: DetectorStatus | null, now: number): number | null {
  if (!status?.lastBeatAt) return null;
  return Math.max(0, Math.round((now - status.lastBeatAt) / 1000));
}
