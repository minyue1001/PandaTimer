// 今日對帳：server/reconcile.mjs（純函式，真實 telemetry/訂單 fixture）＋ src/reconcile.ts（App 端解析/套用）＋ /api/reconcile 端點。
// fixture（test/fixtures/reconcile-YYYY-MM-DD.json）＝ scripts/telemetry.sh / orders.sh --raw 抓的真資料，
// 已拿掉使用者手動補登的單（source admin、note 含補登/漏記 → 放在 truth）＝模擬補登之前；telemetry 只留對帳用得到的事件與欄位。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exactFare, minutesForFare, reconcile, splitFares, tipSplits, hms } from '../server/reconcile.mjs';
import { exactFare as appFare } from '../src/orders.ts';
import { applyOps, buildOps, initialEdit, parseClock, parseReconcileResponse, reconcileUrlFrom, taipeiDate } from '../src/reconcile.ts';

const FIX = (d) => JSON.parse(fs.readFileSync(new URL(`./fixtures/reconcile-${d}.json`, import.meta.url), 'utf8'));
const DAYS = ['2026-11-15', '2026-11-17', '2026-11-18', '2026-11-19'];
const NOW = Date.parse('2026-11-21T00:00:00+08:00');
const untilOf = (fx) => (fx.until ? Date.parse(`${fx.date}T${fx.until}:00+08:00`) : undefined);
const run = (fx, extra = {}) => reconcile({ date: fx.date, orders: fx.orders, events: fx.events, platform: fx.platform, until: untilOf(fx), now: NOW, ...extra });
const near = (a, b, sec = 90) => a != null && b != null && Math.abs(a - b) <= sec * 1000;
const r2 = (x) => Math.round(x * 100) / 100;

test('報酬公式與 App 一致；金額→分鐘；拆小費；拆多張', () => {
  for (let m = 1; m <= 120; m++) assert.equal(exactFare(m), appFare(m), `m=${m}`);
  assert.deepEqual(minutesForFare(98.01), { min: 24 });
  assert.deepEqual(minutesForFare(45), { min: null, upTo: 11 });
  assert.equal(minutesForFare(98.02), null);
  // 57.17（14 分）＋小費 3 → 60.17
  assert.deepEqual(tipSplits(60.17)[0], { min: 14, upTo: undefined, fare: 57.17, tip: 3 });
  // 19＋29 分＝196.01，但 2 張合計 196.01 不只一種組合
  const sp = splitFares(196.01, 2);
  assert.ok(sp.count > 1);
  assert.ok(sp.solutions.some((s) => s[0] === 19 && s[1] === 29));
  assert.deepEqual(splitFares(90, 2), { count: 1, solutions: [[11, 11]] });
});

test('fixture 沒有個資：telemetry 只有白名單欄位、沒有裝置 id', () => {
  const allowed = new Set(['t', 'src', 'ev', 'note', 'reason', 'delay', 'kw', 'amt', 'accept', 'seq', 'matched', 'screen']);
  for (const d of DAYS) {
    const fx = FIX(d);
    for (const r of fx.events) for (const k of Object.keys(r)) assert.ok(allowed.has(k), `${d} 事件欄位 ${k}`);
    for (const o of fx.orders) assert.deepEqual(Object.keys(o).sort(), ['acceptedAt', 'amount', 'deleted', 'deliveredAt', 'editedBy', 'estimateMin', 'id', 'noTiming', 'note', 'source', 'stacked', 'status', 'tip', 'updatedAt'].sort());
    assert.ok(fx.truth.length >= 1);
  }
});

/** 每個真實日子：找到的補登單數＝truth 數；接單/送達 ≤90 秒；分鐘/金額正確；殘留訊號不算 */
for (const d of DAYS) {
  test(`真實資料 ${d}：找到漏記的單`, () => {
    const fx = FIX(d);
    const out = run(fx);
    const adds = out.proposals.filter((p) => p.type === 'add');
    assert.equal(out.diff.count, fx.truth.length, '件數差＝漏記張數');
    assert.equal(adds.length, fx.truth.length, `候選數：${adds.map((p) => p.text).join(' / ')}`);
    assert.equal(out.proposals.filter((p) => p.type !== 'add').length, 0, '不該有其他提議');
    for (const t of fx.truth) {
      const p = adds.find((x) => near(x.fields.acceptedAt, t.acceptedAt));
      assert.ok(p, `${d} 找不到接單 ${hms(t.acceptedAt)} 的候選：${adds.map((x) => hms(x.fields.acceptedAt)).join(',')}`);
      assert.ok(near(p.fields.deliveredAt, t.deliveredAt), `${d} 送達 ${hms(p.fields.deliveredAt)} vs ${hms(t.deliveredAt)}`);
      assert.equal(p.fields.estimateMin, t.estimateMin);
      assert.equal(p.fields.amount, t.amount);
    }
  });
}

