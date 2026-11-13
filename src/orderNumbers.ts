// v1.1 以「#單號」配對送達（extension 端規則的 TS 版；純函式、時間單位：秒）。
// ⚠️ 與 targets/broadcast/OrderNumbers.swift 同一套規則（Swift 在 WSL 不能跑 → 以這份測試為準，改一邊改兩邊）。
//
// pandarider 畫面（11/13 使用者截圖）：接單後/取餐頁「#7318」「z0ja-2646-icgr - #7318 - 顧客名」；送餐頁頂部「#7318 · 顧客名」；
//   送達確認對話框「z0ja-2646-icgr(#7318) 是否已送達?」＋「確認已送達」「取消」。
// 流程：接單判定成功 → accepted(seq) 記一筆「還沒綁號」；之後接單後/取餐畫面（不是邀請、不是送達對話框）OCR 抓到
//   恰好 1 個「沒綁過、沒送過」的 #號 → 綁給最近一張還沒綁號（bindWindowSec 內接單）的 seq。
//   送達對話框消失 → resolve(號碼)：綁過且該 seq 的訊號槽（seq mod 4，與 order 訊號一致）沒被更新的單佔走 → 送 delivered.seq.<槽>；
//   否則（沒讀到號碼、號碼沒綁過、槽被佔）→ 送舊的 delivered（App 退回「截止最早」邏輯）。同一號碼 1 小時內只結一次。
// 隱私：號碼只活在 extension 記憶體，**不得上傳 telemetry**（只回報 matched=true/false 與原因）。
import { normalizeOcrText } from './ocrPick.ts';
import { SIGNAL_SEQ_MOD } from './detector.ts';
import { DEFAULT_FINAL_KEYWORDS } from './screenInfo.ts';

/** 「#7318」「＃ 7318」；後面不能再接數字（只收 1~5 位）。＝Swift OrderNumbers.numberPattern */
export const ORDER_NO_PATTERN = '[#＃]\\s*([0-9]{1,5})(?![0-9])';
/** 對話框問句「…(#7318) 是否已送達?」：號碼緊接在「是否已送達」前（中間可有右括號與空白、換行）。＝Swift dialogNumberPattern */
export const DIALOG_NO_PATTERN = '[#＃]\\s*([0-9]{1,5})\\s*[)）]?\\s*是否已?送[達达]';
const NUMBER_RX = new RegExp(ORDER_NO_PATTERN, 'g');
const DIALOG_NUMBER_RX = new RegExp(DIALOG_NO_PATTERN);

/** 預設的送達確認對話框/按鈕字樣（delivery.dialogKeywords；去空白文字比對） */
export const DEFAULT_DIALOG_KEYWORDS = '是否已送達|是否已送达|確認已送達|确认已送达';

/** 單號正規化：去前導 0；0 不算 */
function canon(digits: string): string | null {
  const n = Number(digits);
  return Number.isInteger(n) && n > 0 ? String(n) : null;
}

/** OCR 文字裡所有「#單號」（出現順序、去重） */
export function extractOrderNumbers(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const m of normalizeOcrText(raw).matchAll(NUMBER_RX)) {
    const n = canon(m[1]);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** 送達對話框的單號：先找緊接「是否已送達」的；找不到且畫面上只有一個 #號 → 用它；否則 null */
export function deliveryNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = DIALOG_NUMBER_RX.exec(normalizeOcrText(raw));
  if (m) return canon(m[1]);
  const all = extractOrderNumbers(raw);
  return all.length === 1 ? all[0] : null;
}

const dialogRx = new Map<string, RegExp | null>();
/** 命中送達確認對話框/按鈕（去空白文字；pattern 編不過 → 預設；空字串命中不算） */
export function hasDeliveryDialog(raw: string | null | undefined, pattern: string = DEFAULT_DIALOG_KEYWORDS): boolean {
  return matchesPattern(raw, pattern, DEFAULT_DIALOG_KEYWORDS);
}

/** 去空白文字命中 pattern（編不過 → fallback；空字串命中不算） */
function matchesPattern(raw: string | null | undefined, pattern: string, fallback: string): boolean {
  if (!raw) return false;
  const compact = normalizeOcrText(raw).replace(/\s+/g, '');
  const compile = (p: string) => {
    if (!dialogRx.has(p)) {
      let r: RegExp | null = null;
      try {
        r = new RegExp(p, '');
      } catch {
        r = null;
      }
      dialogRx.set(p, r);
    }
    return dialogRx.get(p) ?? null;
  };
  const r = compile(pattern) ?? compile(fallback);
  const m = r?.exec(compact);
  return !!m && m[0].length > 0;
}

/** final＝命中 finalKeywords（「訂單完成」彈窗在畫面上半部，主 OCR 看不到 → 補掃也要看） */
export type NumberScan = { numbers: string[]; dialogNo: string | null; dialog: boolean; final: boolean };

/** 一段 OCR 文字 → 號碼摘要（原文不離開這裡；Swift OrderNumbers.scan） */
export function scanNumbers(
  raw: string | null | undefined,
  dialogPattern: string = DEFAULT_DIALOG_KEYWORDS,
  finalPattern: string = DEFAULT_FINAL_KEYWORDS,
): NumberScan {
  return {
    numbers: extractOrderNumbers(raw),
    dialogNo: deliveryNumber(raw),
    dialog: hasDeliveryDialog(raw, dialogPattern),
    final: matchesPattern(raw, finalPattern, DEFAULT_FINAL_KEYWORDS),
  };
}

