import { Platform } from 'react-native';
import type { ActivityBrief } from '../../src/nativeEvents';
import { parseDetectorStatus, type DetectorStatus } from '../../src/detector';
import { requireOptionalNativeModule } from 'expo';

type LiveActivityNative = {
  isSupported(): boolean;
  start(estimateMinutes: number, deadlineMs: number): Promise<string>;
  end(id: string): Promise<void>;
  endAll(): Promise<void>;
  activeIds(): string[];
  drainNativeEvents?(): string;
  syncActiveOrders?(json: string): void;
  activitySummaries?(): string;
  startStandby?(): Promise<string>;
  armDetection?(): string;
  stopDetection?(): Promise<void>;
  detectorStatus?(): string;
  setTelemetryContext?(json: string): void;
  addListener?(event: 'onDetectorSignal', fn: (ev: DetectorEvent) => void): { remove(): void };
};

/** v0.4 原生 DetectorHub 送來的事件（extension 的 Darwin 訊號，或 App Intents 要求 drain） */
export type DetectorEvent = {
  type: 'order' | 'started' | 'stopped' | 'heartbeat' | 'drain' | 'beatTimeout' | 'restored' | 'offer' | 'offerCleared';
  minutes?: number;
  /** v1.0 offerCleared：reject / timeout / stopped（舊原生沒帶） */
  reason?: string;
  how?: string;
  /** v0.5：更新後回讀結果（動態島：已更新✓／疑似被系統擋✗） */
  check?: string;
  /** v0.8 stopped：使用者沒按「停止偵測」就停了（已發「點我重新開始」通知） */
  unexpected?: boolean;
};

// Expo Go / web / Android 沒有這個原生模組 → 為 null，所有呼叫安全地退化成 no-op。
const native =
  Platform.OS === 'ios' ? requireOptionalNativeModule<LiveActivityNative>('LiveActivity') : null;

export function isSupported(): boolean {
  try {
    return native?.isSupported() ?? false;
  } catch {
    return false;
  }
}

/** 啟動 Live Activity，回傳 activity id。必須在 App 前景（active）時呼叫。 */
export async function start(estimateMinutes: number, deadlineMs: number): Promise<string> {
  if (!native) throw new Error('LiveActivity 原生模組不存在（需原生編譯版本）');
  return native.start(estimateMinutes, deadlineMs);
}

export async function end(id: string): Promise<void> {
  if (!native) return;
  await native.end(id);
}

export async function endAll(): Promise<void> {
  if (!native) return;
  await native.endAll();
}

export function activeIds(): string[] {
  try {
    return native?.activeIds() ?? [];
  } catch {
    return [];
  }
}

/**
 * 取走 App Intents（背景、不跑 JS）寫在 UserDefaults 的事件並清空佇列。
 * 回傳未驗證的 JSON 陣列，交給 src/nativeEvents.ts 的 parseNativeEvents 過濾。
 */
export function drainNativeEvents(): unknown[] {
  try {
    const raw = native?.drainNativeEvents?.();
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 把「進行中訂單」鏡像寫進 UserDefaults，給 DeliveredIntent / 動態島送達按鈕挑單用 */
export function syncActiveOrders(json: string): void {
  try {
    native?.syncActiveOrders?.(json);
  } catch {
    // 舊版原生或非 iOS：忽略
  }
}

export type ActivitySummary = ActivityBrief;

/**
 * v0.3：系統裡每張卡的 id／mode／是否為螢幕廣播偵測卡（detector）。
 * 舊版原生（沒有這個函式）回傳 null，呼叫端要退回 activeIds() 的舊行為。
 */
export function activitySummaries(): ActivitySummary[] | null {
  try {
    const raw = native?.activitySummaries?.();
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .filter((x) => typeof x.id === 'string')
      .map((x) => ({
        id: x.id as string,
        mode: typeof x.mode === 'string' ? x.mode : 'countdown',
        detector: x.detector === true,
      }));
  } catch {
    return null;
  }
}

/** v0.3 螢幕廣播偵測：前景開一張「偵測待命」動態島（已有就沿用），回傳 activity id */
export async function startStandby(): Promise<string> {
  if (!native?.startStandby) throw new Error('原生模組沒有 startStandby（需 v0.3 以上的原生版本）');
  return native.startStandby();
}

/** 開始偵測（前景呼叫）→ 原生開始保活（v0.5：背景定位優先、靜音音訊備援）＋看門狗。回傳最新狀態。 */
export function armDetection(): DetectorStatus | null {
  try {
    return parseDetectorStatus(native?.armDetection?.());
  } catch {
    return null;
  }
}

/** v0.4：停止偵測 → 停保活、偵測卡結束（倒數中的卡保留給那張單） */
export async function stopDetection(): Promise<void> {
  if (!native?.stopDetection) return;
  await native.stopDetection();
}

/** v0.4：偵測狀態；舊版原生或非 iOS → null */
export function detectorStatus(): DetectorStatus | null {
  try {
    return parseDetectorStatus(native?.detectorStatus?.());
  } catch {
    return null;
  }
}

/** v0.6：原生遠端回報要帶的情境（OTA 更新 id 等）；舊版原生忽略 */
export function setTelemetryContext(ctx: { upd?: string }): void {
  try {
    native?.setTelemetryContext?.(JSON.stringify(ctx));
  } catch {
    // 舊版原生或非 iOS：忽略
  }
}

/** v0.4：訂閱原生偵測事件；回傳取消函式 */
export function addDetectorListener(fn: (ev: DetectorEvent) => void): () => void {
  try {
    const sub = native?.addListener?.('onDetectorSignal', fn);
    return () => sub?.remove();
  } catch {
    return () => undefined;
  }
}

export { BroadcastPicker, type BroadcastPickerHandle } from './BroadcastPicker';