test('2026-11-19：廣播中斷時接單 → 接單＝中斷開始、送達扣 delay；一張、把握高', () => {
  const out = run(FIX('2026-11-19'));
  assert.deepEqual(out.app, { count: 13, amount: 1086.34, tips: 0 });
  assert.deepEqual(out.diff, { count: 1, amount: 98.01, tips: null });
  const [p] = out.proposals;
  assert.equal(p.confidence, 'high');
  assert.equal(hms(p.fields.acceptedAt), '20:06:58');
  assert.equal(hms(p.fields.deliveredAt), '20:35:38');
  assert.deepEqual(p.needs, []);
  assert.match(p.text, /24 分 \$98\.01/);
});

test('2026-11-18：中間 OCR 空白 → 上一張送完＋30 秒接；15:09 的殘留送達訊號不算', () => {
  const out = run(FIX('2026-11-18'));
  assert.deepEqual(out.diff, { count: 1, amount: 57.17, tips: 0 });
  const [p] = out.proposals;
  assert.equal(hms(p.fields.acceptedAt), '12:08:15');
  assert.equal(p.confidence, 'high');
  assert.ok(out.info.some((s) => s.includes('15:09:06')), out.info.join('|'));
});

test('2026-11-17：兩張（一張沒有送達訊號 → 送達待填、用收入畫面推估）；殘留訊號 19:01/19:28/21:21 不算', () => {
  const out = run(FIX('2026-11-17'));
  assert.deepEqual(out.diff, { count: 2, amount: 196.01, tips: null });
  const adds = out.proposals.filter((p) => p.type === 'add');
  const noSignal = adds.find((p) => p.needs.includes('deliveredAt'));
  assert.ok(noSignal, '19:30 那張要列為送達待填');
  assert.equal(hms(noSignal.fields.acceptedAt), '19:30:22');
  for (const p of adds) assert.equal(p.confidence, 'low', '兩張合計多解 → 要使用者確認');
  for (const t of ['19:01:51', '19:28:06', '21:21:51']) assert.ok(out.info.some((s) => s.includes(t)), t);
});

test('2026-11-15：三連疊單的一張（送達時 App 手上還有別張）；03:07:53 殘留不算', () => {
  const out = run(FIX('2026-11-15'));
  const [p] = out.proposals;
  assert.equal(out.proposals.length, 1);
  assert.equal(p.confidence, 'high');
  assert.ok(near(p.fields.acceptedAt, Date.parse('2026-11-15T02:40:30+08:00'), 30));
  assert.ok(out.info.some((s) => s.includes('03:07:53')));
});

test('平台＝App（含補登）→ 沒有新增提議', () => {
  for (const d of DAYS) {
    const fx = FIX(d);
    const orders = [...fx.orders, ...fx.truth.map((t, i) => ({ ...t, id: `truth-${i}`, status: 'delivered', deleted: false, source: 'admin', editedBy: 'admin' }))];
    const out = reconcile({ date: d, orders, events: fx.events, platform: fx.platform, until: untilOf(fx), now: NOW });
    assert.deepEqual(out.diff, { count: 0, amount: 0, tips: fx.platform.tips != null ? 0 : null }, d);
    assert.equal(out.proposals.length, 0, `${d}：${out.proposals.map((p) => p.text).join('/')}`);
  }
});

test('被取消的單其實送了 → 優先提議還原（新增當二選一備選）', () => {
  const fx = FIX('2026-11-19');
  // 模擬：漏的那張其實 App 有記，但 20:09 被誤按取消
  const t = fx.truth[0];
  const canceled = { id: 'c1', acceptedAt: Date.parse('2026-11-19T20:07:05+08:00'), estimateMin: 24, deliveredAt: null, status: 'canceled', amount: 98.01, tip: null, noTiming: null, stacked: false, source: 'auto', note: '', updatedAt: Date.parse('2026-11-19T20:09:00+08:00'), deleted: false, editedBy: 'app' };
  const out = run(fx, { orders: [...fx.orders, canceled] });
  const restore = out.proposals.find((p) => p.type === 'restore');
  assert.ok(restore, out.proposals.map((p) => p.text).join('/'));
  assert.equal(restore.orderId, 'c1');
  assert.equal(restore.confidence, 'high');
  assert.ok(near(restore.fields.deliveredAt, t.deliveredAt));
  const alt = out.proposals.find((p) => p.type === 'add');
  assert.equal(alt.confidence, 'low');
  assert.equal(alt.alternativeTo, restore.id);
});

