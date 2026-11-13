// src/sync.ts（App 端雲端同步純邏輯）＋ 與 server/index.mjs 的端到端協定測試（本機子程序，結束只 kill 自己的 PID）。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compactPushed,
  EMPTY_SYNC_STATE,
  expireTombstones,
  markPushed,
  mergeServerBaselines,
  mergeServerOrders,
  needsFullResync,
  normalizeSyncCode,
  orderToWire,
  parseBaselineSlot,
  parseSyncResponse,
  parseSyncState,
  pendingBaselines,
  pendingOrders,
  slotToWire,
  stampBaseline,
  stampChanges,
  SyncScheduler,
  syncUrlFrom,
  unsyncedTombstoneIds,
  wireToOrder,
} from '../src/sync.ts';
import { TOMBSTONE_TTL_MS, addTombstones } from '../src/prune.ts';

const T0 = Date.UTC(2026, 10, 12, 3, 0, 0);
const MIN = 60_000;
const ord = (id, extra = {}) => ({
  id,
  acceptedAt: T0,
  estimateMin: 20,
  deadline: T0 + 20 * MIN,
  status: 'delivered',
  deliveredAt: T0 + 18 * MIN,
  actualMin: 18,
  ...extra,
});
const state = (extra = {}) => ({ ...EMPTY_SYNC_STATE, pushedOrders: {}, pushedBaselines: {}, ...extra });
const wire = (id, extra = {}) => ({ ...orderToWire(ord(id)), ...extra });

test('同步碼正規化與網址', () => {
  assert.equal(normalizeSyncCode(' abcd-efgh jklm '), 'ABCDEFGHJKLM');
  assert.equal(normalizeSyncCode('短'), '');
  assert.equal(normalizeSyncCode(''), '');
  assert.equal(syncUrlFrom('https://wheat.yueshengift.xyz/pandatimer/api/config'), 'https://wheat.yueshengift.xyz/pandatimer/api/sync');
  assert.equal(syncUrlFrom('http://x/api/config'), null);
  assert.equal(syncUrlFrom(undefined), null);
});

test('stampChanges：新單/同步欄位變動蓋 updatedAt；只改動態島/通知 id 不算；移除算變動', () => {
  const a = ord('a', { updatedAt: T0 + 100 });
  const b = ord('b', { updatedAt: T0 + 5 * 3_600_000 }); // 手機時鐘曾經比較快
  const now = T0 + 3_600_000;
  const r1 = stampChanges([a, b], [a, b], now);
  assert.equal(r1.changed, false);
  assert.equal(r1.orders[0], a);
  const r2 = stampChanges([a, b], [{ ...a, activityId: 'x', notifIds: ['n'] }, b], now);
  assert.equal(r2.changed, false);
  assert.equal(r2.orders[0].updatedAt, T0 + 100);
  const r3 = stampChanges([a, b], [{ ...a, estimateMin: 25 }, { ...b, note: '改' }, ord('c')], now);
  assert.equal(r3.changed, true);
  assert.equal(r3.orders[0].updatedAt, now);
  assert.equal(r3.orders[1].updatedAt, T0 + 5 * 3_600_000 + 1, '本機修改一定比原版本新');
  assert.equal(r3.orders[2].updatedAt, now);
  assert.equal(stampChanges([a, b], [a], now).changed, true);
});

test('orderToWire ↔ wireToOrder：欄位對應、本地欄位沿用、手動單 source=manual', () => {
  const o = ord('w1', { activityId: 'act', notifIds: ['n1'], amount: 81.67, stacked: true, note: '備註', updatedAt: T0 + 5 });
  const w = orderToWire(o);
  assert.deepEqual(w, {
    id: 'w1', acceptedAt: T0, estimateMin: 20, deliveredAt: T0 + 18 * MIN, status: 'delivered', amount: 81.67, stacked: true,
    source: 'manual', note: '備註', updatedAt: T0 + 5, deleted: false,
  });
  const back = wireToOrder({ ...w, estimateMin: 25, deliveredAt: T0 + 30 * MIN }, o);
  assert.equal(back.deadline, T0 + 25 * MIN);
  assert.equal(back.actualMin, 30);
  assert.equal(back.activityId, 'act');
  assert.deepEqual(back.notifIds, ['n1']);
  assert.equal(back.source, undefined);
  const active = wireToOrder({ ...w, status: 'active', deliveredAt: null, source: 'auto' });
  assert.equal(active.deliveredAt, undefined);
  assert.equal(active.actualMin, undefined);
  assert.equal(active.source, 'auto');
  // 進行中單不送 deliveredAt；舊紀錄沒有 updatedAt → 用送達時間
  assert.equal(orderToWire(ord('x', { status: 'active', deliveredAt: undefined })).deliveredAt, null);
  assert.equal(orderToWire(ord('y')).updatedAt, T0 + 18 * MIN);
});

