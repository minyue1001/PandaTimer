// v1.4 伺服器：telemetry 店名 → 訂單補 store（先 telemetry 後訂單、先訂單後 telemetry）、LWW 不蓋 App 較新修改、
// 管理 API 改店名、遷移冪等、/api/declined 拒單端點。子程序起在 127.0.0.1 隨機埠，結束只 kill 自己起的 PID。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../server/orders.mjs';
import { mergeServerOrders, orderToWire, parseSyncResponse } from '../src/sync.ts';

const SERVER = new URL('../server/index.mjs', import.meta.url).pathname;
const PW = 'correct-horse-battery';
const READ_KEY = 'read-key-0123456789abcdef0123456789';
const WRITE_KEY = 'write-key-0123456789abcdef0123456789';
const SEED = 'ABCD-EFGH-JKLM';
let child;
let tmp;
let base;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-store-test-'));
  child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: '0',
      UPDATES_DIR: path.join(tmp, 'updates'),
      TELEMETRY_DIR: path.join(tmp, 'telemetry'),
      CONFIG_PATH: path.join(tmp, 'config.json'),
      DATA_DIR: path.join(tmp, 'data'),
      TELEMETRY_WRITE_KEY: WRITE_KEY,
      TELEMETRY_READ_KEY: READ_KEY,
      ADMIN_PASSWORD: PW,
      SYNC_CODE: SEED,
      ADMIN_COOKIE_SECURE: '0',
      SYNC_RATE_PER_MIN: '1000',
      TELEMETRY_RATE_PER_MIN: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stderr.on('data', (d) => (out += d));
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
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  if (child && child.exitCode == null) child.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const NOW = Date.now();
const tp = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
const RECENT = tp(NOW - 3 * 86_400_000);
// 每個測試用不同分鐘數避免互相配到
const order = (id, min, acceptedAt, extra = {}) => ({
  id,
  acceptedAt,
  estimateMin: min,
  deliveredAt: acceptedAt + min * 60_000,
  status: 'delivered',
  amount: null,
  stacked: false,
  source: 'auto',
  note: '',
  updatedAt: acceptedAt + min * 60_000,
  deleted: false,
  ...extra,
});
async function sync(orders, since = 0) {
  const res = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pt-sync': SEED },
    body: JSON.stringify({ since, changes: { orders } }),
  });
  return { status: res.status, body: await res.json() };
}
async function telemetry(records) {
  const res = await fetch(`${base}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pt-key': WRITE_KEY },
    body: JSON.stringify(records),
  });
  return { status: res.status, body: await res.json() };
}
const extOrder = (t, min, store, extra = {}) => ({ src: 'ext', ev: 'order', dev: 'testdev', t, min, delay: 1, store, ...extra });
async function serverOrder(id) {
  const r = await sync([]);
  return r.body.changes.orders.find((o) => o.id === id);
}
async function adminCall(method, p, body) {
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const s = await (await fetch(`${base}/api/admin/session`, { headers: { cookie } })).json();
  const res = await fetch(`${base}/api/admin/${p}`, {
    method,
    headers: { cookie, 'x-pt-csrf': s.csrf, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null), text: '' };
}

test('telemetry 白名單：store 只收字串、去控制字元、≤40 字；其他 OCR 字照擋', async () => {
  const r = await telemetry([
    { src: 'ext', ev: 'offer_seen', dev: 'd1', t: NOW, min: 33, store: `  店\u0007名${'長'.repeat(60)}  `, text: '原文', address: '德中路' },
    { src: 'ext', ev: 'offer_seen', dev: 'd1', t: NOW, min: 33, store: 123 },
  ]);
  assert.equal(r.status, 200);
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const lines = fs.readFileSync(path.join(tmp, 'telemetry', `${date}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const got = lines.filter((l) => l.min === 33);
  assert.equal(got[0].store, `店 名${'長'.repeat(37)}`);
  assert.equal(Array.from(got[0].store).length, 40);
  assert.equal(got[0].text, undefined);
  assert.equal(got[0].address, undefined);
  assert.equal('store' in got[1], false);
});