test('小費：平台小費多 15 → 找到「小費 $15」送達畫面那張', () => {
  const fx = FIX('2026-11-15');
  const until = Date.parse('2026-11-15T20:00:00+08:00');
  const all = [...fx.orders, ...fx.truth.map((t, i) => ({ ...t, id: `truth-${i}`, status: 'delivered', deleted: false }))];
  const done = all.filter((o) => o.status === 'delivered' && o.acceptedAt < until);
  const tips = r2(done.reduce((s, o) => s + (o.tip || 0), 0));
  const platform = { count: done.filter((o) => !o.noTiming).length, amount: r2(done.reduce((s, o) => s + o.amount, 0) + tips), tips };
  const target = all.find((o) => o.tip === 15 && o.acceptedAt < until);
  const out = reconcile({ date: fx.date, orders: all.map((o) => (o === target ? { ...o, tip: null } : o)), events: fx.events, platform, until, now: NOW });
  assert.deepEqual(out.diff, { count: 0, amount: 15, tips: 15 });
  const tip = out.proposals.find((p) => p.type === 'tip');
  assert.equal(tip.orderId, target.id);
  assert.equal(tip.fields.tip, 15);
  assert.equal(tip.confidence, 'high');
  assert.equal(out.proposals.filter((p) => p.type === 'add').length, 0);
});

test('App 多記／金額不對 → 只列出檢查項目，不自動處理', () => {
  const fx = FIX('2026-11-19');
  const orders = [...fx.orders, ...fx.truth.map((t, i) => ({ ...t, id: `truth-${i}`, status: 'delivered', deleted: false }))];
  const base = { count: 14, amount: 1184.35 };
  const more = reconcile({ date: fx.date, orders, events: fx.events, platform: { count: 13, amount: r2(base.amount - 49.01) }, now: NOW });
  assert.equal(more.diff.count, -1);
  const reviews = more.proposals.filter((p) => p.type === 'review');
  assert.ok(reviews.length >= 1);
  for (const p of reviews) {
    assert.deepEqual(p.actions, ['delete', 'cancel']);
    assert.equal(p.confidence, 'low');
  }
  assert.ok(reviews[0].text.includes('$49.01'), reviews[0].text);
  // 件數對、金額多 4.08 → 哪張分鐘可能讀錯（改分鐘/金額）
  const amt = reconcile({ date: fx.date, orders, events: fx.events, platform: { count: 14, amount: r2(base.amount + 4.08) }, now: NOW });
  const edits = amt.proposals.filter((p) => p.type === 'review' && p.actions?.includes('edit'));
  assert.ok(edits.length >= 1);
  for (const p of edits) assert.equal(minutesForFare(p.fields.amount)?.min, p.fields.estimateMin);
});

test('k=1、金額不是單價（沒給小費總額）→ 列「報酬＋小費」選項', () => {
  const fx = FIX('2026-11-19');
  const out = run(fx, { platform: { count: 14, amount: r2(1184.35 + 20) } });
  const [p] = out.proposals;
  assert.ok(p.needs.includes('choice'));
  assert.equal(p.options[0].fields.amount, 98.01);
  assert.equal(p.options[0].fields.tip, 20);
});