test('pendingOrders：首次配對全部待上傳；markPushed 後清空；刪除墓碑待上傳、送過就不再送', () => {
  const orders = [ord('a'), ord('b', { updatedAt: T0 + 1 })];
  const tombs = { gone: T0 + 2 };
  const s0 = state();
  const p = pendingOrders(orders, tombs, s0);
  assert.deepEqual(p.map((x) => x.id), ['a', 'b', 'gone']);
  assert.deepEqual(p[2], { id: 'gone', updatedAt: T0 + 2, deleted: true });
  const s1 = markPushed(s0, p, []);
  assert.deepEqual(pendingOrders(orders, tombs, s1), []);
  const edited = [{ ...orders[0], updatedAt: T0 + 99 }, orders[1]];
  assert.deepEqual(pendingOrders(edited, tombs, s1).map((x) => x.id), ['a']);
});

test('mergeServerOrders：伺服器較新覆蓋；本機未上傳且較新保留；進行中被改成送達 → ended', () => {
  const local = [ord('a', { updatedAt: T0 + 10 }), ord('b', { status: 'active', deliveredAt: undefined, actualMin: undefined, activityId: 'card', updatedAt: T0 + 10 }), ord('c', { updatedAt: T0 + 50 })];
  const pushed = { a: T0 + 10, b: T0 + 10, c: T0 + 10 }; // c 本機改過還沒上傳
  const incoming = [
    wire('a', { estimateMin: 30, updatedAt: T0 + 20, editedBy: 'admin' }),
    wire('b', { status: 'delivered', deliveredAt: T0 + 25 * MIN, updatedAt: T0 + 20 }),
    wire('c', { estimateMin: 5, updatedAt: T0 + 20 }),
  ];
  const m = mergeServerOrders(local, {}, pushed, incoming);
  const by = Object.fromEntries(m.orders.map((o) => [o.id, o]));
  assert.equal(by.a.estimateMin, 30);
  assert.equal(by.a.updatedAt, T0 + 20);
  assert.equal(by.b.status, 'delivered');
  assert.equal(by.b.actualMin, 25);
  assert.equal(by.b.activityId, 'card', '動態島 id 保留（收尾要用）');
  assert.equal(by.c.estimateMin, 20, '本機較新未上傳 → 保留');
  assert.deepEqual(m.ended.map((o) => o.id), ['b']);
  assert.equal(m.ended[0].status, 'active', 'ended 給的是本機原本那筆（有 activityId/notifIds）');
  assert.equal(m.pushedOrders.a, T0 + 20);
  assert.equal(m.pushedOrders.c, T0 + 10);
  assert.equal(m.applied, 2);
});

