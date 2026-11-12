// v0.8 訂單匯入 deep link（純函式，無 import 副作用）：讓主對話替使用者補記 App 沒偵測到的單。
//   pandatimer://import?d=<base64url(UTF-8 JSON)>
//   JSON：{"v":1,"orders":[{"acceptedAt":"2026-11-12T11:04:00+08:00","estimateMin":21,"deliveredAt":"2026-11-12T11:25:00+08:00",
//          "amount":85.76,"stacked":false,"note":"…"}]}
//   - deliveredAt 省略＝進行中 → 不匯入（列入 skipped）；amount/stacked/note 可省略。
//   - 時間：ISO 8601（帶 Z 或 ±HH:MM 時區；**沒寫時區＝台北 +08:00**）或毫秒數字。
//   - 任何一筆格式不對（缺欄位、時間反序、超出範圍）→ 整個連結拒絕（列出前幾個問題），避免只匯一半。
//   - 上限 200 筆。重複判定：與既有紀錄（或同批前面的列）acceptedAt 相差 ≤ 90 秒且 estimateMin 相同 → 不匯入。
// 產生連結：node scripts/make-import-link.mjs <orders.json>
import type { Order } from './orders';

export const IMPORT_PREFIX = 'pandatimer://import';
export const MAX_IMPORT_ORDERS = 200;
export const DUP_WINDOW_SEC = 90;
/** 實際分鐘上限（超過多半是日期打錯） */
export const MAX_ACTUAL_MIN = 300;
export const MAX_NOTE = 100;
const TAIPEI = '+08:00';

export type ImportRow = {
  acceptedAt: number;
  estimateMin: number;
  deliveredAt: number;
  amount?: number;
  stacked?: boolean;
  note?: string;
};

export type ImportParse =
  | { ok: true; rows: ImportRow[]; skippedActive: number }
  | { ok: false; error: string };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url（容忍 +/ 與 = 補位）→ 位元組；字元不合法 → null */
export function base64UrlToBytes(text: string): Uint8Array | null {
  const s = text.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    buf = (buf << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63].map((k) => B64[k]);
    out += chars.slice(0, i + 2 < bytes.length ? 4 : i + 1 < bytes.length ? 3 : 2).join('');
  }
  return out;
}

/** UTF-8 位元組 → 字串（不靠 TextDecoder：Hermes 版本差異）；不合法序列 → null */
export function utf8Decode(bytes: Uint8Array): string | null {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    let cp: number;
    let n: number;
    if (b < 0x80) [cp, n] = [b, 1];
    else if (b >= 0xc2 && b < 0xe0) [cp, n] = [b & 0x1f, 2];
    else if (b >= 0xe0 && b < 0xf0) [cp, n] = [b & 0x0f, 3];
    else if (b >= 0xf0 && b < 0xf5) [cp, n] = [b & 0x07, 4];
    else return null;
    if (i + n > bytes.length) return null;
    for (let k = 1; k < n; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if ((n === 3 && cp < 0x800) || (n === 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
    i += n;
  }
  return out;
}

export function utf8Encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/** ISO 8601（沒寫時區＝台北）或毫秒數字 → ms；不合法（含 2/30、25:00 這類）→ null */
export function parseImportTime(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 1e12 && v < 1e13 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = ISO.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s = '0', ms = '0'] = m.slice(1, 8).map((x) => (x == null ? undefined : x)) as string[];
  const nums = [y, mo, d, h, mi, s].map(Number);
  if (nums[1] < 1 || nums[1] > 12 || nums[2] < 1 || nums[3] > 23 || nums[4] > 59 || nums[5] > 59) return null;
  const local = Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5], Number(ms.padEnd(3, '0')));
  const check = new Date(local);
  if (check.getUTCDate() !== nums[2] || check.getUTCMonth() !== nums[1] - 1) return null; // 2/30 之類
  const tz = (m[8] ?? TAIPEI).toUpperCase();
  if (tz === 'Z') return local;
  const t = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
  if (!t || Number(t[2]) > 14 || Number(t[3]) > 59) return null;
  const offset = (Number(t[2]) * 60 + Number(t[3])) * 60_000 * (t[1] === '+' ? 1 : -1);
  return local - offset;
}