test('先 telemetry 後訂單：同分鐘、接單 ±120 秒 → 訂單上傳時補 store，回應就帶回（updatedAt 不變）', async () => {
  const acc = NOW - 3_600_000;
  await telemetry([extOrder(acc + 1000, 41, '微笑早午餐 (高雄藍田店)'), extOrder(acc + 1000, 42, '別家')]);
  const o = order('st-late', 41, acc);
  const r = await sync([o]);
  assert.equal(r.body.accepted.orders, 1);
  const echo = r.body.changes.orders.find((x) => x.id === 'st-late');
  assert.ok(echo, '補了店名 → 回傳給 App');
  assert.equal(echo.store, '微笑早午餐 (高雄藍田店)');
  assert.equal(echo.updatedAt, o.updatedAt);
  // App 端套用（端到端：本機那筆剛上傳 → pushed＝它的 updatedAt）
  const app = { id: 'st-late', acceptedAt: acc, estimateMin: 41, deadline: acc + 41 * 60_000, status: 'delivered', deliveredAt: o.deliveredAt, actualMin: 41, source: 'auto', updatedAt: o.updatedAt };
  const resp = parseSyncResponse(r.body);
  const m = mergeServerOrders([app], {}, { 'st-late': o.updatedAt }, resp.orders);
  assert.equal(m.orders.find((x) => x.id === 'st-late').store, '微笑早午餐 (高雄藍田店)');
  // 太遠（>120 秒）或分鐘不同 → 不補
  await telemetry([extOrder(NOW - 7_200_000 + 200_000, 43, '太遠')]);
  const far = await sync([order('st-far', 43, NOW - 7_200_000)]);
  assert.equal(far.body.changes.orders.some((x) => x.id === 'st-far'), false);
  assert.equal((await serverOrder('st-far')).store, null);
});

test('先訂單後 telemetry：補最近那張沒店名的單、App 下次同步（游標之後）拿得到、updatedAt 不變', async () => {
  const acc = NOW - 5_400_000;
  const first = await sync([order('st-a', 44, acc), order('st-b', 44, acc + 100_000)]);
  const cursor = first.body.now;
  await telemetry([extOrder(acc + 95_000 + 1000, 44, '麥當勞 (S596 高雄德中店)')]); // 離 st-b 5 秒、離 st-a 95 秒 → st-b
  const next = await sync([], cursor);
  const got = next.body.changes.orders.find((x) => x.id === 'st-b');
  assert.equal(got.store, '麥當勞 (S596 高雄德中店)');
  assert.equal(got.updatedAt, order('st-b', 44, acc + 100_000).updatedAt);
  assert.equal(next.body.changes.orders.some((x) => x.id === 'st-a'), false);
  // 組合單：第二條同分鐘線索 → 補另一張
  await telemetry([extOrder(acc + 1000, 44, '麥當勞 (S596 高雄德中店)')]);
  assert.equal((await serverOrder('st-a')).store, '麥當勞 (S596 高雄德中店)');
});

