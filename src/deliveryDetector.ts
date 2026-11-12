// v0.7（需求 G）自動偵測送達：規則的 TS 版（純函式；Swift 在 WSL 不能跑，以這份測試為準）。
// ⚠️ 與 targets/broadcast/SampleHandler.swift 的 DeliveryEdge（extension：邊緣觸發＋60 秒不重送）、
//    modules/live-activity/ios/DetectorHub.swift 的 AutoDelivery（App：挑單＋手動/自動互斥）同一套規則。
//
// extension：畫面命中 delivery.completedKeywords（有接單鈕的邀請畫面不算）→ 「從沒有變成有」才送一次
//   Darwin com.pandatimer.delivered；連 2 次 OCR 沒命中才算這次出現結束；送過後 60 秒內再出現也不送。
// App：收到 delivered → 結「接單已超過 minOrderAgeSec 秒的進行中單」裡最早接單的那張（實際時間＝收到時間）；
//   90 秒內有手動結單（送達按鈕/捷徑/App 內按送達/取消）→ 不自動結（避免先手動、後看到完成畫面又結掉下一單）；
//   反之，自動結單後 20 秒內的動態島/捷徑送達 → 不再結（同時發生只結一次）。
// v0.8（首日實測：送達確認對話框「…是否已送達?／確認已送達」→ 按下後彈出「訂單完成」）：
//   extension：命中 finalKeywords（訂單完成）→ 以該時間送；只命中其他 completedKeywords（對話框）→ 先待定，
//   pendingSec（30）秒內出現「訂單完成」改用後者時間、否則到期以對話框時間送；廣播停止時待定的也照對話框時間送出
//   （首日 4 次停止有 2 次緊接在送達對話框之後）。送出前先送 com.pandatimer.delivered.delay.<秒>（0…60），App 2 秒內配對，
//   實際送達＝收到時間 − 秒數。
//   App：改結「截止時間最早」的進行中單（原為最早接單；夾單時較接近實際送序）。
import { DEFAULT_COMPLETED_KEYWORDS, DEFAULT_FINAL_KEYWORDS } from './screenInfo.ts';

export type DeliverySettings = {
  enabled: boolean;
  minOrderAgeSec: number;
  completedKeywords: string;
  /** v0.8 優先（看到就以該時間結單） */
  finalKeywords: string;
  /** v0.8 只看到確認對話框時等「訂單完成」的秒數（0＝不等，立刻送） */
  pendingSec: number;
};
export const DEFAULT_DELIVERY: Readonly<DeliverySettings> = Object.freeze({
  enabled: true,
  minOrderAgeSec: 120,
  completedKeywords: DEFAULT_COMPLETED_KEYWORDS,
  finalKeywords: DEFAULT_FINAL_KEYWORDS,
  pendingSec: 30,
});

/** 延遲訊號只編 0…60 秒 */
export const MAX_DELIVERED_DELAY = 60;

export const DELIVERY_GONE_AFTER_MISSES = 2;
export const DELIVERY_REPEAT_SEC = 60;
/** App：手動結單後這麼久內不自動結 */
export const MANUAL_GRACE_SEC = 90;
/** 動態島/捷徑送達：自動結單後這麼久內不再結 */
export const AUTO_GUARD_SEC = 20;

export type DeliveryAction =
  /** 送 delivered（delaySec＝實際送達在幾秒前；App 用收到時間 − delaySec） */
  | { kind: 'send'; delaySec: number; why: 'final' | 'immediate' | 'timeout' | 'stopped' | 'finalAfterPending' }
  /** 只看到確認對話框：待定 */
  | { kind: 'pending' }
  /** 新出現但 60 秒內送過（不送） */
  | { kind: 'repeat' };

const delayOf = (now: number, at: number) => Math.min(MAX_DELIVERED_DELAY, Math.max(0, Math.round(now - at)));

/** extension 端：送達畫面的邊緣觸發＋待定（時間單位：秒） */
export class DeliveryEdge {
  pendingSec: number;
  private visible = false;
  private misses = 0;
  private lastSentAt: number | null = null;
  private pendingAt: number | null = null;

  constructor(pendingSec = DEFAULT_DELIVERY.pendingSec) {
    this.pendingSec = pendingSec;
  }

  /** 待定到期時間（呼叫端排計時器；畫面靜止時不會有 OCR） */
  get deadline(): number | null {
    return this.pendingAt == null ? null : this.pendingAt + this.pendingSec;
  }

  /**
   * 每次 OCR 呼叫。hit＝命中任一送達關鍵字（含 final）；final＝命中 finalKeywords。
   * v0.7 相容：只傳 hit（final 省略）且 pendingSec=0 時行為同舊版（send/repeat/null）。
   */
  observe(now: number, hit: boolean, final = false): DeliveryAction | null {
    if (hit) {
      this.misses = 0;
      if (final && this.pendingAt != null) {
        // 對話框之後出現「訂單完成」→ 以現在（訂單完成）為準
        this.pendingAt = null;
        this.visible = true;
        this.lastSentAt = now;
        return { kind: 'send', delaySec: 0, why: 'finalAfterPending' };
      }
      if (this.visible) return this.tick(now);
      this.visible = true;
      if (this.lastSentAt != null && now - this.lastSentAt < DELIVERY_REPEAT_SEC) return { kind: 'repeat' };
      if (final || this.pendingSec <= 0) {
        this.lastSentAt = now;
        return { kind: 'send', delaySec: 0, why: final ? 'final' : 'immediate' };
      }
      this.pendingAt = now;
      return { kind: 'pending' };
    }
    if (this.visible) {
      this.misses += 1;
      if (this.misses >= DELIVERY_GONE_AFTER_MISSES) {
        this.visible = false;
        this.misses = 0;
      }
    }
    return this.tick(now);
  }

  /** 計時器/每次 OCR：待定到期 → 以對話框時間送 */
  tick(now: number): DeliveryAction | null {
    if (this.pendingAt == null || now - this.pendingAt < this.pendingSec) return null;
    return this.flush(now, 'timeout');
  }

  /** 廣播停止：待定的照對話框時間送出（停止常緊接在送達對話框之後） */
  finish(now: number): DeliveryAction | null {
    return this.pendingAt == null ? null : this.flush(now, 'stopped');
  }

  private flush(now: number, why: 'timeout' | 'stopped'): DeliveryAction {
    const at = this.pendingAt as number;
    this.pendingAt = null;
    this.lastSentAt = now;
    return { kind: 'send', delaySec: delayOf(now, at), why };
  }
}

export type ActiveLite = { id: string; acceptedAt: number; deadline: number };

/**
 * App 端：收到 delivered 時要結哪一單（時間：毫秒；now＝實際送達時間＝收到 − 延遲）。
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
  // v0.8：截止最早的先結（同截止取較早接單）；夾單時較接近實際送序
  let best: ActiveLite | null = null;
  for (const o of active) {
    if (now - o.acceptedAt < settings.minOrderAgeSec * 1000) continue;
    if (!best || o.deadline < best.deadline || (o.deadline === best.deadline && o.acceptedAt < best.acceptedAt)) best = o;
  }
  return best ? { id: best.id } : { skip: 'tooNew' };
}

/** 動態島/捷徑送達：自動結單後 AUTO_GUARD_SEC 秒內 → 擋掉（true＝不要再結） */
export function manualBlockedByAuto(lastAutoDoneAt: number | null, now: number): boolean {
  return lastAutoDoneAt != null && now - lastAutoDoneAt >= 0 && now - lastAutoDoneAt < AUTO_GUARD_SEC * 1000;
}