test('mergeServerOrders：伺服器刪除 → 移除＋墓碑（不再上傳）；本機刪除較新 → 不復活；伺服器還原較新 → 復活並拿掉墓碑', () => {
  const local = [ord('a', { status: 'active', deliveredAt: undefined, updatedAt: T0 })];
  const m1 = mergeServerOrders(local, {}, { a: T0 }, [{ ...wire('a'), updatedAt: T0 + 5, deleted: true }]);
  assert.equal(m1.orders.length, 0);
  assert.equal(m1.tombs.a, T0 + 5);
  assert.equal(m1.ended.length, 1);
  assert.deepEqual(pendingOrders(m1.orders, m1.tombs, state({ pushedOrders: m1.pushedOrders })), []);
  // 本機剛刪（墓碑未上傳、較新）＋伺服器舊的未刪版本 → 維持刪除
  const m2 = mergeServerOrders([], { b: T0 + 100 }, { b: T0 }, [wire('b', { updatedAt: T0 + 50 })]);
  assert.equal(m2.orders.length, 0);
  assert.equal(m2.tombs.b, T0 + 100);
  // 墓碑已上傳、管理頁之後還原 → 復活
  const m3 = mergeServerOrders([], { b: T0 + 100 }, { b: T0 + 100 }, [wire('b', { updatedAt: T0 + 200 })]);
  assert.equal(m3.orders.length, 1);
  assert.equal(m3.tombs.b, undefined);
  // 本機沒有、伺服器新增 → 加入並依接單時間新到舊排序
  const m4 = mergeServerOrders([ord('old', { acceptedAt: T0 - 3_600_000 })], {}, {}, [wire('new1', { acceptedAt: T0 + 3_600_000, deliveredAt: T0 + 3_700_000, updatedAt: T0 })]);
  assert.deepEqual(m4.orders.map((o) => o.id), ['new1', 'old']);
  // 伺服器刪了、本機也沒有 → 什麼都不做
  assert.equal(mergeServerOrders([], {}, {}, [{ ...wire('z'), deleted: true }]).orders.length, 0);
});

test('上傳被伺服器拒絕（伺服器較新/同時間）：markPushed 後再合併回應裡的伺服器版 → 本機改成伺服器版、不再重送', () => {
  const local = [ord('a', { estimateMin: 99, updatedAt: T0 + 10 })];
  const s = markPushed(state(), [orderToWire(local[0])], []);
  const m = mergeServerOrders(local, {}, s.pushedOrders, [wire('a', { estimateMin: 20, updatedAt: T0 + 10 })]);
  assert.equal(m.orders[0].estimateMin, 20);
  assert.deepEqual(pendingOrders(m.orders, {}, state({ pushedOrders: m.pushedOrders })), []);
});

test('墓碑保留到同步完成：已配對且未上傳的不過期；未配對/已上傳照 7 天過期', () => {
  const now = T0 + TOMBSTONE_TTL_MS + 1000;
  const tombs = { old: T0, done: T0, fresh: now - 1000 };
  const s = state({ pushedOrders: { done: T0 } });
  assert.deepEqual([...unsyncedTombstoneIds(tombs, s, true)].sort(), ['fresh', 'old']);
  assert.deepEqual(Object.keys(expireTombstones(tombs, s, true, now)).sort(), ['fresh', 'old']);
  assert.deepEqual(Object.keys(expireTombstones(tombs, s, false, now)), ['fresh']);
  // controller.pruneOrders 新增墓碑時一樣保留 pinned
  const added = addTombstones(tombs, ['new'], now, unsyncedTombstoneIds(tombs, s, true));
  assert.deepEqual(Object.keys(added).sort(), ['fresh', 'new', 'old']);
  assert.deepEqual(Object.keys(compactPushed({ done: 1, gone: 2, a: 3 }, [ord('a')], { done: T0 })).sort(), ['a', 'done']);
});