test('App 端：解析回應 → 編輯 → 產生操作 → 套用到本機紀錄', () => {
  assert.equal(reconcileUrlFrom('https://x.example/pandatimer/api/sync'), 'https://x.example/pandatimer/api/reconcile');
  assert.equal(reconcileUrlFrom(null), null);
  assert.equal(taipeiDate(Date.parse('2026-11-19T16:30:00Z')), '2026-11-20');
  assert.equal(parseClock('20:06:58', '2026-11-19'), Date.parse('2026-11-19T20:06:58+08:00'));
  assert.equal(parseClock('25:00', '2026-11-19'), null);

  const res = parseReconcileResponse(JSON.parse(JSON.stringify(run(FIX('2026-11-19')))));
  assert.ok(res);
  const [p] = res.proposals;
  assert.equal(initialEdit(p).accepted, '20:06:58');
  const { ops, errors } = buildOps(res.date, [p], {});
  assert.deepEqual(errors, []);
  assert.equal(ops[0].kind, 'add');
  const applied = applyOps([], ops, () => 'new1');
  assert.equal(applied.done, 1);
  const o = applied.orders[0];
  assert.equal(o.status, 'delivered');
  assert.equal(o.source, 'admin');
  assert.equal(o.estimateMin, 24);
  assert.equal(o.amount, 98.01);
  assert.equal(o.actualMin, 28.7);
  assert.match(o.note, /^對帳補登/);

  // 使用者改分鐘/時間；送達早於接單（跨午夜）
  const e2 = buildOps(res.date, [p], { [p.id]: { accepted: '23:50', delivered: '00:20', minutes: '30', amount: '122.51' } });
  assert.deepEqual(e2.errors, []);
  assert.equal(e2.ops[0].deliveredAt - e2.ops[0].acceptedAt, 30 * 60_000);
  // 待填欄位沒填 → 錯誤、不套用
  const blank = { id: 'b', type: 'add', confidence: 'low', text: '空白', fields: { acceptedAt: null, deliveredAt: null, estimateMin: null, amount: null }, needs: ['acceptedAt'] };
  assert.equal(buildOps(res.date, [blank], {}).errors.length, 1);

  // 還原、小費、取消、改金額
  const orders = [
    { id: 'c', acceptedAt: 1, estimateMin: 10, deadline: 600_001, status: 'canceled', amount: 45 },
    { id: 'd', acceptedAt: 1, estimateMin: 10, deadline: 600_001, status: 'delivered', deliveredAt: 600_001, actualMin: 10, amount: 45 },
  ];
  const out = applyOps(orders, [
    { kind: 'restore', id: 'c', deliveredAt: 900_001 },
    { kind: 'tip', id: 'd', tip: 15 },
    { kind: 'edit', id: 'd', estimateMin: 12, amount: 49.01 },
    { kind: 'restore', id: 'd', deliveredAt: 1 }, // 不是取消的單 → 略過
    { kind: 'tip', id: 'nope', tip: 1 },
  ], () => 'x');
  assert.equal(out.done, 3);
  assert.deepEqual(out.skipped, ['d', 'nope']);
  const c = out.orders.find((x) => x.id === 'c');
  assert.equal(c.status, 'delivered');
  assert.equal(c.actualMin, 15);
  const dd = out.orders.find((x) => x.id === 'd');
  assert.equal(dd.tip, 15);
  assert.equal(dd.amount, 49.01);
  assert.equal(dd.deadline, 1 + 12 * 60_000);
  const cancel = applyOps(orders, [{ kind: 'cancel', id: 'd' }], () => 'x').orders.find((x) => x.id === 'd');
  assert.equal(cancel.status, 'canceled');
  assert.equal(cancel.deliveredAt, undefined);
});

