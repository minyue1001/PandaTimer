// v0.4 螢幕廣播偵測：extension → App 的 Darwin 訊號名稱規則、原生狀態解析、今日自動單數（純函式，只有 type import）。
// ⚠️ 名稱規則與 modules/live-activity/ios/DetectorHub.swift（DetectorHub.parse）、
//    targets/broadcast/SampleHandler.swift（PandaSignal）一致；改一邊改三邊。Swift 在 WSL 不能跑，這份是測試替身。
//
// v0.6 新單訊號：com.pandatimer.order.<分 1-90>.<序號 0-3>
//   Darwin 通知只能帶名稱、且 App 被暫停時**同名通知會合併成一則** → 只用分鐘數時，連續兩張同分鐘的單會被吃掉一張。
//   extension 每觸發一次新單序號 +1（mod 4），名稱就不同；App 不再自己去重，每收到一則＝一張新單，
//   序號跳號＝中間有訊號遺失（寫進 telemetry）。金額不進名稱（90×1000 個名稱太多）→ 金額走 extension 自己的 telemetry
//   與「偵測到新單」通知的 userInfo。註冊數量：4 個狀態＋90×4＝364 個（< 1000）。
// v0.7 接單後才開始倒數：com.pandatimer.offer.pending.<分 1-90>（看到邀請、等判定）、com.pandatimer.offer.cleared（判定未接）、
//   com.pandatimer.accept.delay.<秒 0-60>（緊接在 order 訊號之前送：按下接受到現在幾秒；App 2 秒內配對還原接單時間）。
//   v0.7 自動送達：com.pandatimer.delivered（extension 看到完成/送達畫面；規則見 src/deliveryDetector.ts）。
//   註冊數量：364＋90＋1＋61＋1＝517 個（< 1000）。
// v0.8：com.pandatimer.offer.stacked（夾單；緊接在 accept.delay 之前送，App 2 秒內配對 → 訂單 stacked:true）、
//   com.pandatimer.delivered.delay.<秒 0-60>（緊接在 delivered 之前送；實際送達＝收到 − 秒數）。
//   註冊數量：517＋1＋61＝579 個（< 1000）。
// v1.0：com.pandatimer.offer.cleared.<reject|timeout|stopped>（未接的原因；舊的不帶原因名稱仍註冊）、
//   com.pandatimer.ext.mode.<away|normal>、com.pandatimer.ext.mem.<0-80>、com.pandatimer.ext.peak.<0-80>（extension 心跳後送，
//   App 放進 detectorStatus）。註冊數量：579＋3＋2＋81＋81＝746 個（< 1000）。
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
export const OFFER_PENDING_PREFIX = 'com.pandatimer.offer.pending.';
export const OFFER_CLEARED = 'com.pandatimer.offer.cleared';
export const DELIVERED_SIGNAL = 'com.pandatimer.delivered';
export const ACCEPT_DELAY_PREFIX = 'com.pandatimer.accept.delay.';
export const MAX_ACCEPT_DELAY = 60;
export const OFFER_STACKED = 'com.pandatimer.offer.stacked';
export const DELIVERED_DELAY_PREFIX = 'com.pandatimer.delivered.delay.';
export const MAX_DELIVERED_DELAY = 60;
export const OFFER_CLEARED_PREFIX = 'com.pandatimer.offer.cleared.';
export const OFFER_CLEAR_REASONS = ['reject', 'timeout', 'stopped'] as const;
export type OfferClearReason = (typeof OFFER_CLEAR_REASONS)[number];
export const EXT_MODE_AWAY = 'com.pandatimer.ext.mode.away';
export const EXT_MODE_NORMAL = 'com.pandatimer.ext.mode.normal';
export const EXT_MEM_PREFIX = 'com.pandatimer.ext.mem.';
export const EXT_PEAK_PREFIX = 'com.pandatimer.ext.peak.';
export const MAX_EXT_MB = 80;
/** Darwin 通知註冊上限（系統沒有明文，保守取 1000） */
export const MAX_SIGNAL_NAMES = 1000;