/** 主畫面（下半部）＋補掃（上半部）合併：號碼聯集、對話框號碼補掃優先（問句在上半部） */
export function mergeScans(main: NumberScan, extra: NumberScan | null): NumberScan {
  if (!extra) return main;
  const numbers = [...main.numbers];
  for (const n of extra.numbers) if (!numbers.includes(n)) numbers.push(n);
  return {
    numbers, dialogNo: extra.dialogNo ?? main.dialogNo, dialog: main.dialog || extra.dialog, final: main.final || extra.final,
  };
}

export type BookEntry = { seq: number; acceptedAt: number; no: string | null };

export type Resolution =
  | { kind: 'seq'; seq: number; slot: number }
  /** noNumber：沒讀到號碼；unbound：號碼沒綁過；slotReused：同槽已有更新的單（App 那個槽指向新單了） */
  | { kind: 'plain'; reason: 'noNumber' | 'unbound' | 'slotReused' }
  /** 這個號碼 1 小時內已經送過 */
  | { kind: 'repeat' };

export const BIND_WINDOW_SEC = 300;
/** 同一號碼不重送的時間 */
export const SENT_KEEP_SEC = 3600;
/** 接單紀錄保留（超過就丟） */
export const ENTRY_KEEP_SEC = 4 * 3600;
export const MAX_ENTRIES = 16;
/** 號碼要在接單（邀請消失）之後才第一次出現，才能綁給那張單（之前就在畫面上的＝別張單，例如廣播重開前接的） */
export const BIND_FIRST_SEEN_GRACE_SEC = 2;

export const slotOf = (seq: number) => ((seq % SIGNAL_SEQ_MOD) + SIGNAL_SEQ_MOD) % SIGNAL_SEQ_MOD;

export class OrderNumberBook {
  bindWindowSec: number;
  private entries: BookEntry[] = [];
  private sent = new Map<string, number>();
  /** 每個號碼第一次出現在畫面上的時間（綁定用：接單前就看過的號碼不綁給新單） */
  private firstSeen = new Map<string, number>();

  constructor(bindWindowSec = BIND_WINDOW_SEC) {
    this.bindWindowSec = bindWindowSec;
  }

  /** 測試/診斷用快照 */
  get list(): readonly BookEntry[] {
    return this.entries;
  }

  /** 接單訊號送出（App 有收到這個 seq）→ 記一筆還沒綁號 */
  accepted(seq: number, at: number): void {
    this.prune(at);
    this.entries = this.entries.filter((e) => e.seq !== seq);
    this.entries.push({ seq, acceptedAt: at, no: null });
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
  }

  /** 還有 bindWindowSec 內接單、還沒綁號的單（extension 據此決定要不要補掃上半部） */
  pendingBind(now: number): boolean {
    return this.entries.some((e) => e.no == null && now - e.acceptedAt <= this.bindWindowSec);
  }

  private sentRecently(no: string, now: number): boolean {
    const at = this.sent.get(no);
    return at != null && now - at < SENT_KEEP_SEC;
  }

  /** 每次 OCR 都呼叫：記下號碼第一次出現的時間 */
  see(now: number, numbers: readonly string[]): void {
    for (const n of numbers) if (!this.firstSeen.has(n)) this.firstSeen.set(n, now);
  }

  /**
   * 接單後/取餐畫面的號碼 → 綁定。只在「恰好 1 個沒綁過、沒送過的號碼」時綁給最近一張（seq 最大）還沒綁號的單，
   * 且該號碼第一次出現不早於那張單的接單時間（−2 秒）。回傳綁到的 seq 與「接單到綁定」秒數；沒綁 → null。
   */
  bind(now: number, numbers: readonly string[]): { seq: number; waitSec: number } | null {
    this.prune(now);
    this.see(now, numbers);
    const candidates = numbers.filter((n) => !this.entries.some((e) => e.no === n) && !this.sentRecently(n, now));
    if (candidates.length !== 1) return null;
    let target: BookEntry | null = null;
    for (const e of this.entries) {
      if (e.no != null || now - e.acceptedAt > this.bindWindowSec) continue;
      if (!target || e.seq > target.seq) target = e;
    }
    if (!target) return null;
    const first = this.firstSeen.get(candidates[0]) ?? now;
    if (first < target.acceptedAt - BIND_FIRST_SEEN_GRACE_SEC) return null;
    target.no = candidates[0];
    return { seq: target.seq, waitSec: Math.round((now - target.acceptedAt) * 10) / 10 };
  }

  /** 送達時：號碼 → 要送哪種訊號 */
  resolve(now: number, no: string | null): Resolution {
    this.prune(now);
    if (no == null) return { kind: 'plain', reason: 'noNumber' };
    if (this.sentRecently(no, now)) return { kind: 'repeat' };
    const entry = this.entries.find((e) => e.no === no);
    if (!entry) return { kind: 'plain', reason: 'unbound' };
    const slot = slotOf(entry.seq);
    if (this.entries.some((e) => e.seq > entry.seq && slotOf(e.seq) === slot)) return { kind: 'plain', reason: 'slotReused' };
    return { kind: 'seq', seq: entry.seq, slot };
  }

  /** 送出後：記住號碼（1 小時不重送）、移除該單 */
  markSent(now: number, no: string | null, seq: number | null): void {
    if (no != null) this.sent.set(no, now);
    if (seq != null) this.entries = this.entries.filter((e) => e.seq !== seq);
    else if (no != null) this.entries = this.entries.filter((e) => e.no !== no);
  }

  private prune(now: number): void {
    this.entries = this.entries.filter((e) => now - e.acceptedAt < ENTRY_KEEP_SEC);
    for (const [no, at] of this.sent) if (now - at >= SENT_KEEP_SEC) this.sent.delete(no);
    for (const [no, at] of this.firstSeen) if (now - at >= ENTRY_KEEP_SEC) this.firstSeen.delete(no);
  }
}