/** 已解碼的 JSON（不可信）→ 匯入列；任何一筆壞掉 → 整批拒絕 */
export function parseImportPayload(raw: unknown): ImportParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '內容不是 JSON 物件' };
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return { ok: false, error: `不支援的版本 v=${JSON.stringify(r.v)}（只認 1）` };
  if (!Array.isArray(r.orders) || r.orders.length === 0) return { ok: false, error: 'orders 要是非空陣列' };
  if (r.orders.length > MAX_IMPORT_ORDERS) return { ok: false, error: `一次最多 ${MAX_IMPORT_ORDERS} 筆（收到 ${r.orders.length} 筆）` };
  const rows: ImportRow[] = [];
  const problems: string[] = [];
  let skippedActive = 0;
  r.orders.forEach((item, i) => {
    const no = `第 ${i + 1} 筆`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return void problems.push(`${no} 不是物件`);
    const o = item as Record<string, unknown>;
    const acceptedAt = parseImportTime(o.acceptedAt);
    if (acceptedAt == null) return void problems.push(`${no} acceptedAt 缺漏或格式不對`);
    const est = o.estimateMin;
    if (!(typeof est === 'number' && Number.isInteger(est) && est >= 1 && est <= 180)) {
      return void problems.push(`${no} estimateMin 要是 1~180 的整數`);
    }
    if (o.deliveredAt == null) {
      skippedActive += 1; // 進行中不匯入
      return;
    }
    const deliveredAt = parseImportTime(o.deliveredAt);
    if (deliveredAt == null) return void problems.push(`${no} deliveredAt 格式不對`);
    if (deliveredAt <= acceptedAt) return void problems.push(`${no} 送達時間不晚於接單時間`);
    if (deliveredAt - acceptedAt > MAX_ACTUAL_MIN * 60_000) return void problems.push(`${no} 實際超過 ${MAX_ACTUAL_MIN} 分鐘（日期打錯？）`);
    const row: ImportRow = { acceptedAt, estimateMin: est, deliveredAt };
    if (o.amount != null) {
      if (!(typeof o.amount === 'number' && Number.isFinite(o.amount) && o.amount > 0 && o.amount <= 10_000)) {
        return void problems.push(`${no} amount 要是 0~10000 的數字`);
      }
      row.amount = o.amount;
    }
    if (o.stacked != null) {
      if (typeof o.stacked !== 'boolean') return void problems.push(`${no} stacked 要是 true/false`);
      if (o.stacked) row.stacked = true;
    }
    if (o.note != null) {
      if (typeof o.note !== 'string' || o.note.length > MAX_NOTE) return void problems.push(`${no} note 要是 ≤${MAX_NOTE} 字的字串`);
      if (o.note) row.note = o.note;
    }
    rows.push(row);
  });
  if (problems.length) {
    const more = problems.length > 3 ? `…等 ${problems.length} 個問題` : '';
    return { ok: false, error: problems.slice(0, 3).join('；') + more };
  }
  if (!rows.length) return { ok: false, error: `沒有可匯入的單（${skippedActive} 筆沒有送達時間＝進行中，不匯入）` };
  return { ok: true, rows, skippedActive };
}

/** deep link 字串 → 匯入列（不是 import 連結 → null） */
export function parseImportLink(url: string | null | undefined): ImportParse | null {
  if (!url) return null;
  const m = /^pandatimer:\/*import\/?(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  let d: string | null = null;
  for (const pair of (m[1] ?? '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === 'd') d = pair.slice(eq + 1);
  }
  if (!d) return { ok: false, error: '連結沒有 d= 資料' };
  try {
    d = decodeURIComponent(d);
  } catch {
    return { ok: false, error: '連結資料編碼壞掉' };
  }
  const bytes = base64UrlToBytes(d);
  const text = bytes && utf8Decode(bytes);
  if (text == null) return { ok: false, error: '資料不是合法的 base64url／UTF-8' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: '資料不是合法的 JSON' };
  }
  return parseImportPayload(json);
}

/** 主對話用：JSON 物件 → deep link（scripts/make-import-link.mjs） */
export function makeImportLink(payload: unknown): string {
  return `${IMPORT_PREFIX}?d=${bytesToBase64Url(utf8Encode(JSON.stringify(payload)))}`;
}

export type ImportPlan = {
  /** 要寫入的單（已轉成 Order，status delivered、source import） */
  add: Order[];
  /** 與既有紀錄或同批前面重複、不匯入的列 */
  duplicates: ImportRow[];
  /** 匯入範圍（台北日期 YYYY-MM-DD；add 為空 → null） */
  from: string | null;
  to: string | null;
};

const round1 = (x: number) => Math.round(x * 10) / 10;
const taipeiDate = (ms: number) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

/** 重複判定：acceptedAt 相差 ≤ 90 秒且 estimateMin 相同（不論狀態，含已取消） */
export function isDuplicate(a: { acceptedAt: number; estimateMin: number }, b: { acceptedAt: number; estimateMin: number }): boolean {
  return a.estimateMin === b.estimateMin && Math.abs(a.acceptedAt - b.acceptedAt) <= DUP_WINDOW_SEC * 1000;
}

export function planImport(existing: readonly Order[], rows: readonly ImportRow[]): ImportPlan {
  const add: Order[] = [];
  const duplicates: ImportRow[] = [];
  for (const row of rows) {
    if (existing.some((o) => isDuplicate(o, row)) || add.some((o) => isDuplicate(o, row))) {
      duplicates.push(row);
      continue;
    }
    const order: Order = {
      id: `${row.acceptedAt}-imp${row.estimateMin}`,
      acceptedAt: row.acceptedAt,
      estimateMin: row.estimateMin,
      deadline: row.acceptedAt + row.estimateMin * 60_000,
      status: 'delivered',
      deliveredAt: row.deliveredAt,
      actualMin: round1((row.deliveredAt - row.acceptedAt) / 60_000),
      source: 'import',
      ...(row.stacked ? { stacked: true } : {}),
      ...(row.amount != null ? { amount: row.amount } : {}),
      ...(row.note ? { note: row.note } : {}),
    };
    add.push(order);
  }
  const times = add.map((o) => o.acceptedAt);
  return {
    add,
    duplicates,
    from: times.length ? taipeiDate(Math.min(...times)) : null,
    to: times.length ? taipeiDate(Math.max(...times)) : null,
  };
}

/** 確認視窗內文 */
export function describeImport(plan: ImportPlan, skippedActive: number): string {
  const lines = [`匯入 ${plan.add.length} 筆已送達的單`];
  if (plan.from) lines.push(plan.from === plan.to ? `日期：${plan.from}` : `日期：${plan.from} ～ ${plan.to}`);
  if (plan.duplicates.length) lines.push(`與既有紀錄重複 ${plan.duplicates.length} 筆（不匯入）`);
  if (skippedActive) lines.push(`沒有送達時間 ${skippedActive} 筆（進行中，不匯入）`);
  const stacked = plan.add.filter((o) => o.stacked).length;
  if (stacked) lines.push(`其中夾單 ${stacked} 筆`);
  lines.push('匯入的單不會開動態島或通知；之後可用長按/管理紀錄刪除。');
  return lines.join('\n');
}