export type DetectorSignal =
  | { kind: 'order'; minutes: number; seq: number }
  | { kind: 'started' | 'stopped' | 'heartbeat' | 'drain' | 'delivered' | 'offerStacked' }
  | { kind: 'offerCleared'; reason?: OfferClearReason }
  | { kind: 'extMode'; away: boolean }
  | { kind: 'extMem' | 'extPeak'; mb: number }
  | { kind: 'offerPending'; minutes: number }
  | { kind: 'acceptDelay'; seconds: number }
  | { kind: 'deliveredDelay'; seconds: number };

/** 純數字、無前導 0（"0" 本身可以）、1~2 位、在 lo…hi 之間（同 DetectorHub.plainInt） */
function plainInt(text: string, lo: number, hi: number): number | null {
  if (!/^(0|[1-9][0-9]?)$/.test(text)) return null;
  const n = Number(text);
  return n >= lo && n <= hi ? n : null;
}

export function offerPendingName(minutes: number): string | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_SIGNAL_MINUTES ? `${OFFER_PENDING_PREFIX}${minutes}` : null;
}

export function acceptDelayName(seconds: number): string {
  const d = Math.min(MAX_ACCEPT_DELAY, Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0)));
  return `${ACCEPT_DELAY_PREFIX}${d}`;
}

export function offerClearedName(reason: OfferClearReason): string {
  return `${OFFER_CLEARED_PREFIX}${reason}`;
}

/** extension 記憶體 → 訊號名稱（MB 四捨五入、0…80）＝SampleHandler PandaSignal.clampMB */
export function extMemName(mb: number, peak = false): string {
  const v = Number.isFinite(mb) ? Math.min(MAX_EXT_MB, Math.max(0, Math.round(mb))) : 0;
  return `${peak ? EXT_PEAK_PREFIX : EXT_MEM_PREFIX}${v}`;
}

export function deliveredDelayName(seconds: number): string {
  const d = Math.min(MAX_DELIVERED_DELAY, Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0)));
  return `${DELIVERED_DELAY_PREFIX}${d}`;
}

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
  if (name === OFFER_CLEARED) return { kind: 'offerCleared' };
  if (name === DELIVERED_SIGNAL) return { kind: 'delivered' };
  if (name === OFFER_STACKED) return { kind: 'offerStacked' };
  if (name === EXT_MODE_AWAY) return { kind: 'extMode', away: true };
  if (name === EXT_MODE_NORMAL) return { kind: 'extMode', away: false };
  if (name.startsWith(OFFER_CLEARED_PREFIX)) {
    const reason = name.slice(OFFER_CLEARED_PREFIX.length);
    return (OFFER_CLEAR_REASONS as readonly string[]).includes(reason) ? { kind: 'offerCleared', reason: reason as OfferClearReason } : null;
  }
  for (const [prefix, kind] of [[EXT_MEM_PREFIX, 'extMem'], [EXT_PEAK_PREFIX, 'extPeak']] as const) {
    if (name.startsWith(prefix)) {
      const mb = plainInt(name.slice(prefix.length), 0, MAX_EXT_MB);
      return mb == null ? null : { kind, mb };
    }
  }
  if (name.startsWith(DELIVERED_DELAY_PREFIX)) {
    const seconds = plainInt(name.slice(DELIVERED_DELAY_PREFIX.length), 0, MAX_DELIVERED_DELAY);
    return seconds == null ? null : { kind: 'deliveredDelay', seconds };
  }
  if (name.startsWith(OFFER_PENDING_PREFIX)) {
    const minutes = plainInt(name.slice(OFFER_PENDING_PREFIX.length), 1, MAX_SIGNAL_MINUTES);
    return minutes == null ? null : { kind: 'offerPending', minutes };
  }
  if (name.startsWith(ACCEPT_DELAY_PREFIX)) {
    const seconds = plainInt(name.slice(ACCEPT_DELAY_PREFIX.length), 0, MAX_ACCEPT_DELAY);
    return seconds == null ? null : { kind: 'acceptDelay', seconds };
  }
  if (!name.startsWith(ORDER_SIGNAL_PREFIX)) return null;
  const m = /^([1-9][0-9]?)\.([0-9])$/.exec(name.slice(ORDER_SIGNAL_PREFIX.length));
  if (!m) return null;
  const minutes = Number(m[1]);
  const seq = Number(m[2]);
  if (minutes < 1 || minutes > MAX_SIGNAL_MINUTES || seq >= SIGNAL_SEQ_MOD) return null;
  return { kind: 'order', minutes, seq };
}

