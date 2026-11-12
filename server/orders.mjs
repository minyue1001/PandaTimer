// 熊貓倒數：訂單資料庫（node:sqlite，Node ≥22.13 免旗標）＋輸入白名單驗證＋同步合併（last-writer-wins）。
// 由 index.mjs 使用；零依賴。單一使用者（只有這位外送員），不分帳號。
//
// 表：
//   orders(id PK, acceptedAt, estimateMin, deliveredAt NULL, status, amount NULL, stacked, source, note,
//          updatedAt, deleted, editedBy, syncAt)
//   baselines(period PK, orders, onTimePct, overrunPct, income NULL, updatedAt, deleted, syncAt)
//   meta(key PK, value)：dbId（資料庫身分，App 用來偵測伺服器資料庫被重建）、syncCode、sessionKey
// updatedAt＝最後修改時間（LWW 比較用；App 端是手機時鐘、管理頁是伺服器時鐘）；
// syncAt＝伺服器指派、嚴格遞增的變更序（同步游標 since/now 用它，不受手機時鐘影響）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['active', 'delivered', 'canceled'];
export const SOURCES = ['manual', 'auto', 'import', 'confirm', 'admin'];
export const MAX_NOTE = 100;
export const MAX_ESTIMATE = 180;
export const MAX_AMOUNT = 100_000;
export const MAX_BASELINE_ORDERS = 2000;
export const MAX_INCOME = 10_000_000;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const PERIOD_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_TS = Date.UTC(2020, 0, 1);
const DAY = 86_400_000;
/** 接單/送達時間最多比伺服器現在晚 1 天（手機時鐘誤差＋時區錯誤保護） */
const TS_FUTURE = DAY;
/** updatedAt 最多比伺服器現在晚 10 分鐘：太未來的修改時間會永遠贏 LWW，直接拒收 */
const UPDATED_FUTURE = 10 * 60_000;
/** 一次回傳的變更上限（超過 → more:true，App 以回傳的 now 續拉） */
export const CHANGES_PAGE = 500;

const SYNC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I/O/0/1，手機好輸入

/** 同步碼：12 碼（60 bits），顯示成 XXXX-XXXX-XXXX */
export function newSyncCode() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (const b of bytes) s += SYNC_ALPHABET[b & 31];
  return s;
}
/** 使用者輸入 → 正規化（大寫、去掉空白與連字號）；不合法 → '' */
export function normalizeSyncCode(text) {
  const s = String(text ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return /^[A-Z0-9]{8,32}$/.test(s) ? s : '';
}
export const formatSyncCode = (s) => String(s).replace(/(.{4})(?=.)/g, '$1-');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const toBool = (x) => (x === true || x === 1 ? true : x === false || x === 0 || x == null ? false : null);

function cleanNote(x) {
  if (x == null) return '';
  if (typeof x !== 'string') return null;
  // 去掉控制字元（含換行）；過長 → 不合法（不默默截斷使用者的字）
  const s = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > MAX_NOTE ? null : s;
}

/**
 * 訂單（App 同步上傳或管理頁輸入，不可信）→ { ok:true, value } | { ok:false, error }。
 * 只取白名單欄位。App 的刪除墓碑可以只帶 { id, updatedAt, deleted:true } → value.tombstoneOnly。
 * opts.requireUpdatedAt=false（管理頁）時不檢查 updatedAt（由伺服器指派）。
 */
export function validateOrder(r, now, opts = {}) {
  const requireUpdatedAt = opts.requireUpdatedAt !== false;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: '不是物件' };
  const id = r.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'id 不合法' };
  let updatedAt = 0;
  if (requireUpdatedAt) {
    if (!isNum(r.updatedAt) || r.updatedAt < MIN_TS || r.updatedAt > now + UPDATED_FUTURE) return { ok: false, error: 'updatedAt 不合法' };
    updatedAt = Math.round(r.updatedAt);
  }
  const deleted = toBool(r.deleted);
  if (deleted == null) return { ok: false, error: 'deleted 不合法' };
  if (deleted && r.acceptedAt === undefined && r.status === undefined) {
    return { ok: true, value: { id, updatedAt, deleted: true, tombstoneOnly: true } };
  }
  if (!isNum(r.acceptedAt) || r.acceptedAt < MIN_TS || r.acceptedAt > now + TS_FUTURE) return { ok: false, error: 'acceptedAt 不合法' };
  const acceptedAt = Math.round(r.acceptedAt);
  if (!isNum(r.estimateMin) || r.estimateMin < 1 || r.estimateMin > MAX_ESTIMATE) return { ok: false, error: 'estimateMin 不合法（1~180）' };
  const estimateMin = Math.round(r.estimateMin * 10) / 10;
  if (!STATUSES.includes(r.status)) return { ok: false, error: 'status 不合法' };
  const status = r.status;
  let deliveredAt = null;
  if (r.deliveredAt != null) {
    if (!isNum(r.deliveredAt) || r.deliveredAt < acceptedAt - 5 * 60_000 || r.deliveredAt > acceptedAt + 7 * DAY || r.deliveredAt > now + TS_FUTURE) {
      return { ok: false, error: 'deliveredAt 不合法（要在接單之後、7 天內）' };
    }
    deliveredAt = Math.round(r.deliveredAt);
  }
  if (status === 'delivered' && deliveredAt == null) return { ok: false, error: '已送達的單要有 deliveredAt' };
  if (status === 'active') deliveredAt = null;
  let amount = null;
  if (r.amount != null) {
    if (!isNum(r.amount) || r.amount < 0 || r.amount > MAX_AMOUNT) return { ok: false, error: 'amount 不合法' };
    amount = Math.round(r.amount * 100) / 100;
  }
  const stacked = toBool(r.stacked);
  if (stacked == null) return { ok: false, error: 'stacked 不合法' };
  const source = r.source == null ? 'manual' : r.source;
  if (!SOURCES.includes(source)) return { ok: false, error: 'source 不合法' };
  const note = cleanNote(r.note);
  if (note == null) return { ok: false, error: `note 不合法（字串、≤${MAX_NOTE} 字）` };
  return { ok: true, value: { id, acceptedAt, estimateMin, deliveredAt, status, amount, stacked, source, note, updatedAt, deleted } };
}

