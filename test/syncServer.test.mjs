// 訂單雲端同步＋管理頁（server/index.mjs＋server/orders.mjs）本機實跑：子程序起在 127.0.0.1 隨機埠，資料庫在暫存目錄；
// 結束只 kill 自己起的 PID。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/orders.mjs';

const SERVER = new URL('../server/index.mjs', import.meta.url).pathname;
const PW = 'correct-horse-battery';
const READ_KEY = 'read-key-0123456789abcdef0123456789';
const SEED = 'ABCD-EFGH-JKLM';
const procs = [];
let tmp;
let base;

async function startServer(name, extraEnv = {}) {
  const dir = path.join(tmp, name);
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: '0',
      UPDATES_DIR: path.join(dir, 'updates'),
      TELEMETRY_DIR: path.join(dir, 'telemetry'),
      CONFIG_PATH: path.join(dir, 'config.json'),
      DATA_DIR: path.join(dir, 'data'),
      TELEMETRY_WRITE_KEY: 'write-key-0123456789abcdef0123456789',
      TELEMETRY_READ_KEY: READ_KEY,
      ADMIN_PASSWORD: PW,
      SYNC_CODE: SEED,
      ADMIN_COOKIE_SECURE: '0',
      SYNC_RATE_PER_MIN: '1000',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server 沒起來：${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`server 結束 code=${code}：${out}`)));
  });
  return { url: `http://127.0.0.1:${port}`, logs: () => out + err, dir, child };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sync-test-'));
  base = (await startServer('main')).url;
});
after(() => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 10, 12, 3, 0, 0); // 2026-11-12 11:00 台北
const order = (id, extra = {}) => ({
  id,
  acceptedAt: T0,
  estimateMin: 20,
  deliveredAt: T0 + 18 * 60_000,
  status: 'delivered',
  amount: 81.67,
  stacked: false,
  source: 'auto',
  note: '',
  updatedAt: T0 + 18 * 60_000,
  deleted: false,
  ...extra,
});