/** App 要註冊的全部名稱（4 個狀態＋90×4 個 order.N.S＋v0.7 的 pending/cleared/delay）＝原生 DetectorHub.allNames 的清單 */
export function allSignalNames(): string[] {
  const names: string[] = Object.values(STATE_SIGNALS);
  for (let n = 1; n <= MAX_SIGNAL_MINUTES; n++) {
    for (let s = 0; s < SIGNAL_SEQ_MOD; s++) names.push(`${ORDER_SIGNAL_PREFIX}${n}.${s}`);
  }
  for (let n = 1; n <= MAX_SIGNAL_MINUTES; n++) names.push(`${OFFER_PENDING_PREFIX}${n}`);
  names.push(OFFER_CLEARED);
  names.push(DELIVERED_SIGNAL);
  for (let d = 0; d <= MAX_ACCEPT_DELAY; d++) names.push(`${ACCEPT_DELAY_PREFIX}${d}`);
  names.push(OFFER_STACKED);
  for (let d = 0; d <= MAX_DELIVERED_DELAY; d++) names.push(`${DELIVERED_DELAY_PREFIX}${d}`);
  for (const r of OFFER_CLEAR_REASONS) names.push(offerClearedName(r));
  names.push(EXT_MODE_AWAY, EXT_MODE_NORMAL);
  for (let m = 0; m <= MAX_EXT_MB; m++) names.push(`${EXT_MEM_PREFIX}${m}`);
  for (let m = 0; m <= MAX_EXT_MB; m++) names.push(`${EXT_PEAK_PREFIX}${m}`);
  return names;
}

/**
 * v0.8 App 端配對（＝DetectorHub 的 takeStacked / takeDeliveredDelay）：前置訊號在主訊號前後 2 秒內才算數。時間：毫秒。
 * 回傳 delivered 的實際送達時間（配不到延遲 → 收到時間）。
 */
export function restoreDeliveredAt(receivedAt: number, delay?: { seconds: number; at: number } | null): number {
  if (delay && Math.abs(delay.at - receivedAt) <= 2000) return receivedAt - delay.seconds * 1000;
  return receivedAt;
}

export function pairedStacked(receivedAt: number, stackedAt: number | null | undefined): boolean {
  return stackedAt != null && Math.abs(stackedAt - receivedAt) <= 2000;
}

/**
 * v0.8 廣播停止補救（＝DetectorHub.handle(.stopped) 的規則）：App 仍在「偵測中」（使用者沒按停止偵測）收到 stopped
 * → 發「偵測停止了，點我重新開始」通知；60 秒內不重複。時間：毫秒。
 */
export const STOP_NOTICE_REPEAT_SEC = 60;
export function shouldNotifyStopped(armed: boolean, lastNoticeAt: number | null, now: number): boolean {
  if (!armed) return false;
  return lastNoticeAt == null || now - lastNoticeAt >= STOP_NOTICE_REPEAT_SEC * 1000;
}

/** 通知 userInfo 的 pandatimer 值：點了要自動叫出廣播視窗 */
export const REDETECT_TAG = 'redetect';
export function isRedetectData(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as Record<string, unknown>).pandatimer === REDETECT_TAG;
}

/**
 * v0.7：App 端 acceptedAt 還原（＝DetectorHub.handleOrder 的規則）。
 * App 曾被暫停 → 用通知 userInfo 的 detectedAt（找不到就用收到時間）；
 * 否則延遲訊號在收到 order 的前後 2 秒內 → 收到時間 − 延遲；配不到 → 收到時間。時間單位：毫秒。
 */
