import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

type LiveActivityNative = {
  isSupported(): boolean;
  start(estimateMinutes: number, deadlineMs: number): Promise<string>;
  end(id: string): Promise<void>;
  endAll(): Promise<void>;
  activeIds(): string[];
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
