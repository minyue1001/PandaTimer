// v0.4 螢幕廣播偵測：extension → App 的 Darwin 訊號名稱規則、原生狀態解析、今日自動單數（純函式，只有 type import）。
// ⚠️ 名稱規則與 modules/live-activity/ios/DetectorHub.swift（DetectorHub.parse）、
//    targets/broadcast/SampleHandler.swift（PandaSignal）一致；改一邊改三邊。Swift 在 WSL 不能跑，這份是測試替身。
//
// v0.6 新單訊號：com.pandatimer.order.<分 1-90>.<序號 0-3>
//   Darwin 通知只能帶名稱、且 App 被暫停時**同名通知會合併成一則** → 只用分鐘數時，連續兩張同分鐘的單會被吃掉一張。
//   extension 每觸發一次新單序號 +1（mod 4），名稱就不同；App 不再自己去重，每收到一則＝一張新單，
//   序號跳號＝中間有訊號遺失（寫進 telemetry）。金額不進名稱（90×1000 個名稱太多）→ 金額走 extension 自己的 telemetry
//   與「偵測到新單」通知的 userInfo。註冊數量：4 個狀態＋90×4＝364 個（< 1000）。
import type { Order } from './orders';

export const ORDER_SIGNAL_PREFIX = 'com.pandatimer.order.';
export const STATE_SIGNALS = {
  started: 'com.pandatimer.broadcast.started',
  stopped: 'com.pandatimer.broadcast.stopped',
  heartbeat: 'com.pandatimer.broadcast.heartbeat',
  drain: 'com.pandatimer.drain',
} as const;
export const MAX_SIGNAL_MINUTES = 90;
export const SIGNAL_SEQ_MOD = 4;

export type DetectorSignal =
  | { kind: 'order'; minutes: number; seq: number }
  | { kind: 'started' | 'stopped' | 'heartbeat' | 'drain' };

/** 新單訊號名稱；分鐘數超出 1…90 → null（App 沒註冊那些名稱） */
export function orderSignalName(minutes: number, seq: number): string | null {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SIGNAL_MINUTES) return null;
  const s = ((Math.trunc(seq) % SIGNAL_SEQ_MOD) + SIGNAL_SEQ_MOD) % SIGNAL_SEQ_MOD;
  return `${ORDER_SIGNAL_PREFIX}${minutes}.${s}`;
}

/** Darwin 通知名稱 → 訊號。order.<N>.<S>：N 純數字 1…90（不接受 07、+5、5.0），S 為 0…3 */
export function parseSignalName(name: unknown): DetectorSignal | null {
  if (typeof name !== 'string') return null;
  for (const [kind, full] of Object.entries(STATE_SIGNALS)) {
    if (name === full) return { kind: kind as keyof typeof STATE_SIGNALS };
  }
  if (!name.startsWith(ORDER_SIGNAL_PREFIX)) return null;
  const m = /^([1-9][0-9]?)\.([0-9])$/.exec(name.slice(ORDER_SIGNAL_PREFIX.length));
  if (!m) return null;
  const minutes = Number(m[1]);
  const seq = Number(m[2]);
  if (minutes < 1 || minutes > MAX_SIGNAL_MINUTES || seq >= SIGNAL_SEQ_MOD) return null;
  return { kind: 'order', minutes, seq };
}

/** App 要註冊的全部名稱（4 個狀態＋90×4 個 order.N.S）＝原生 DetectorHub.registerIfNeeded 的清單 */
export function allSignalNames(): string[] {
  const names: string[] = Object.values(STATE_SIGNALS);
  for (let n = 1; n <= MAX_SIGNAL_MINUTES; n++) {
    for (let s = 0; s < SIGNAL_SEQ_MOD; s++) names.push(`${ORDER_SIGNAL_PREFIX}${n}.${s}`);
  }
  return names;
}

/** 上一個序號 → 這次序號之間漏掉幾則（mod 4；第一則或不知道上一個 → 0） */
export function missedSignals(prevSeq: number | null, seq: number): number {
  if (prevSeq == null) return 0;
  return (seq - prevSeq - 1 + SIGNAL_SEQ_MOD) % SIGNAL_SEQ_MOD;
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
  /** v0.6 遠端回報：最後一次送出成功的時間、待送筆數、最近錯誤 */
  telemetryLastOk: number | null;
  telemetryPending: number;
  telemetryError?: string;
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
    telemetryLastOk: num(o.telemetryLastOk),
    telemetryPending: num(o.telemetryPending) ?? 0,
    telemetryError: typeof o.telemetryError === 'string' ? o.telemetryError : undefined,
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

/** v0.6：「回報：最後成功 HH:mm:ss（待送 N）」；沒送過 → 「回報：尚未成功」 */
export function telemetryLine(status: DetectorStatus | null): string | null {
  if (!status) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  let text = '回報：';
  if (status.telemetryLastOk) {
    const d = new Date(status.telemetryLastOk);
    text += `最後成功 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } else {
    text += '尚未成功';
  }
  if (status.telemetryPending > 0) text += `（待送 ${status.telemetryPending}）`;
  if (status.telemetryError) text += `・${status.telemetryError.slice(0, 40)}`;
  return text;
}