export function restoreAcceptedAt(opts: {
  receivedAt: number;
  suspended: boolean;
  notifiedAt?: number | null;
  delay?: { seconds: number; at: number } | null;
}): number {
  if (opts.suspended) return opts.notifiedAt ?? opts.receivedAt;
  const d = opts.delay;
  if (d && Math.abs(d.at - opts.receivedAt) <= 2000) return opts.receivedAt - d.seconds * 1000;
  return opts.receivedAt;
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
  /** v0.6 遠端設定版本（GET /api/config 的 version；沒抓過 → "default"） */
  configVersion: string;
  /** v0.7：extension 看到邀請、還沒判定接了沒 */
  offerPendingMinutes: number | null;
  offerPendingAt: number | null;
  /** v0.7：最近一次判定（「已接單 27 分（18:02:11）」／「未接單 27 分（…）」） */
  offerNote: string;
  /** v0.8：偵測中卻收到廣播停止（使用者沒按停止偵測）的時間；重新開始後清掉 */
  stoppedUnexpectedAt: number | null;
  /**
   * 省電/記憶體（v0.9 原生 statusJSON 沒帶 → 欄位不存在；v1.0 起有）：低電量模式、thermalState(0~3)、省電倍率中（App 自己看，
   * 規則同 extension）、電量/充電中（App）、extension 最近一次回報的 away/normal 模式與目前/峰值記憶體 MB（extAt＝回報時間）。
   * 只有原生真的帶了才會有這個 key。
   */
  power?: {
    lowPower?: boolean;
    thermal?: number;
    saver?: boolean;
    memMB?: number;
    peakMB?: number;
    extMode?: 'away' | 'normal';
    extAt?: number;
    batt?: number;
    charging?: boolean;
  };
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
  const power: NonNullable<DetectorStatus['power']> = {};
  if (typeof o.lowPower === 'boolean') power.lowPower = o.lowPower;
  if (num(o.thermal) != null) power.thermal = o.thermal as number;
  if (typeof o.saver === 'boolean') power.saver = o.saver;
  if (num(o.memMB) != null) power.memMB = o.memMB as number;
  if (num(o.peakMB) != null) power.peakMB = o.peakMB as number;
  if (o.extMode === 'away' || o.extMode === 'normal') power.extMode = o.extMode;
  if (num(o.extAt) != null) power.extAt = o.extAt as number;
  if (num(o.batt) != null) power.batt = o.batt as number;
  if (typeof o.charging === 'boolean') power.charging = o.charging;
  return {
    ...(Object.keys(power).length ? { power } : {}),
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
    configVersion: typeof o.configVersion === 'string' ? o.configVersion : 'default',
    offerPendingMinutes: num(o.offerPendingMinutes),
    offerPendingAt: num(o.offerPendingAt),
    offerNote: typeof o.offerNote === 'string' ? o.offerNote : '',
    stoppedUnexpectedAt: num(o.stoppedUnexpectedAt),
  };
}

/** pending 超過這麼久還沒有結果（訊號遺失）→ 不再顯示「等你接單」 */
export const OFFER_PENDING_STALE_SEC = 180;

/**
 * v0.7 偵測區的接單狀態行：「偵測到邀請 27 分，等你接單…（12 秒）」；沒有在等 → 最近一次判定；都沒有 → null
 */
export function offerLine(status: DetectorStatus | null, now: number): string | null {
  if (!status) return null;
  if (status.offerPendingAt != null) {
    const age = Math.max(0, Math.round((now - status.offerPendingAt) / 1000));
    if (age <= OFFER_PENDING_STALE_SEC) {
      const m = status.offerPendingMinutes != null ? ` ${status.offerPendingMinutes} 分` : '';
      return `偵測到邀請${m}，等你接單…（${age} 秒）`;
    }
  }
  return status.offerNote ? `最近：${status.offerNote}` : null;
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
  if (status.configVersion && status.configVersion !== 'default') text += `・設定 ${status.configVersion}`;
  return text;
}