test('補登：百分比換算、刪除標記、只合併本期/槽那一期、本機較新保留', () => {
  const b = { periodId: '2026-11-09', count: 40, onTimeRate: 0.455, overrunRate: 0.18, income: 3200, updatedAt: T0 };
  assert.deepEqual(slotToWire(b), { period: '2026-11-09', orders: 40, onTimePct: 45.5, overrunPct: 18, income: 3200, updatedAt: T0, deleted: false });
  const legacy = { periodId: '2026-11-09', count: 1, onTimeRate: 1, overrunRate: 0 };
  assert.equal(slotToWire(legacy).updatedAt, Date.UTC(2026, 10, 8, 16), '舊補登以期別起點當版本');
  const del = stampBaseline(null, b, '2026-11-09', T0 - 5);
  assert.deepEqual(del, { periodId: '2026-11-09', deleted: true, updatedAt: T0 + 1 });
  assert.deepEqual(parseBaselineSlot(JSON.stringify(del)), del);
  assert.deepEqual(slotToWire(del), { period: '2026-11-09', updatedAt: T0 + 1, deleted: true });
  assert.equal(pendingBaselines(b, state({ pushedBaselines: { '2026-11-09': T0 } })).length, 0);
  assert.equal(pendingBaselines(b, state()).length, 1);
  const w = { period: '2026-11-09', orders: 30, onTimePct: 50, overrunPct: 10, income: null, updatedAt: T0 + 10, deleted: false };
  const m1 = mergeServerBaselines(b, { '2026-11-09': T0 }, [w, { ...w, period: '2026-10-26' }], '2026-11-09');
  assert.deepEqual(m1.slot, { periodId: '2026-11-09', count: 30, onTimeRate: 0.5, overrunRate: 0.1, updatedAt: T0 + 10 });
  assert.equal(m1.pushedBaselines['2026-10-26'], undefined, '別期不收');
  const dirty = { ...b, updatedAt: T0 + 50 };
  assert.equal(mergeServerBaselines(dirty, { '2026-11-09': T0 }, [w], '2026-11-09').slot, undefined);
  // 槽是上一期、伺服器給本期 → 換成本期
  const m2 = mergeServerBaselines({ ...b, periodId: '2026-10-26' }, {}, [{ ...w, period: '2026-11-09' }], '2026-11-09');
  assert.equal(m2.slot.periodId, '2026-11-09');
  const m3 = mergeServerBaselines(b, {}, [{ ...w, deleted: true }], '2026-11-09');
  assert.deepEqual(m3.slot, { periodId: '2026-11-09', deleted: true, updatedAt: T0 + 10 });
});

test('parseSyncResponse／parseSyncState／needsFullResync：不可信輸入', () => {
  assert.equal(parseSyncResponse(null), null);
  assert.equal(parseSyncResponse({ now: 'x' }), null);
  const r = parseSyncResponse({
    now: 5, dbId: 'db1', more: false, changes: { orders: [wire('a'), { id: 'bad id' }, { ...wire('b'), status: 'x' }], baselines: [{ period: 'nope' }] }, invalid: [1],
  });
  assert.deepEqual(r.orders.map((o) => o.id), ['a']);
  assert.equal(r.baselines.length, 0);
  assert.equal(r.invalid, 1);
  assert.deepEqual(parseSyncState('{bad'), { ...EMPTY_SYNC_STATE, pushedOrders: {}, pushedBaselines: {} });
  assert.deepEqual(parseSyncState({ dbId: 'd', since: 9, pushedOrders: { a: 1, b: 'x' } }).pushedOrders, { a: 1 });
  assert.equal(needsFullResync(state(), { dbId: 'd', reset: false }), false, '首次配對 dbId 還是 null');
  assert.equal(needsFullResync(state({ dbId: 'd' }), { dbId: 'e', reset: false }), true);
  assert.equal(needsFullResync(state({ dbId: 'd' }), { dbId: 'd', reset: true }), true);
});

test('SyncScheduler：5 秒內連續變動只跑一次；跑的時候被叫 → 跑完補一次；now() 取消等待中的 debounce', async () => {
  const pending = [];
  const timers = {
    set: (fn, ms) => { const h = { fn, ms }; pending.push(h); return h; },
    clear: (h) => { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); },
  };
  let runs = 0;
  let release;
  const sch = new SyncScheduler(() => { runs += 1; return new Promise((r) => (release = r)); }, 5000, timers);
  sch.poke();
  sch.poke();
  sch.poke();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ms, 5000);
  pending.shift().fn();
  assert.equal(runs, 1);
  assert.equal(sch.busy, true);
  const p = sch.now(); // 跑的中間又被叫
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  release();
  await p;
  assert.equal(sch.busy, false);
  sch.poke();
  assert.equal(pending.length, 1);
  const q = sch.now();
  assert.equal(pending.length, 0, 'now() 取消 debounce');
  release();
  await q;
  assert.equal(runs, 3);
  // run 丟錯不會卡住
  const bad = new SyncScheduler(() => Promise.reject(new Error('offline')), 10, timers);
  await bad.now();
  assert.equal(bad.busy, false);
});

