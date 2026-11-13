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
// v1.1（11/13 三張疊單實測：送達被配錯單、「確認已送達」按鈕抵達就出現→還沒按就結單）：
//   delivery.mode "disappear"（預設）＝DeliveryWatch：看到送達確認對話框/按鈕（dialogKeywords）只記住，
//   **對話框/按鈕消失**（在 pandarider 畫面上連 2 次 OCR 沒有，或 1 次沒有且 1 秒內沒再出現）＝使用者按了確認 → 以第一次消失的時間送；
//   按鈕一直在＝還沒按 → 不送。對話框上讀到的「#單號」→ OrderNumberBook（src/orderNumbers.ts）找出接單 seq →
//   送 delivered.seq.<seq mod 4>，App 結那一張；讀不到/沒綁過 → 送舊的 delivered（App 退回截止最早）。
//   「訂單完成」：對話框顯示中/剛消失 → 立刻以它確認；60 秒內送過 → 不重送；從沒看到對話框 → 照舊送（退路）。
//   對話框不見了但同一 #單號還在畫面上（聊天/拍照/捲動）→ 不算消失。
//   "appear"＝v0.8 的 DeliveryEdge（completedKeywords＋pendingSec），遠端可切回。
import { DEFAULT_COMPLETED_KEYWORDS, DEFAULT_FINAL_KEYWORDS } from './screenInfo.ts';
import { DEFAULT_DIALOG_KEYWORDS } from './orderNumbers.ts';