async function sync(body, code = SEED, url = base) {
  const res = await fetch(`${url}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(code != null ? { 'x-pt-sync': code } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
}

async function login(url = base, password = PW) {
  const res = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const set = res.headers.get('set-cookie') || '';
  return { status: res.status, body: await res.json(), setCookie: set, cookie: set.split(';')[0] };
}

async function admin(cookie) {
  const s = await (await fetch(`${base}/api/admin/session`, { headers: { cookie } })).json();
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}/api/admin/${p}`, {
      method,
      headers: { cookie, 'x-pt-csrf': s.csrf, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* CSV 等 */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  return { session: s, call };
}

test('sync：沒帶碼／錯碼 → 401；GET → 405；壞 JSON → 400', async () => {
  assert.equal((await sync({ since: 0 }, null)).status, 401);
  assert.equal((await sync({ since: 0 }, 'WRONG-CODE-XXXX')).status, 401);
  assert.equal((await fetch(`${base}/api/sync`)).status, 405);
  assert.equal((await sync('{nope')).status, 400);
  assert.equal((await sync({ changes: [] })).status, 400);
});

test('sync：同步碼大小寫、空白、連字號都接受（server.env 的 SYNC_CODE 當初始值）', async () => {
  const r = await sync({ since: 0, changes: {} }, ' abcd efgh-jklm ');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.dbId, 'string');
});

test('sync：上傳 → 回應不含剛被採用的；since=0 再拉拿得到；同 updatedAt 重送＝伺服器為準', async () => {
  const r = await sync({ since: 0, changes: { orders: [order('a1'), order('a2', { stacked: true, note: '夾單一起送' })] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.accepted, { orders: 2, baselines: 0 });
  assert.ok(!r.body.changes.orders.some((o) => o.id === 'a1' || o.id === 'a2'));
  const again = await sync({ since: r.body.now, changes: {} });
  assert.equal(again.body.changes.orders.length, 0, '游標之後沒有變動');
  const all = await sync({ since: 0, changes: {} });
  const a2 = all.body.changes.orders.find((o) => o.id === 'a2');
  assert.equal(a2.stacked, true);
  assert.equal(a2.note, '夾單一起送');
  assert.equal(a2.editedBy, 'app');
  const same = await sync({ since: r.body.now, changes: { orders: [order('a1', { estimateMin: 99 })] } });
  assert.equal(same.body.accepted.orders, 0, '同 updatedAt 不採用');
  assert.equal(same.body.changes.orders.find((o) => o.id === 'a1').estimateMin, 20, '回傳伺服器版');
});

test('sync：LWW——較新的覆蓋、較舊的被拒並回傳伺服器版', async () => {
  await sync({ since: 0, changes: { orders: [order('b1')] } });
  const newer = await sync({ since: 0, changes: { orders: [order('b1', { estimateMin: 25, updatedAt: T0 + 30 * 60_000 })] } });
  assert.equal(newer.body.accepted.orders, 1);
  const older = await sync({ since: newer.body.now, changes: { orders: [order('b1', { estimateMin: 15, updatedAt: T0 + 20 * 60_000 })] } });
  assert.equal(older.body.accepted.orders, 0);
  const srv = older.body.changes.orders.find((o) => o.id === 'b1');
  assert.equal(srv.estimateMin, 25);
  assert.equal(srv.updatedAt, T0 + 30 * 60_000);
});

test('sync：刪除墓碑（只帶 id/updatedAt/deleted）→ 伺服器標 deleted；管理列表預設不含、deleted=1 才有；不存在的 id 也算採用', async () => {
  await sync({ since: 0, changes: { orders: [order('c1')] } });
  const r = await sync({ since: 0, changes: { orders: [{ id: 'c1', updatedAt: T0 + 40 * 60_000, deleted: true }, { id: 'never-synced', updatedAt: T0 + 40 * 60_000, deleted: true }] } });
  assert.equal(r.body.accepted.orders, 2);
  const live = await (await fetch(`${base}/api/admin/orders?from=2026-11-12&to=2026-11-12`, { headers: { 'x-pt-read': READ_KEY } })).json();
  assert.ok(!live.orders.some((o) => o.id === 'c1'));
  const withDel = await (await fetch(`${base}/api/admin/orders?from=2026-11-12&to=2026-11-12&deleted=1`, { headers: { 'x-pt-read': READ_KEY } })).json();
  const c1 = withDel.orders.find((o) => o.id === 'c1');
  assert.equal(c1.deleted, true);
  assert.equal(c1.estimateMin, 20, '墓碑保留原欄位（管理頁可還原）');
  assert.ok(!withDel.orders.some((o) => o.id === 'never-synced'));
});

test('sync：輸入白名單驗證——不合法的列在 invalid、其他照收；多餘欄位丟掉', async () => {
  const bad = [
    order('d-bad1', { estimateMin: 0 }),
    order('d-bad2', { status: 'weird' }),
    order('d-bad3', { note: 'x'.repeat(101) }),
    order('d-bad4', { updatedAt: Date.now() + 3_600_000 }),
    order('d bad5'),
    order('d-bad6', { status: 'delivered', deliveredAt: null }),
    order('d-bad7', { source: 'hacker' }),
    order('d-bad8', { deliveredAt: T0 - 3_600_000 }),
  ];
  const r = await sync({ since: 0, changes: { orders: [...bad, order('d-ok', { evil: '<script>', note: '有\n換行' })] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted.orders, 1);
  assert.equal(r.body.invalid.length, bad.length);
  const all = await sync({ since: 0, changes: {} });
  const ok = all.body.changes.orders.find((o) => o.id === 'd-ok');
  assert.equal(ok.evil, undefined);
  assert.equal(ok.note, '有 換行');
});

test('sync：超過 64KB → 413；超過 300 筆 → 413', async () => {
  const many = Array.from({ length: 301 }, (_, i) => ({ id: `z${i}`, updatedAt: T0, deleted: true }));
  assert.equal((await sync({ since: 0, changes: { orders: many } })).status, 413);
  const big = { since: 0, changes: { orders: [order('big', { note: 'x' })] }, pad: 'y'.repeat(70 * 1024) };
  assert.equal((await sync(big)).status, 413);
});

test('sync：補登 baselines 同步（百分比 0~100、墓碑）', async () => {
  const b = { period: '2026-11-09', orders: 40, onTimePct: 45.5, overrunPct: 18, income: 3200, updatedAt: T0, deleted: false };
  const r = await sync({ since: 0, changes: { baselines: [b, { ...b, period: '2026-13-40' }] } });
  assert.equal(r.body.accepted.baselines, 1);
  assert.equal(r.body.invalid.length, 1);
  const del = await sync({ since: 0, changes: { baselines: [{ period: '2026-11-09', updatedAt: T0 + 1000, deleted: true }] } });
  assert.equal(del.body.accepted.baselines, 1);
  const all = await sync({ since: 0, changes: {} });
  const got = all.body.changes.baselines.find((x) => x.period === '2026-11-09');
  assert.equal(got.deleted, true);
  assert.equal(got.orders, 40);
});

test('sync：變更超過一頁（500）→ more:true，用回傳的 now 續拉拿到其餘', async () => {
  const s = await startServer('paging');
  const mk = (n, off) => Array.from({ length: n }, (_, i) => order(`p${off + i}`, { acceptedAt: T0 + (off + i) * 1000 }));
  assert.equal((await sync({ since: 0, changes: { orders: mk(300, 0) } }, SEED, s.url)).body.accepted.orders, 300);
  assert.equal((await sync({ since: 0, changes: { orders: mk(300, 300) } }, SEED, s.url)).body.accepted.orders, 300);
  const p1 = await sync({ since: 0, changes: {} }, SEED, s.url);
  assert.equal(p1.body.more, true);
  assert.equal(p1.body.changes.orders.length, 500);
  const p2 = await sync({ since: p1.body.now, changes: {} }, SEED, s.url);
  assert.equal(p2.body.more, false);
  assert.equal(p2.body.changes.orders.length, 100);
  const ids = new Set([...p1.body.changes.orders, ...p2.body.changes.orders].map((o) => o.id));
  assert.equal(ids.size, 600);
  // 游標比伺服器還新（資料庫換過）→ reset:true 且從頭給
  const future = await sync({ since: p2.body.now + 10 ** 9, changes: {} }, SEED, s.url);
  assert.equal(future.body.reset, true);
  assert.equal(future.body.changes.orders.length, 500);
});

test('admin：GET /admin 回 HTML＋CSP nonce＋防框架；HEAD 也行', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  const html = await res.text();
  const csp = res.headers.get('content-security-policy');
  const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
  assert.ok(nonce);
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  assert.ok(!html.includes('__NONCE__'));
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${base}/admin/`)).status, 200);
});

test('admin：未登入 → 401；密碼錯 → 401；正確 → HttpOnly/SameSite=Strict/Path/Max-Age 12h 的 cookie', async () => {
  assert.equal((await fetch(`${base}/api/admin/session`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/orders`)).status, 401);
  assert.equal((await fetch(`${base}/api/admin/session`, { headers: { cookie: 'pt_admin=v1.AAAAAAAAAAAAAAAA.9999999999999.' + 'A'.repeat(43) } })).status, 401);
  const bad = await login(base, 'wrong-password');
  assert.equal(bad.status, 401);
  const ok = await login();
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /^pt_admin=v1\./);
  assert.match(ok.setCookie, /HttpOnly/);
  assert.match(ok.setCookie, /SameSite=Strict/);
  assert.match(ok.setCookie, /Path=\/pandatimer/);
  assert.match(ok.setCookie, /Max-Age=43200/);
  const s = await (await fetch(`${base}/api/admin/session`, { headers: { cookie: ok.cookie } })).json();
  assert.equal(typeof s.csrf, 'string');
  assert.equal(s.syncCode, SEED);
});

test('admin：寫入沒有 CSRF／CSRF 錯／非 JSON／跨站 Origin → 拒絕；讀取金鑰不能寫', async () => {
  const { cookie } = await login();
  const { call } = await admin(cookie);
  const body = JSON.stringify({ acceptedAt: T0, estimateMin: 18, status: 'delivered', deliveredAt: T0 + 600_000 });
  const post = (headers) => fetch(`${base}/api/admin/orders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ 'x-pt-csrf': 'nope' })).status, 403);
  const csrf = (await admin(cookie)).session.csrf;
  assert.equal((await post({ 'x-pt-csrf': csrf, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ 'x-pt-csrf': csrf, origin: 'https://evil.example' })).status, 403);
  const viaKey = await fetch(`${base}/api/admin/orders`, { method: 'POST', headers: { 'x-pt-read': READ_KEY, 'content-type': 'application/json' }, body });
  assert.equal(viaKey.status, 401);
  assert.equal((await call('POST', 'orders', JSON.parse(body))).status, 200);
});

test('admin：新增/編輯/刪除/還原 → App 下次同步拿得到（editedBy=admin、updatedAt 蓋過手機較快的時鐘）', async () => {
  const phoneAhead = Date.now() + 5 * 60_000; // 手機時鐘快 5 分鐘
  const first = await sync({ since: 0, changes: { orders: [order('e1', { updatedAt: phoneAhead })] } });
  const cursor = first.body.now;
  const { call } = await admin((await login()).cookie);
  const ed = await call('PUT', 'orders/e1', { estimateMin: 30, amount: 122.51, note: '改預估', status: 'delivered', id: 'hijack', updatedAt: 1 });
  assert.equal(ed.status, 200);
  assert.equal(ed.body.order.id, 'e1');
  assert.equal(ed.body.order.editedBy, 'admin');
  assert.ok(ed.body.order.updatedAt > phoneAhead);
  const bad = await call('PUT', 'orders/e1', { status: 'delivered', deliveredAt: null });
  assert.equal(bad.status, 400);
  assert.equal((await call('PUT', 'orders/nope', { estimateMin: 3 })).status, 404);
  const pulled = await sync({ since: cursor, changes: {} });
  const e1 = pulled.body.changes.orders.find((o) => o.id === 'e1');
  assert.equal(e1.estimateMin, 30);
  assert.equal(e1.note, '改預估');
  // App 拿舊版本回推 → 不得覆蓋管理頁的修改
  const stale = await sync({ since: pulled.body.now, changes: { orders: [order('e1', { updatedAt: phoneAhead })] } });
  assert.equal(stale.body.accepted.orders, 0);
  const del = await call('DELETE', 'orders/e1');
  assert.equal(del.body.order.deleted, true);
  const res = await call('POST', 'orders/e1/restore');
  assert.equal(res.body.order.deleted, false);
  const created = await call('POST', 'orders', { acceptedAt: T0, estimateMin: 12, status: 'canceled' });
  assert.equal(created.status, 200);
  assert.equal(created.body.order.source, 'admin');
  assert.match(created.body.order.id, /^admin-/);
  const pulled2 = await sync({ since: pulled.body.now, changes: {} });
  assert.ok(pulled2.body.changes.orders.some((o) => o.id === created.body.order.id));
  assert.equal(pulled2.body.changes.orders.find((o) => o.id === 'e1').deleted, false);
});

test('admin：補登 PUT/DELETE、同步碼重設（舊碼 401、新碼可用）', async () => {
  const s = await startServer('reset');
  const lg = await login(s.url);
  const sess = await (await fetch(`${s.url}/api/admin/session`, { headers: { cookie: lg.cookie } })).json();
  const h = { cookie: lg.cookie, 'x-pt-csrf': sess.csrf, 'content-type': 'application/json' };
  const put = await fetch(`${s.url}/api/admin/baselines/2026-11-09`, { method: 'PUT', headers: h, body: JSON.stringify({ orders: 30, onTimePct: 50, overrunPct: 10, income: null }) });
  assert.equal(put.status, 200);
  assert.equal((await fetch(`${s.url}/api/admin/baselines/2026-11-09`, { method: 'PUT', headers: h, body: JSON.stringify({ orders: 30, onTimePct: 150, overrunPct: 10 }) })).status, 400);
  const pulled = await sync({ since: 0, changes: {} }, SEED, s.url);
  assert.equal(pulled.body.changes.baselines[0].onTimePct, 50);
  const reset = await (await fetch(`${s.url}/api/admin/sync-code/reset`, { method: 'POST', headers: h, body: '{}' })).json();
  assert.match(reset.syncCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.notEqual(reset.syncCode, SEED);
  assert.equal((await sync({ since: 0, changes: {} }, SEED, s.url)).status, 401);
  assert.equal((await sync({ since: 0, changes: {} }, reset.syncCode, s.url)).status, 200);
  const del = await fetch(`${s.url}/api/admin/baselines/2026-11-09`, { method: 'DELETE', headers: h, body: '{}' });
  assert.equal((await del.json()).baseline.deleted, true);
  // 登出 → 同一個 cookie 失效
  await fetch(`${s.url}/api/admin/logout`, { method: 'POST', headers: h, body: '{}' });
  assert.equal((await fetch(`${s.url}/api/admin/session`, { headers: { cookie: lg.cookie } })).status, 401);
  assert.ok(!s.logs().includes(reset.syncCode), 'log 不得印同步碼');
  assert.ok(!s.logs().includes(SEED.replace(/-/g, '')), 'log 不得印同步碼');
});

test('admin：讀取金鑰可唯讀列表/CSV（BOM、擋公式注入）；錯金鑰 401', async () => {
  const { call } = await admin((await login()).cookie);
  await call('POST', 'orders', { acceptedAt: T0 + 3_600_000, estimateMin: 10, status: 'delivered', deliveredAt: T0 + 4_000_000, note: '=HYPERLINK("x")', amount: 45 });
  assert.equal((await fetch(`${base}/api/admin/orders`, { headers: { 'x-pt-read': 'wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/admin/orders?from=2026-13-01`, { headers: { 'x-pt-read': READ_KEY } })).status, 400);
  assert.equal((await fetch(`${base}/api/admin/orders?from=2024-01-01&to=2026-11-12`, { headers: { 'x-pt-read': READ_KEY } })).status, 400);
  const res = await fetch(`${base}/api/admin/export.csv?from=2026-11-12&to=2026-11-12`, { headers: { 'x-pt-read': READ_KEY } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="pandatimer-orders-2026-11-12_2026-11-12\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM（Excel 才認得中文）');
  const text = bytes.toString('utf8');
  assert.match(text, /^﻿id,接單\(台北\),預估分/);
  assert.match(text, /"'=HYPERLINK\(""x""\)"/);
  assert.match(text, /2026-11-12 11:00,20,2026-11-12 11:18,18,已送達,準/);
});

test('安全：登入失敗 5 次 → 鎖 15 分鐘（正確密碼也 429）；同步碼錯 10 次 → 429；同步每分鐘上限 → 429', async () => {
  const s = await startServer('locks', { SYNC_RATE_PER_MIN: '15' });
  for (let i = 0; i < 5; i++) assert.equal((await login(s.url, `wrong-${i}`)).status, 401);
  const locked = await login(s.url, PW);
  assert.equal(locked.status, 429);
  assert.ok(Number((await fetch(`${s.url}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) })).headers.get('retry-after')) > 800);
  assert.ok(!s.logs().includes(PW), 'log 不得印密碼');
  for (let i = 0; i < 10; i++) assert.equal((await sync({ since: 0 }, `WRONGCODE${i}`, s.url)).status, 401);
  assert.equal((await sync({ since: 0 }, SEED, s.url)).status, 429);
  const r = await startServer('rate', { SYNC_RATE_PER_MIN: '3' });
  for (let i = 0; i < 3; i++) assert.equal((await sync({ since: 0, changes: {} }, SEED, r.url)).status, 200);
  assert.equal((await sync({ since: 0, changes: {} }, SEED, r.url)).status, 429);
});

test('沒設 ADMIN_PASSWORD → 登入 503，同步照常；資料庫目錄寫不進 → /api/sync 503、其他端點照常', async () => {
  const s = await startServer('nopw', { ADMIN_PASSWORD: '' });
  assert.equal((await login(s.url)).status, 503);
  assert.equal((await sync({ since: 0, changes: {} }, SEED, s.url)).status, 200);
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const d = await startServer('nodb', { DATA_DIR: path.join(blocker, 'data') });
  assert.equal((await sync({ since: 0, changes: {} }, SEED, d.url)).status, 503);
  assert.equal(await (await fetch(`${d.url}/api/health`)).text(), 'ok');
});

test('每日備份：啟動後 DATA_DIR/backup 有今天的 orders-YYYY-MM-DD.db', () => {
  const dir = path.join(tmp, 'main', 'data', 'backup');
  const names = fs.readdirSync(dir);
  assert.ok(names.some((n) => /^orders-\d{4}-\d{2}-\d{2}\.db$/.test(n)), names.join(','));
});

test('登出＝換 session 金鑰：所有裝置的 cookie 失效、重啟後仍失效；沒帶 CSRF 的登出不影響其他裝置', async () => {
  const s = await startServer('logout');
  const a = await login(s.url);
  const b = await login(s.url);
  const sessOf = async (cookie) => (await fetch(`${s.url}/api/admin/session`, { headers: { cookie } }));
  // 沒 CSRF（例如同站其他頁面亂打）→ 只清自己的 cookie，不換金鑰
  await fetch(`${s.url}/api/admin/logout`, { method: 'POST', headers: { cookie: b.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal((await sessOf(a.cookie)).status, 200);
  assert.equal((await sessOf(b.cookie)).status, 200);
  const csrf = (await (await sessOf(a.cookie)).json()).csrf;
  const out = await fetch(`${s.url}/api/admin/logout`, { method: 'POST', headers: { cookie: a.cookie, 'x-pt-csrf': csrf, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await sessOf(a.cookie)).status, 401);
  assert.equal((await sessOf(b.cookie)).status, 401, '其他裝置也登出');
  await new Promise((r) => { s.child.on('exit', r); s.child.kill('SIGTERM'); });
  const again = await startServer('logout');
  assert.equal((await fetch(`${again.url}/api/admin/session`, { headers: { cookie: a.cookie } })).status, 401, '重啟後舊 cookie 仍無效');
  assert.equal((await login(again.url)).status, 200);
});

test('Origin＝PUBLIC_URL 的主機也算同站（nginx 沒轉 Host 時）；其他 Origin、壞 Origin 照擋', async () => {
  const s = await startServer('origin', { PUBLIC_URL: 'https://pub.example/pandatimer' });
  const { cookie } = await login(s.url);
  const csrf = (await (await fetch(`${s.url}/api/admin/session`, { headers: { cookie } })).json()).csrf;
  const body = JSON.stringify({ acceptedAt: T0, estimateMin: 18, status: 'canceled' });
  const post = (origin) => fetch(`${s.url}/api/admin/orders`, { method: 'POST', headers: { cookie, 'x-pt-csrf': csrf, 'content-type': 'application/json', origin }, body });
  assert.equal((await post('https://pub.example')).status, 200);
  assert.equal((await post('https://pub.example.evil.example')).status, 403);
  assert.equal((await post('null')).status, 403);
});

test('還原備份：備份檔 dbId 換新（App 會全部重傳）；寫入不會掩蓋「游標比伺服器新」的 reset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-restore-test-'));
  try {
    const db = path.join(dir, 'orders.db');
    const t = Date.now() - 3 * 3_600_000;
    const o = (id, u) => order(id, { acceptedAt: t, deliveredAt: t + 600_000, updatedAt: u });
    let s = await openStore(db);
    const liveId = s.dbId;
    let r = s.sync({ since: 0, orders: [o('a', t + 1)] });
    s.backup(path.join(dir, 'bk'), '2026-11-13');
    await new Promise((x) => setTimeout(x, 5));
    r = s.sync({ since: r.now, orders: [o('b', t + 2)] }); // 備份之後才上傳
    const appSince = r.now;
    s.close();
    fs.copyFileSync(path.join(dir, 'bk', 'orders-2026-11-13.db'), db);
    for (const ext of ['-wal', '-shm']) fs.rmSync(db + ext, { force: true });
    s = await openStore(db);
    assert.notEqual(s.dbId, liveId, '還原後 dbId 不同 → App needsFullResync');
    await new Promise((x) => setTimeout(x, 5));
    // App 這次剛好也帶了新變更：仍要回報 reset（舊寫法寫入後 clock 變大，reset 被吃掉）
    r = s.sync({ since: appSince, orders: [o('c', Date.now())] });
    assert.equal(r.reset, true);
    assert.ok(r.changes.orders.some((x) => x.id === 'a'), 'reset 時從頭給');
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