// ── 端到端：App 端純邏輯 × 真伺服器 ──
const procs = [];
let tmp;
after(() => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test('端到端：首次配對全部上傳 → 管理頁改/刪/新增 → App 合併（進行中被結、刪除留墓碑）→ 不再重送', async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-sync-e2e-'));
  const child = spawn(process.execPath, [new URL('../server/index.mjs', import.meta.url).pathname], {
    env: {
      PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0', DATA_DIR: path.join(tmp, 'data'), UPDATES_DIR: path.join(tmp, 'u'),
      TELEMETRY_DIR: path.join(tmp, 't'), CONFIG_PATH: path.join(tmp, 'c.json'), ADMIN_PASSWORD: 'e2e-password-123', SYNC_CODE: 'E2EE-CODE-TEST',
      ADMIN_COOKIE_SECURE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(out)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve(m[1]); }
    });
  });
  const code = normalizeSyncCode('e2ee-code-test');
  // 模擬 App 的一輪同步（與 src/syncClient.ts runSyncOnce 相同步驟）
  const app = { orders: [], tombs: {}, state: state(), ended: [] };
  const syncOnce = async () => {
    for (let round = 0; round < 20; round++) {
      const pend = pendingOrders(app.orders, app.tombs, app.state);
      const send = pend.slice(0, 100);
      const res = await fetch(`${base}/api/sync`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-pt-sync': code },
        body: JSON.stringify({ since: app.state.since, changes: { orders: send, baselines: [] } }),
      });
      assert.equal(res.status, 200);
      const resp = parseSyncResponse(await res.json());
      if (needsFullResync(app.state, resp)) { app.state = { ...app.state, dbId: resp.dbId, since: 0, pushedOrders: {} }; continue; }
      app.state = markPushed({ ...app.state, dbId: resp.dbId }, send, []);
      const m = mergeServerOrders(app.orders, app.tombs, app.state.pushedOrders, resp.orders);
      app.orders = m.orders; app.tombs = m.tombs; app.ended.push(...m.ended);
      app.state = { ...app.state, pushedOrders: m.pushedOrders, since: resp.now };
      if (!resp.more && pend.length <= send.length) break;
    }
  };
  // 本機 150 筆舊紀錄（沒有 updatedAt）＋1 筆進行中 → 首次配對分兩批上傳
  for (let i = 0; i < 150; i++) app.orders.push(ord(`old-${i}`, { acceptedAt: T0 - i * 3_600_000, deliveredAt: T0 - i * 3_600_000 + 15 * MIN }));
  app.orders.unshift(ord('live', { acceptedAt: Date.now() - 5 * MIN, status: 'active', deliveredAt: undefined, actualMin: undefined, activityId: 'card', updatedAt: Date.now() - 5 * MIN }));
  await syncOnce();
  assert.equal(pendingOrders(app.orders, app.tombs, app.state).length, 0);
  const all = await (await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'x-pt-sync': code, 'content-type': 'application/json' }, body: '{"since":0}' })).json();
  assert.equal(all.changes.orders.length, 151);

  // 管理頁：改 old-0 的預估、把進行中 live 結成已送達、刪 old-1、新增一筆
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'e2e-password-123' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { csrf } = await (await fetch(`${base}/api/admin/session`, { headers: { cookie } })).json();
  const h = { cookie, 'x-pt-csrf': csrf, 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/admin/orders/old-0`, { method: 'PUT', headers: h, body: JSON.stringify({ estimateMin: 33, amount: 134.76 }) })).status, 200);
  const liveDone = Date.now();
  assert.equal((await fetch(`${base}/api/admin/orders/live`, { method: 'PUT', headers: h, body: JSON.stringify({ status: 'delivered', deliveredAt: liveDone }) })).status, 200);
  assert.equal((await fetch(`${base}/api/admin/orders/old-1`, { method: 'DELETE', headers: h, body: '{}' })).status, 200);
  const created = await (await fetch(`${base}/api/admin/orders`, { method: 'POST', headers: h, body: JSON.stringify({ acceptedAt: T0 + 3_600_000, estimateMin: 12, status: 'delivered', deliveredAt: T0 + 3_600_000 + 11 * MIN }) })).json();

  // 同時本機也刪了 old-2（墓碑）
  app.orders = app.orders.filter((o) => o.id !== 'old-2');
  app.tombs['old-2'] = Date.now();
  await syncOnce();
  const by = Object.fromEntries(app.orders.map((o) => [o.id, o]));
  assert.equal(by['old-0'].estimateMin, 33);
  assert.equal(by['old-0'].amount, 134.76);
  assert.equal(by.live.status, 'delivered');
  assert.equal(by.live.activityId, 'card');
  assert.deepEqual(app.ended.map((o) => o.id), ['live'], '進行中單被管理頁結掉 → 要收動態島');
  assert.equal(by['old-1'], undefined);
  assert.ok(app.tombs['old-1'], '伺服器刪除 → 本機留墓碑（擋原生事件復活）');
  assert.ok(by[created.order.id], '管理頁新增的單同步到 App');
  assert.equal(by[created.order.id].source, 'admin');
  assert.equal(pendingOrders(app.orders, app.tombs, app.state).length, 0, '合併進來的不會再被當成待上傳');
  const srv = await (await fetch(`${base}/api/admin/orders?from=2026-11-01&to=2026-11-12&deleted=1`, { headers: {} })).status;
  assert.equal(srv, 401, '沒有讀取金鑰也沒登入 → 401');
  const after2 = await (await fetch(`${base}/api/sync`, { method: 'POST', headers: { 'x-pt-sync': code, 'content-type': 'application/json' }, body: '{"since":0}' })).json();
  assert.equal(after2.changes.orders.find((o) => o.id === 'old-2').deleted, true, '本機刪除已同步到伺服器');
  assert.equal(after2.changes.orders.find((o) => o.id === 'old-1').deleted, true);
});

test('v1.2 小費：orderToWire/wireToOrder 往返、舊資料（沒 tip）不帶欄位、指紋含 tip', async () => {
  const { normalizeTip, parseTipInput } = await import('../src/orders.ts');
  const o = ord('tp1', { tip: 12.5, updatedAt: T0 + 5 });
  const w = orderToWire(o);
  assert.equal(w.tip, 12.5);
  assert.equal(wireToOrder(w, o).tip, 12.5);
  assert.ok(!('tip' in orderToWire(ord('tp2'))), '沒小費不送 tip（伺服器視為 null）');
  assert.equal(wireToOrder({ ...w, tip: null }).tip, undefined);
  assert.equal(wireToOrder({ ...w, tip: 0 }).tip, undefined);
  assert.equal(wireToOrder({ ...orderToWire(ord('tp3')) }).tip, undefined);
  // 小費變動算同步欄位變更 → 蓋新 updatedAt
  const prev = [ord('tp4', { updatedAt: T0 })];
  const r = stampChanges(prev, [{ ...prev[0], tip: 20 }], T0 + 99_000);
  assert.equal(r.changed, true);
  assert.equal(r.orders[0].updatedAt, T0 + 99_000);
  // 伺服器版合併進本機
  const m = mergeServerOrders([ord('tp5', { updatedAt: T0 })], {}, { tp5: T0 }, [{ ...orderToWire(ord('tp5')), updatedAt: T0 + 10, tip: 8 }]);
  assert.equal(m.orders[0].tip, 8);
  assert.equal(parseSyncResponse({ now: 1, dbId: 'x', changes: { orders: [{ ...w, tip: 9 }, { ...w, id: 'bad', tip: 'x' }] } }).orders.length, 1);
  // 輸入解析
  assert.equal(normalizeTip(0), undefined);
  assert.equal(normalizeTip(1999.996), 2000);
  assert.equal(normalizeTip(2001), undefined);
  assert.deepEqual(parseTipInput('30'), { ok: true, tip: 30 });
  assert.deepEqual(parseTipInput(' $12.50 '), { ok: true, tip: 12.5 });
  assert.deepEqual(parseTipInput(''), { ok: true, tip: undefined });
  assert.deepEqual(parseTipInput('0'), { ok: true, tip: undefined });
  for (const bad of ['-5', 'abc', '1.234', '2001']) assert.deepEqual(parseTipInput(bad), { ok: false }, bad);
});