// ── 端點：/api/reconcile（同步碼）、/api/admin/reconcile（cookie＋CSRF 或讀取金鑰） ──
const SERVER = new URL('../server/index.mjs', import.meta.url).pathname;
const PW = 'correct-horse-battery';
const READ_KEY = 'read-key-0123456789abcdef0123456789';
const SEED = 'ABCD-EFGH-JKLM';
let child;
let tmp;
let base;
/** 把 11/19 fixture 平移到「昨天」（端點只收最近 14 天） */
let shifted;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-reconcile-test-'));
  const fx = FIX('2026-11-19');
  const TAIPEI = 8 * 3_600_000;
  const yesterday = new Date(Date.now() + TAIPEI - 86_400_000).toISOString().slice(0, 10);
  const delta = Date.parse(`${yesterday}T00:00:00+08:00`) - Date.parse('2026-11-19T00:00:00+08:00');
  const mv = (x) => (typeof x === 'number' ? x + delta : x);
  shifted = {
    date: yesterday,
    orders: fx.orders.map((o) => ({ ...o, id: `${o.id}-s`, acceptedAt: mv(o.acceptedAt), deliveredAt: mv(o.deliveredAt), updatedAt: Math.min(mv(o.updatedAt), Date.now()) })),
    events: fx.events.map((r) => ({ ...r, t: r.t + delta, ts: new Date(r.t + delta).toISOString() })),
    truth: fx.truth.map((t) => ({ ...t, acceptedAt: mv(t.acceptedAt), deliveredAt: mv(t.deliveredAt) })),
  };
  const telDir = path.join(tmp, 'telemetry');
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(path.join(telDir, `${yesterday}.jsonl`), shifted.events.map((r) => JSON.stringify(r)).join('\n') + '\n');
  child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: '0',
      UPDATES_DIR: path.join(tmp, 'updates'),
      TELEMETRY_DIR: telDir,
      CONFIG_PATH: path.join(tmp, 'config.json'),
      DATA_DIR: path.join(tmp, 'data'),
      TELEMETRY_WRITE_KEY: 'write-key-0123456789abcdef0123456789',
      TELEMETRY_READ_KEY: READ_KEY,
      ADMIN_PASSWORD: PW,
      SYNC_CODE: SEED,
      ADMIN_COOKIE_SECURE: '0',
      SYNC_RATE_PER_MIN: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
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
  // 訂單經 /api/sync 上傳（跟 App 一樣）
  const res = await fetch(`${base}/api/sync`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pt-sync': SEED },
    body: JSON.stringify({ since: 0, changes: { orders: shifted.orders } }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.accepted.orders, shifted.orders.length, JSON.stringify(body.invalid));
});
after(() => {
  if (child && child.exitCode == null) child.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (p, body, headers = {}) => {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('POST /api/reconcile：同步碼驗證、參數驗證、找到漏記的那張', async () => {
  const q = { date: shifted.date, count: 14, amount: 1184.35 };
  assert.equal((await post('/api/reconcile', q)).status, 401);
  assert.equal((await post('/api/reconcile', q, { 'x-pt-sync': 'WXYZ-WXYZ-WXYZ' })).status, 401);
  assert.equal((await fetch(`${base}/api/reconcile`)).status, 405);
  const auth = { 'x-pt-sync': SEED };
  assert.equal((await post('/api/reconcile', { ...q, date: '2026-13-01' }, auth)).status, 400);
  assert.equal((await post('/api/reconcile', { ...q, date: '2020-01-01' }, auth)).status, 400);
  assert.equal((await post('/api/reconcile', { ...q, count: 1.5 }, auth)).status, 400);
  assert.equal((await post('/api/reconcile', { ...q, amount: 'x' }, auth)).status, 400);
  assert.equal((await post('/api/reconcile', { ...q, until: '9am' }, auth)).status, 400);
  const r = await post('/api/reconcile', q, auth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.app, { count: 13, amount: 1086.34, tips: 0 });
  assert.deepEqual(r.body.diff, { count: 1, amount: 98.01, tips: null });
  assert.equal(r.body.proposals.length, 1);
  const p = r.body.proposals[0];
  assert.equal(p.type, 'add');
  assert.ok(near(p.fields.acceptedAt, shifted.truth[0].acceptedAt));
  assert.ok(near(p.fields.deliveredAt, shifted.truth[0].deliveredAt));
  assert.equal(p.fields.amount, 98.01);
  // App 端解析得了
  assert.ok(parseReconcileResponse(r.body));
  // until：只看到 20:00（漏的那張還沒接）→ 平台數字也只到那時
  const early = await post('/api/reconcile', { date: shifted.date, count: 6, amount: 400, until: '20:00' }, auth);
  assert.equal(early.status, 200);
  assert.equal(early.body.app.count, 5);
});

test('POST /api/admin/reconcile：cookie＋CSRF（或讀取金鑰）才行', async () => {
  const q = { date: shifted.date, count: 14, amount: 1184.35 };
  assert.equal((await post('/api/admin/reconcile', q)).status, 401);
  assert.equal((await post('/api/admin/reconcile', q, { 'x-pt-read': 'bad' })).status, 401);
  const viaKey = await post('/api/admin/reconcile', q, { 'x-pt-read': READ_KEY });
  assert.equal(viaKey.status, 200);
  assert.equal(viaKey.body.proposals.length, 1);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PW }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const s = await (await fetch(`${base}/api/admin/session`, { headers: { cookie } })).json();
  assert.equal((await post('/api/admin/reconcile', q, { cookie })).status, 403);
  const ok = await post('/api/admin/reconcile', q, { cookie, 'x-pt-csrf': s.csrf });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.diff, { count: 1, amount: 98.01, tips: null });
  // 套用：走既有管理 API 新增 → 再對一次差額歸零
  const f = ok.body.proposals[0].fields;
  const add = await post('/api/admin/orders', { acceptedAt: f.acceptedAt, deliveredAt: f.deliveredAt, estimateMin: f.estimateMin, amount: f.amount, status: 'delivered', note: f.note }, { cookie, 'x-pt-csrf': s.csrf });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const again = await post('/api/admin/reconcile', q, { cookie, 'x-pt-csrf': s.csrf });
  assert.deepEqual(again.body.diff, { count: 0, amount: 0, tips: null });
  assert.equal(again.body.proposals.length, 0);
});