test('LWW：伺服器補店名後 App 上傳較新的修改（沒帶 store）→ 修改採用、店名保留並回傳；較舊的上傳被拒、回伺服器版', async () => {
  const acc = NOW - 9_000_000;
  const o = order('st-lww', 45, acc);
  await sync([o]);
  await telemetry([extOrder(acc + 1000, 45, '八方雲集')]);
  // App 不知道伺服器補了店名，改了小費（較新 updatedAt）
  const edited = { ...o, tip: 30, updatedAt: o.updatedAt + 60_000 };
  const r = await sync([edited]);
  assert.equal(r.body.accepted.orders, 1);
  const echo = r.body.changes.orders.find((x) => x.id === 'st-lww');
  assert.equal(echo.tip, 30, 'App 的修改沒被蓋掉');
  assert.equal(echo.store, '八方雲集', '店名保留');
  assert.equal(echo.updatedAt, edited.updatedAt);
  // App 端：上傳成功（pushed＝edited.updatedAt）→ 套用 echo → 有店名、小費 30
  const app = { id: 'st-lww', acceptedAt: acc, estimateMin: 45, deadline: acc + 45 * 60_000, status: 'delivered', deliveredAt: o.deliveredAt, actualMin: 45, source: 'auto', tip: 30, updatedAt: edited.updatedAt };
  const m = mergeServerOrders([app], {}, { 'st-lww': edited.updatedAt }, parseSyncResponse(r.body).orders);
  const mine = m.orders.find((x) => x.id === 'st-lww');
  assert.equal(mine.store, '八方雲集');
  assert.equal(mine.tip, 30);
  assert.equal(orderToWire(mine).store, '八方雲集');
  // 較舊版本（App 時鐘慢）→ 不採用，回伺服器版（有店名、有小費）
  const older = await sync([{ ...o, note: '舊', updatedAt: o.updatedAt - 1 }]);
  assert.equal(older.body.accepted.orders, 0);
  const srv = older.body.changes.orders.find((x) => x.id === 'st-lww');
  assert.equal(srv.store, '八方雲集');
  assert.equal(srv.tip, 30);
  // App 有值也接受（例如另一台裝置）
  const own = await sync([{ ...edited, store: '手動改的店名', updatedAt: edited.updatedAt + 1 }]);
  assert.equal(own.body.accepted.orders, 1);
  assert.equal((await serverOrder('st-lww')).store, '手動改的店名');
  // 刪除的單不補
  await sync([order('st-del', 46, acc, { deleted: true })]);
  await telemetry([extOrder(acc + 1000, 46, '不該補')]);
  const del = await fetch(`${base}/api/admin/orders?deleted=1&from=${RECENT}`, { headers: { 'x-pt-read': READ_KEY } }).then((x) => x.json());
  assert.equal(del.orders.find((x) => x.id === 'st-del')?.store ?? null, null);
});

test('未接判定的店名（offer_decided reject）只補 confirm 單（「你有接嗎？」按有接）', async () => {
  const acc = NOW - 10_800_000;
  await sync([order('st-auto', 47, acc + 5000), order('st-conf', 48, acc + 5000, { source: 'confirm' })]);
  await telemetry([
    { src: 'ext', ev: 'offer_decided', dev: 'testdev', t: acc + 60_000, min: 47, result: 'reject', reason: 'timeout', wait: 60, store: '不該補' },
    { src: 'ext', ev: 'offer_decided', dev: 'testdev', t: acc + 60_000, min: 48, result: 'reject', reason: 'timeout', wait: 60, store: '鬍鬚張' },
  ]);
  assert.equal((await serverOrder('st-auto')).store, null);
  assert.equal((await serverOrder('st-conf')).store, '鬍鬚張');
});

test('管理 API：PUT 改店名／清空、POST 帶店名、CSV 有店名欄', async () => {
  const acc = NOW - 12_600_000;
  await sync([order('st-adm', 49, acc)]);
  const put = await adminCall('PUT', 'orders/st-adm', { store: '  管理頁\n改的 ' });
  assert.equal(put.status, 200);
  assert.equal(put.body.order.store, '管理頁 改的');
  assert.equal((await adminCall('PUT', 'orders/st-adm', { note: 'x' })).body.order.store, '管理頁 改的', '沒帶 store 不清掉');
  assert.equal((await adminCall('PUT', 'orders/st-adm', { store: 5 })).status, 400);
  assert.equal((await adminCall('PUT', 'orders/st-adm', { store: '' })).body.order.store, null);
  const created = await adminCall('POST', 'orders', { acceptedAt: acc, estimateMin: 10, status: 'delivered', deliveredAt: acc + 600_000, store: '新店' });
  assert.equal(created.body.order.store, '新店');
  const csv = await fetch(`${base}/api/admin/export.csv?from=${RECENT}`, { headers: { 'x-pt-read': READ_KEY } }).then((x) => x.text());
  assert.match(csv, /已刪除,店名/);
  assert.match(csv, /新店/);
});