/** 補登（period＝期別起日 YYYY-MM-DD；百分比 0~100） */
export function validateBaseline(r, now, opts = {}) {
  const requireUpdatedAt = opts.requireUpdatedAt !== false;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, error: '不是物件' };
  const period = r.period;
  if (typeof period !== 'string' || !PERIOD_RE.test(period) || !Number.isFinite(Date.parse(`${period}T00:00:00Z`))) {
    return { ok: false, error: 'period 不合法' };
  }
  let updatedAt = 0;
  if (requireUpdatedAt) {
    if (!isNum(r.updatedAt) || r.updatedAt < MIN_TS || r.updatedAt > now + UPDATED_FUTURE) return { ok: false, error: 'updatedAt 不合法' };
    updatedAt = Math.round(r.updatedAt);
  }
  const deleted = toBool(r.deleted);
  if (deleted == null) return { ok: false, error: 'deleted 不合法' };
  if (deleted && r.orders === undefined) {
    return { ok: true, value: { period, updatedAt, deleted: true, tombstoneOnly: true } };
  }
  const pct = (x) => isNum(x) && x >= 0 && x <= 100;
  if (!(Number.isInteger(r.orders) && r.orders >= 0 && r.orders <= MAX_BASELINE_ORDERS)) return { ok: false, error: 'orders 不合法（0~2000 的整數）' };
  if (!pct(r.onTimePct) || !pct(r.overrunPct)) return { ok: false, error: 'onTimePct/overrunPct 不合法（0~100）' };
  let income = null;
  if (r.income != null) {
    if (!isNum(r.income) || r.income < 0 || r.income > MAX_INCOME) return { ok: false, error: 'income 不合法' };
    income = Math.round(r.income * 100) / 100;
  }
  return {
    ok: true,
    value: { period, orders: r.orders, onTimePct: r.onTimePct, overrunPct: r.overrunPct, income, updatedAt, deleted },
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, acceptedAt INTEGER NOT NULL, estimateMin REAL NOT NULL, deliveredAt INTEGER,
  status TEXT NOT NULL, amount REAL, stacked INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
  editedBy TEXT NOT NULL DEFAULT 'app', syncAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS orders_syncAt ON orders(syncAt);
CREATE INDEX IF NOT EXISTS orders_acceptedAt ON orders(acceptedAt);
CREATE TABLE IF NOT EXISTS baselines(
  period TEXT PRIMARY KEY, orders INTEGER NOT NULL, onTimePct REAL NOT NULL, overrunPct REAL NOT NULL, income REAL,
  updatedAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, syncAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS baselines_syncAt ON baselines(syncAt);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const orderOut = (r) => ({
  id: r.id,
  acceptedAt: r.acceptedAt,
  estimateMin: r.estimateMin,
  deliveredAt: r.deliveredAt ?? null,
  status: r.status,
  amount: r.amount ?? null,
  stacked: !!r.stacked,
  source: r.source,
  note: r.note,
  updatedAt: r.updatedAt,
  deleted: !!r.deleted,
  editedBy: r.editedBy,
});
const baselineOut = (r) => ({
  period: r.period,
  orders: r.orders,
  onTimePct: r.onTimePct,
  overrunPct: r.overrunPct,
  income: r.income ?? null,
  updatedAt: r.updatedAt,
  deleted: !!r.deleted,
});

/**
 * 開資料庫。node:sqlite 不可用（Node 太舊）或開檔失敗 → 丟錯（呼叫端回 503，其他端點照常）。
 * seedSyncCode：meta 沒有同步碼時的初始值（deploy 腳本產生、server.env 的 SYNC_CODE）；沒給就隨機產生。
 */
export async function openStore(dbPath, { seedSyncCode = '' } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o750 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  return new Store(db, seedSyncCode);
}

export class Store {
  constructor(db, seedSyncCode) {
    this.db = db;
    const q = (sql) => db.prepare(sql);
    this.s = {
      getMeta: q('SELECT value FROM meta WHERE key = ?'),
      setMeta: q('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      getOrder: q('SELECT * FROM orders WHERE id = ?'),
      upsertOrder: q(`INSERT INTO orders(id, acceptedAt, estimateMin, deliveredAt, status, amount, stacked, source, note, updatedAt, deleted, editedBy, syncAt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET acceptedAt=excluded.acceptedAt, estimateMin=excluded.estimateMin, deliveredAt=excluded.deliveredAt,
          status=excluded.status, amount=excluded.amount, stacked=excluded.stacked, source=excluded.source, note=excluded.note,
          updatedAt=excluded.updatedAt, deleted=excluded.deleted, editedBy=excluded.editedBy, syncAt=excluded.syncAt`),
      tombOrder: q('UPDATE orders SET deleted = 1, updatedAt = ?, editedBy = ?, syncAt = ? WHERE id = ?'),
      setDeleted: q('UPDATE orders SET deleted = ?, updatedAt = ?, editedBy = ?, syncAt = ? WHERE id = ?'),
      ordersSince: q('SELECT * FROM orders WHERE syncAt > ? ORDER BY syncAt LIMIT ?'),
      ordersBetween: q('SELECT * FROM orders WHERE acceptedAt >= ? AND acceptedAt < ? ORDER BY acceptedAt DESC'),
      ordersBetweenLive: q('SELECT * FROM orders WHERE acceptedAt >= ? AND acceptedAt < ? AND deleted = 0 ORDER BY acceptedAt DESC'),
      getBaseline: q('SELECT * FROM baselines WHERE period = ?'),
      upsertBaseline: q(`INSERT INTO baselines(period, orders, onTimePct, overrunPct, income, updatedAt, deleted, syncAt) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(period) DO UPDATE SET orders=excluded.orders, onTimePct=excluded.onTimePct, overrunPct=excluded.overrunPct,
          income=excluded.income, updatedAt=excluded.updatedAt, deleted=excluded.deleted, syncAt=excluded.syncAt`),
      tombBaseline: q('UPDATE baselines SET deleted = 1, updatedAt = ?, syncAt = ? WHERE period = ?'),
      baselinesSince: q('SELECT * FROM baselines WHERE syncAt > ? ORDER BY syncAt'),
      baselinesAll: q('SELECT * FROM baselines ORDER BY period DESC'),
      maxSync: q('SELECT MAX(m) AS m FROM (SELECT MAX(syncAt) AS m FROM orders UNION ALL SELECT MAX(syncAt) FROM baselines)'),
      counts: q('SELECT COUNT(*) AS n, SUM(deleted) AS d FROM orders'),
    };
    this.clock = Number(this.s.maxSync.get()?.m ?? 0) || 0;
    if (!this.meta('dbId')) this.setMeta('dbId', crypto.randomBytes(9).toString('base64url'));
    if (!this.meta('sessionKey')) this.setMeta('sessionKey', crypto.randomBytes(32).toString('base64url'));
    if (!normalizeSyncCode(this.meta('syncCode'))) this.setMeta('syncCode', normalizeSyncCode(seedSyncCode) || newSyncCode());
  }

  meta(key) {
    return this.s.getMeta.get(key)?.value ?? null;
  }
  setMeta(key, value) {
    this.s.setMeta.run(key, String(value));
  }
  get dbId() {
    return this.meta('dbId');
  }
  get syncCode() {
    return this.meta('syncCode');
  }
  resetSyncCode() {
    const code = newSyncCode();
    this.setMeta('syncCode', code);
    return code;
  }

  /** 嚴格遞增的變更序 */
  tick() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已回滾 */ }
      throw e;
    }
  }

  #writeOrder(v, editedBy) {
    this.s.upsertOrder.run(
      v.id, v.acceptedAt, v.estimateMin, v.deliveredAt, v.status, v.amount, v.stacked ? 1 : 0, v.source, v.note,
      v.updatedAt, v.deleted ? 1 : 0, editedBy, this.tick(),
    );
  }
  #writeBaseline(v) {
    this.s.upsertBaseline.run(v.period, v.orders, v.onTimePct, v.overrunPct, v.income, v.updatedAt, v.deleted ? 1 : 0, this.tick());
  }

  /**
   * App 同步：changes 依 LWW 寫入（較新的 updatedAt 才寫；同時間＝伺服器為準），回傳 since 之後伺服器端有變動的資料
   * （不含本次被採用的那幾筆＝App 已經有了）。changes 裡不合法的筆數列在 invalid（App 放棄重送）。
   */
  sync({ since, orders = [], baselines = [] }, now = Date.now()) {
    const acceptedO = new Set();
    const acceptedB = new Set();
    const rejectedO = new Set(); // 伺服器較新而沒採用的 → 一定回傳伺服器版（就算它在 since 之前）
    const rejectedB = new Set();
    const invalid = [];
    this.tx(() => {
      for (const raw of orders) {
        const r = validateOrder(raw, now);
        if (!r.ok) {
          invalid.push({ kind: 'order', id: typeof raw?.id === 'string' ? raw.id.slice(0, 64) : null, error: r.error });
          continue;
        }
        const v = r.value;
        const cur = this.s.getOrder.get(v.id);
        if (cur && v.updatedAt <= cur.updatedAt) {
          rejectedO.add(v.id); // 伺服器較新（或同時間）→ 不採用，回傳伺服器版
          continue;
        }
        if (v.tombstoneOnly) {
          // 伺服器沒有這筆＝沒東西可刪（例如還沒同步就被刪掉的單）
          if (cur) this.s.tombOrder.run(v.updatedAt, 'app', this.tick(), v.id);
        } else this.#writeOrder(v, 'app');
        acceptedO.add(v.id);
      }
      for (const raw of baselines) {
        const r = validateBaseline(raw, now);
        if (!r.ok) {
          invalid.push({ kind: 'baseline', id: typeof raw?.period === 'string' ? raw.period.slice(0, 16) : null, error: r.error });
          continue;
        }
        const v = r.value;
        const cur = this.s.getBaseline.get(v.period);
        if (cur && v.updatedAt <= cur.updatedAt) {
          rejectedB.add(v.period);
          continue;
        }
        if (v.tombstoneOnly) {
          if (cur) this.s.tombBaseline.run(v.updatedAt, this.tick(), v.period);
        } else this.#writeBaseline(v);
        acceptedB.add(v.period);
      }
    });
    const from = Number.isFinite(since) && since > 0 && since <= this.clock ? since : 0;
    const rows = this.s.ordersSince.all(from, CHANGES_PAGE);
    const more = rows.length >= CHANGES_PAGE;
    const cursor = more ? rows[rows.length - 1].syncAt : this.clock;
    const bRows = this.s.baselinesSince.all(from).filter((b) => b.syncAt <= cursor);
    const seenO = new Set(rows.map((r) => r.id));
    for (const id of rejectedO) if (!seenO.has(id)) rows.push(this.s.getOrder.get(id));
    const seenB = new Set(bRows.map((r) => r.period));
    for (const p of rejectedB) if (!seenB.has(p)) bRows.push(this.s.getBaseline.get(p));
    return {
      now: cursor,
      more,
      dbId: this.dbId,
      // since 比伺服器游標還大＝伺服器資料庫被換過（或 App 帶了別台的游標）→ 從頭給
      reset: Number.isFinite(since) && since > this.clock,
      changes: {
        orders: rows.filter((o) => !acceptedO.has(o.id)).map(orderOut),
        baselines: bRows.filter((b) => !acceptedB.has(b.period)).map(baselineOut),
      },
      accepted: { orders: acceptedO.size, baselines: acceptedB.size },
      invalid,
    };
  }

  // ── 管理頁 ──
  listOrders(from, to, includeDeleted = false) {
    return (includeDeleted ? this.s.ordersBetween : this.s.ordersBetweenLive).all(from, to).map(orderOut);
  }
  getOrder(id) {
    const r = this.s.getOrder.get(id);
    return r ? orderOut(r) : null;
  }
  /** 管理頁的修改一律蓋過目前版本：updatedAt＝max(現在, 原本+1)（手機時鐘比伺服器快時也不會輸給舊值） */
  #adminStamp(cur) {
    return Math.max(Date.now(), (cur?.updatedAt ?? 0) + 1);
  }
  createOrder(fields) {
    const id = `admin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const r = validateOrder({ source: 'admin', ...fields, id, deleted: false }, Date.now(), { requireUpdatedAt: false });
    if (!r.ok) return r;
    const v = { ...r.value, updatedAt: this.#adminStamp(null) };
    this.tx(() => this.#writeOrder(v, 'admin'));
    return { ok: true, value: this.getOrder(id) };
  }
  updateOrder(id, fields) {
    return this.tx(() => {
      const cur = this.s.getOrder.get(id);
      if (!cur) return { ok: false, status: 404, error: '找不到這筆訂單' };
      const merged = { ...orderOut(cur), ...fields, id, deleted: !!cur.deleted };
      const r = validateOrder(merged, Date.now(), { requireUpdatedAt: false });
      if (!r.ok) return r;
      this.#writeOrder({ ...r.value, updatedAt: this.#adminStamp(cur) }, 'admin');
      return { ok: true, value: this.getOrder(id) };
    });
  }
  setOrderDeleted(id, deleted) {
    return this.tx(() => {
      const cur = this.s.getOrder.get(id);
      if (!cur) return { ok: false, status: 404, error: '找不到這筆訂單' };
      this.s.setDeleted.run(deleted ? 1 : 0, this.#adminStamp(cur), 'admin', this.tick(), id);
      return { ok: true, value: this.getOrder(id) };
    });
  }
  listBaselines() {
    return this.s.baselinesAll.all().map(baselineOut);
  }
  putBaseline(period, fields) {
    return this.tx(() => {
      const cur = this.s.getBaseline.get(period);
      const r = validateBaseline({ ...fields, period, deleted: false }, Date.now(), { requireUpdatedAt: false });
      if (!r.ok) return r;
      this.#writeBaseline({ ...r.value, updatedAt: this.#adminStamp(cur) });
      return { ok: true, value: baselineOut(this.s.getBaseline.get(period)) };
    });
  }
  deleteBaseline(period) {
    return this.tx(() => {
      const cur = this.s.getBaseline.get(period);
      if (!cur) return { ok: false, status: 404, error: '這期沒有補登' };
      this.s.tombBaseline.run(this.#adminStamp(cur), this.tick(), period);
      return { ok: true, value: baselineOut(this.s.getBaseline.get(period)) };
    });
  }
  stats() {
    const c = this.s.counts.get();
    return { orders: Number(c?.n ?? 0), deleted: Number(c?.d ?? 0) };
  }

  /** 每日備份（VACUUM INTO，留 keep 份）；失敗只記 log */
  backup(dir, dateStr, keep = 14) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
    const file = path.join(dir, `orders-${dateStr}.db`);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.tmp`;
      fs.rmSync(tmp, { force: true });
      this.db.prepare('VACUUM INTO ?').run(tmp);
      fs.renameSync(tmp, file);
    }
    const old = fs.readdirSync(dir).filter((n) => /^orders-\d{4}-\d{2}-\d{2}\.db$/.test(n)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - keep))) fs.rmSync(path.join(dir, n), { force: true });
  }

  close() {
    this.db.close();
  }
}
