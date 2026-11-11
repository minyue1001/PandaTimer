// v0.7（需求 G）自動偵測送達：規則的 TS 版（純函式；Swift 在 WSL 不能跑，以這份測試為準）。
// ⚠️ 與 targets/broadcast/SampleHandler.swift 的 DeliveryEdge（extension：邊緣觸發＋60 秒不重送）、
//    modules/live-activity/ios/DetectorHub.swift 的 AutoDelivery（App：挑單＋手動/自動互斥）同一套規則。
//
// extension：畫面命中 delivery.completedKeywords（有接單鈕的邀請畫面不算）→ 「從沒有變成有」才送一次
//   Darwin com.pandatimer.delivered；連 2 次 OCR 沒命中才算這次出現結束；送過後 60 秒內再出現也不送。
// App：收到 delivered → 結「接單已超過 minOrderAgeSec 秒的進行中單」裡最早接單的那張（實際時間＝收到時間）；
//   90 秒內有手動結單（送達按鈕/捷徑/App 內按送達/取消）→ 不自動結（避免先手動、後看到完成畫面又結掉下一單）；
//   反之，自動結單後 20 秒內的動態島/捷徑送達 → 不再結（同時發生只結一次）。
import { DEFAULT_COMPLETED_KEYWORDS } from './screenInfo.ts';

export type DeliverySettings = { enabled: boolean; minOrderAgeSec: number; completedKeywords: string };
export const DEFAULT_DELIVERY: Readonly<DeliverySettings> = Object.freeze({
  enabled: true,
  minOrderAgeSec: 120,
  completedKeywords: DEFAULT_COMPLETED_KEYWORDS,
});

export const DELIVERY_GONE_AFTER_MISSES = 2;
export const DELIVERY_REPEAT_SEC = 60;
/** App：手動結單後這麼久內不自動結 */
export const MANUAL_GRACE_SEC = 90;
/** 動態島/捷徑送達：自動結單後這麼久內不再結 */
export const AUTO_GUARD_SEC = 20;

/** extension 端：送達畫面的邊緣觸發（時間單位：秒） */
export class DeliveryEdge {
  private visible = false;
  private misses = 0;
  private lastSentAt: number | null = null;

  /** 每次 OCR 呼叫；回 'send'＝送 delivered 訊號、'repeat'＝新出現但 60 秒內送過（不送）、null＝沒事 */
  observe(now: number, hit: boolean): 'send' | 'repeat' | null {
    if (hit) {
      this.misses = 0;
      if (this.visible) return null;
      this.visible = true;
      if (this.lastSentAt != null && now - this.lastSentAt < DELIVERY_REPEAT_SEC) return 'repeat';
      this.lastSentAt = now;
      return 'send';
    }
    if (this.visible) {
      this.misses += 1;
      if (this.misses >= DELIVERY_GONE_AFTER_MISSES) {
        this.visible = false;
        this.misses = 0;
      }
    }
    return null;
  }
}

export type ActiveLite = { id: string; acceptedAt: number };

/**
 * App 端：收到 delivered 時要結哪一單（時間：毫秒）。
 * 回 { id } 或 { skip: 'disabled' | 'manualRecent' | 'noActive' | 'tooNew' }
 */
export function pickDeliveredOrder(
  active: readonly ActiveLite[],
  now: number,
  settings: Pick<DeliverySettings, 'enabled' | 'minOrderAgeSec'>,
  lastManualDoneAt: number | null,
): { id: string } | { skip: 'disabled' | 'manualRecent' | 'noActive' | 'tooNew' } {
  if (!settings.enabled) return { skip: 'disabled' };
  if (lastManualDoneAt != null && now - lastManualDoneAt < MANUAL_GRACE_SEC * 1000) return { skip: 'manualRecent' };
  if (active.length === 0) return { skip: 'noActive' };
  let best: ActiveLite | null = null;
  for (const o of active) {
    if (now - o.acceptedAt < settings.minOrderAgeSec * 1000) continue;
    if (!best || o.acceptedAt < best.acceptedAt) best = o;
  }
  return best ? { id: best.id } : { skip: 'tooNew' };
}

/** 動態島/捷徑送達：自動結單後 AUTO_GUARD_SEC 秒內 → 擋掉（true＝不要再結） */
export function manualBlockedByAuto(lastAutoDoneAt: number | null, now: number): boolean {
  return lastAutoDoneAt != null && now - lastAutoDoneAt >= 0 && now - lastAutoDoneAt < AUTO_GUARD_SEC * 1000;
}