export type DeliverySettings = {
  enabled: boolean;
  minOrderAgeSec: number;
  completedKeywords: string;
  /** v0.8 優先（看到就以該時間結單） */
  finalKeywords: string;
  /** v0.8 只看到確認對話框時等「訂單完成」的秒數（0＝不等，立刻送） */
  pendingSec: number;
  /** v1.1 disappear＝對話框/按鈕消失才送（DeliveryWatch）；appear＝v0.8 出現就送（DeliveryEdge） */
  mode: DeliveryMode;
  /** v1.1 送達確認對話框/按鈕字樣（正則，去空白文字比對） */
  dialogKeywords: string;
  /** v1.1 需要單號時（綁號中/對話框沒讀到號碼）另 OCR 畫面上方 numberScanTop~numberScanBottom（比例，由上往下） */
  numberScan: boolean;
  numberScanTop: number;
  numberScanBottom: number;
  /** v1.1 接單後多久內看到的新號碼可以綁給它（秒） */
  bindWindowSec: number;
};
export type DeliveryMode = 'disappear' | 'appear';
export const DELIVERY_MODES: readonly DeliveryMode[] = ['disappear', 'appear'];
export const DEFAULT_DELIVERY: Readonly<DeliverySettings> = Object.freeze({
  enabled: true,
  minOrderAgeSec: 120,
  completedKeywords: DEFAULT_COMPLETED_KEYWORDS,
  finalKeywords: DEFAULT_FINAL_KEYWORDS,
  pendingSec: 30,
  mode: 'disappear',
  dialogKeywords: DEFAULT_DIALOG_KEYWORDS,
  numberScan: true,
  numberScanTop: 0.05,
  numberScanBottom: 0.6,
  bindWindowSec: 300,
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

/** v1.1 對話框消失後：再 1 次 OCR 沒看到、或 1 秒內沒再出現，就算消失 */
export const DELIVERY_CONFIRM_SEC = 1;

export type WatchObservation = {
  /** 命中 dialogKeywords（是否已送達／確認已送達） */
  dialog: boolean;
  /** 命中 finalKeywords（訂單完成） */
  final: boolean;
  /** 畫面是 pandarider（away 特徵詞或接單鈕）；不是 → 這次不算消失（切到別的 App 不是按了確認） */
  panda: boolean;
  /** 對話框上的單號（OrderNumbers.deliveryNumber；主畫面＋上方補掃合併） */
  dialogNo: string | null;
  /** 這次 OCR 是因為畫面變了（不是同畫面強制重掃）；false → 1 次沒看到不啟動 1 秒計時（同一畫面 OCR 偶發漏字不算按了） */
  changed?: boolean;
  /** 畫面上的 #單號（主畫面＋補掃）：對話框不見了但同一單號還在畫面上（聊天/拍照/捲動）→ 不算消失 */
  numbers?: readonly string[];
};

export type WatchAction =
  /** 送 delivered（delaySec＝實際送達在幾秒前；no＝對話框上的單號，交給 OrderNumberBook.resolve） */
  | { kind: 'send'; delaySec: number; why: 'disappear' | 'final' | 'finalAfterDialog' | 'stopped'; no: string | null }
  /** 對話框/按鈕剛出現（不送，只回報） */
  | { kind: 'visible' }
  /** 「訂單完成」但 60 秒內送過 */
  | { kind: 'repeat' };

/** v1.1 extension 端（delivery.mode "disappear"）：對話框/按鈕消失＝按下確認（時間單位：秒） */
export class DeliveryWatch {
  private visible = false;
  private misses = 0;
  private firstMissAt: number | null = null;
  private timerArmed = false;
  private no: string | null = null;
  private lastSentAt: number | null = null;
  private finalOn = false;
  private finalMisses = 0;

  /** 對話框/按鈕顯示中（extension：補掃上方號碼、維持在 pandarider 模式） */
  get active(): boolean {
    return this.visible;
  }

  /** 剛消失、等確認的到期時間（呼叫端排計時器：畫面靜止時 ReplayKit 不送幀） */
  get deadline(): number | null {
    return this.visible && this.firstMissAt != null && this.timerArmed ? this.firstMissAt + DELIVERY_CONFIRM_SEC : null;
  }

  /** 顯示中已讀到單號（extension：讀到就不用再補掃） */
  get knowsNumber(): boolean {
    return this.no != null;
  }

  observe(now: number, o: WatchObservation): WatchAction | null {
    const finalEdge = this.finalEdge(o.final);
    if (o.dialog) {
      const first = !this.visible;
      this.visible = true;
      this.misses = 0;
      this.firstMissAt = null;
      this.timerArmed = false;
      if (o.dialogNo) this.no = o.dialogNo;
      if (o.final) return this.send(now, 'finalAfterDialog', 0);
      return first ? { kind: 'visible' } : null;
    }
    if (this.visible) {
      if (o.final) return this.send(now, 'finalAfterDialog', this.delayFrom(now));
      if (!o.panda) return this.tick(now); // 不在 pandarider（切 App、主畫面）：不算消失
      if (this.no != null && o.numbers?.includes(this.no)) {
        // 同一單號還在畫面上（還在這張單的頁面）→ 不算消失，已開始的確認也取消
        this.misses = 0;
        this.firstMissAt = null;
        this.timerArmed = false;
        return null;
      }
      this.misses += 1;
      if (this.firstMissAt == null) this.firstMissAt = now;
      if (o.changed !== false) this.timerArmed = true;
      if (this.misses >= DELIVERY_GONE_AFTER_MISSES) return this.send(now, 'disappear', this.delayFrom(now));
      return this.tick(now);
    }
    if (finalEdge) {
      if (this.lastSentAt != null && now - this.lastSentAt < DELIVERY_REPEAT_SEC) return { kind: 'repeat' };
      this.no = o.dialogNo;
      return this.send(now, 'final', 0);
    }
    return null;
  }

  /** 計時器：消失後 1 秒內沒再出現 → 送（時間＝第一次消失） */
  tick(now: number): WatchAction | null {
    if (this.visible && this.firstMissAt != null && this.timerArmed && now - this.firstMissAt >= DELIVERY_CONFIRM_SEC) {
      return this.send(now, 'disappear', this.delayFrom(now));
    }
    return null;
  }

  /** 廣播停止：剛消失、還在確認 → 送；按鈕還在（沒按）→ 不送 */
  finish(now: number): WatchAction | null {
    const out = this.visible && this.firstMissAt != null ? this.send(now, 'stopped', this.delayFrom(now)) : null;
    this.visible = false;
    this.misses = 0;
    this.firstMissAt = null;
    this.timerArmed = false;
    this.no = null;
    return out;
  }

  private delayFrom(now: number): number {
    return delayOf(now, this.firstMissAt ?? now);
  }

  /** 「訂單完成」邊緣（連 2 次沒看到才算消失） */
  private finalEdge(hit: boolean): boolean {
    if (hit) {
      this.finalMisses = 0;
      if (this.finalOn) return false;
      this.finalOn = true;
      return true;
    }
    if (this.finalOn && ++this.finalMisses >= DELIVERY_GONE_AFTER_MISSES) {
      this.finalOn = false;
      this.finalMisses = 0;
    }
    return false;
  }

  private send(now: number, why: 'disappear' | 'final' | 'finalAfterDialog' | 'stopped', delaySec: number): WatchAction {
    const no = this.no;
    this.visible = false;
    this.misses = 0;
    this.firstMissAt = null;
    this.timerArmed = false;
    this.no = null;
    this.lastSentAt = now;
    return { kind: 'send', delaySec, why, no };
  }
}

export type ActiveLite = { id: string; acceptedAt: number; deadline: number };

/**
 * App 端：收到 delivered 時要結哪一單（時間：毫秒；now＝實際送達時間＝收到 − 延遲）。
 * 回 { id } 或 { skip: 'disabled' | 'manualRecent' | 'noActive' | 'tooNew' | 'matchedGone' }
 * v1.1 matchedId：delivered.seq.<槽> 對到的單（App 記的「槽 → 訂單 id」）。對到 → 只結那張（不看 minOrderAge、手動互斥）；
 *   那張已不在進行中（已手動送達/取消）→ matchedGone（**不退回**挑別張，避免結錯）。undefined/null＝沒對到 → 原邏輯。
 */
export function pickDeliveredOrder(
  active: readonly ActiveLite[],
  now: number,
  settings: Pick<DeliverySettings, 'enabled' | 'minOrderAgeSec'>,
  lastManualDoneAt: number | null,
  matchedId?: string | null,
): { id: string } | { skip: 'disabled' | 'manualRecent' | 'noActive' | 'tooNew' | 'matchedGone' } {
  if (!settings.enabled) return { skip: 'disabled' };
  if (matchedId != null) return active.some((o) => o.id === matchedId) ? { id: matchedId } : { skip: 'matchedGone' };
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