test('遷移冪等：舊資料庫（沒有 store 欄、沒有 store_hints）補欄位，資料不壞', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-mig3-test-'));
  try {
    const db = path.join(dir, 'orders.db');
    const old = new DatabaseSync(db);
    old.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY, acceptedAt INTEGER NOT NULL, estimateMin REAL NOT NULL, deliveredAt INTEGER,
      status TEXT NOT NULL, amount REAL, stacked INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
      note TEXT NOT NULL DEFAULT '', updatedAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      editedBy TEXT NOT NULL DEFAULT 'app', syncAt INTEGER NOT NULL, tip REAL, noTiming INTEGER);
      INSERT INTO orders VALUES('old3', ${NOW - 600_000}, 20, ${NOW}, 'delivered', 81.67, 0, 'auto', '', ${NOW}, 0, 'app', 5, 12, NULL);`);
    old.close();
    for (let i = 0; i < 2; i++) {
      const s = await openStore(db);
      const o = s.getOrder('old3');
      assert.equal(o.store, null);
      assert.equal(o.tip, 12);
      s.close();
    }
    const s = await openStore(db);
    assert.equal(s.noteStoreHints([{ at: NOW - 600_000 + 3000, min: 20, store: '遷移後', kind: 'order' }], NOW), 1);
    assert.equal(s.getOrder('old3').store, '遷移後');
    // 不合法線索略過
    assert.equal(s.noteStoreHints([{ at: 'x', min: 20, store: 'a' }, { at: NOW, min: 0, store: 'a' }, { at: NOW, min: 20, store: '' }], NOW), 0);
    s.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/declined：同步碼、參數驗證、拒單（排除有接的）；GET /api/admin/declined 讀取金鑰', async () => {
  assert.equal((await fetch(`${base}/api/declined`)).status, 405);
  const post = (body, code = SEED) =>
    fetch(`${base}/api/declined`, { method: 'POST', headers: { 'content-type': 'application/json', ...(code ? { 'x-pt-sync': code } : {}) }, body: JSON.stringify(body) });
  const today = tp(Date.now());
  const yesterday = tp(Date.now() - 86_400_000);
  assert.equal((await post({ from: today }, null)).status, 401);
  assert.equal((await post({ from: '2026/11/25' })).status, 400);
  assert.equal((await post({ from: today, to: '2020-01-01' })).status, 400);
  // 10 分鐘前的事件（查昨天～今天，跨日也涵蓋）
  const T = Date.now() - 600_000;
  const ev = (dt, o) => ({ src: 'ext', dev: 'testdev', t: T + dt * 1000, ...o });
  await telemetry([
    ev(0, { ev: 'offer_seen', min: 61, amt: 249.08, km: 9.4 }),
    ev(60, { ev: 'offer_decided', result: 'reject', reason: 'timeout', wait: 60, min: 61, amt: 249.08, store: '拒掉的店' }),
    ev(120, { ev: 'offer_seen', min: 62, amt: 253.17 }),
    ev(180, { ev: 'offer_decided', result: 'reject', reason: 'timeout', wait: 60, min: 62, amt: 253.17 }),
  ]);
  // 62 分那張之後按「有接」
  await sync([order('st-yes', 62, T + 125_000, { source: 'confirm', status: 'active', deliveredAt: null, updatedAt: T + 200_000 })]);
  const r = await post({ from: yesterday, to: today });
  assert.equal(r.status, 200);
  const body = await r.json();
  const mine = body.declined.filter((x) => x.min === 61 || x.min === 62);
  assert.deepEqual(mine.map((x) => [x.t, x.min, x.amt, x.km, x.store, x.reason]), [[T, 61, 249.08, 9.4, '拒掉的店', 'timeout']]);
  assert.equal('decidedAt' in mine[0], false);
  const adm = await fetch(`${base}/api/admin/declined?from=${yesterday}&to=${today}`, { headers: { 'x-pt-read': READ_KEY } });
  assert.equal(adm.status, 200);
  assert.ok((await adm.json()).declined.some((x) => x.min === 61));
  assert.equal((await fetch(`${base}/api/admin/declined?from=${today}`, { headers: { 'x-pt-read': 'wrong' } })).status, 401);
});
