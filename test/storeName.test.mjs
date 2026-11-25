// v1.4 店家名稱（邀請畫面 → 店名；Swift 同構）＋拒單紀錄純函式（server/reconcile.mjs declinedOffers、src/declined.ts）
// ＋同步 wire 的 store 欄位（src/sync.ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  STORE_ADDR_MARK_RX,
  STORE_ADDR_TEXT_RX,
  STORE_REJECT_RX,
  STORE_STOP_RX,
  cleanStoreName,
  extractStoreName,
  summarizeScreen,
} from '../src/screenInfo.ts';
import { DEFAULT_OFFER, OfferTracker } from '../src/offerTracker.ts';
import { declinedOffers, hms, taipeiDayStart } from '../server/reconcile.mjs';
import { cleanStore } from '../server/orders.mjs';
import { declinedByDay, declinedRowText, declinedUrlFrom, parseDeclinedResponse, participation, participationText } from '../src/declined.ts';
import { mergeServerOrders, orderToWire, parseWireOrder, stampChanges, syncFingerprint, wireToOrder } from '../src/sync.ts';
import { normalizeStore } from '../src/orders.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

// 使用者提供的兩個實機邀請（OCR 行序）；客人那段用假資料
const INVITE_1 = [
  '每單收入', '94.01 $ (6.2 公里)', '23 分鐘', '微笑早午餐 (高雄藍田店)', '(△)高雄市楠梓區藍田路847號',
  '送餐資訊', '德中路 328 , 811, 高雄市', '王小明', '樓層 3F', '拒絕', '接受訂單',
].join('\n');
const INVITE_2 = [
  '每單收入', '45 $ (2.1 公里)', '9 分鐘', '麥當勞 (S596 高雄德中店)', '(X)高雄市楠梓區德中路666號',
  '送餐資訊', '公館路 50 , 826, 高雄市', '接受訂單',
].join('\n');

test('店名：兩個實機例子', () => {
  assert.equal(extractStoreName(INVITE_1), '微笑早午餐 (高雄藍田店)');
  assert.equal(extractStoreName(INVITE_2), '麥當勞 (S596 高雄德中店)');
  assert.equal(summarizeScreen(INVITE_1).store, '微笑早午餐 (高雄藍田店)');
  assert.equal(summarizeScreen(INVITE_2).store, '麥當勞 (S596 高雄德中店)');
});

test('店名：干擾例（不抓客人資訊、抓不準就 null）', () => {
  // 組合單：兩個送餐資訊 → 同一個店名；第二位客人的資料不看
  const bundle = INVITE_1.replace('拒絕', '送餐資訊\n公館路 50號, 826, 高雄市\n陳大華\n拒絕');
  assert.equal(extractStoreName(bundle), '微笑早午餐 (高雄藍田店)');
  // 沒有「送餐資訊」→ 不取（分不出哪段是客人）
  assert.equal(extractStoreName(INVITE_1.replace('送餐資訊', '取餐資訊')), null);
  // 店家地址行沒讀到、只有送餐資訊之後的客人地址（含「號」）→ null（絕不往後找）
  assert.equal(extractStoreName('每單收入\n94.01 $\n23 分鐘\n微笑早午餐\n送餐資訊\n德中路328號\n王小明\n接受訂單'), null);
  // 店名那行沒讀到：地址上一行是分鐘 → null（不往更上面找）
  assert.equal(extractStoreName('每單收入\n94.01 $\n23 分鐘\n(△)高雄市楠梓區藍田路847號\n送餐資訊\n接受訂單'), null);
  // 上一行是金額/公里/UI 字 → null
  assert.equal(extractStoreName('每單收入\n94.01 $ (6.2 公里)\n(△)高雄市楠梓區藍田路847號\n送餐資訊\n接受訂單'), null);
  assert.equal(extractStoreName('夾單訂單依系統顯示金額為主\n(X)高雄市楠梓區德中路666號\n送餐資訊\n接受訂單'), null);
  assert.equal(extractStoreName('每單收入\n(X)高雄市楠梓區德中路666號\n送餐資訊\n接受訂單'), null);
  assert.equal(extractStoreName('94.01\n(X)高雄市楠梓區德中路666號\n送餐資訊\n接受訂單'), null);
  // 地址符號被 OCR 讀成 (A)／全形括號；地址沒有符號但有「市…區」
  assert.equal(extractStoreName('23 分鐘\n八方雲集 (楠梓店)\n(A)高雄市楠梓區德中路1號\n送餐資訊\n接受訂單'), '八方雲集 (楠梓店)');
  assert.equal(extractStoreName('23 分鐘\n八方雲集\n（○）德中路1號\n送餐資訊\n接受訂單'), '八方雲集');
  assert.equal(extractStoreName('23 分鐘\n八方雲集\n高雄市楠梓區德中路\n送餐資訊\n接受訂單'), '八方雲集');
  // 空白/全形空白收成一個、超過 40 字截斷
  assert.equal(extractStoreName('23 分鐘\n  八方　 雲集  \n(X)德中路1號\n送餐資訊'), '八方 雲集');
  const long = '超'.repeat(55);
  assert.equal(extractStoreName(`23 分鐘\n${long}\n(X)德中路1號\n送餐資訊`), '超'.repeat(40));
  // 沒有接單鈕（不是邀請畫面）→ summarize 不取
  assert.equal(summarizeScreen(INVITE_1.replace('接受訂單', '')).store, null);
  // 空/null
  assert.equal(extractStoreName(''), null);
  assert.equal(extractStoreName(null), null);
  // 結果不含客人資訊
  for (const t of [INVITE_1, INVITE_2, bundle]) {
    const s = extractStoreName(t);
    for (const leak of ['德中路 328', '王小明', '公館路', '陳大華', '樓層', '號']) assert.ok(!s.includes(leak), `${leak} in ${s}`);
  }
});

test('店名清理：TS 三份一致（screenInfo / server cleanStore / App normalizeStore）', () => {
  for (const x of ['  a\u0001b  c ', '超'.repeat(50), '', '   ', 'OK 店', 12, null]) {
    const a = cleanStoreName(x);
    assert.equal(cleanStore(x), a);
    assert.equal(normalizeStore(x) ?? null, a);
  }
});

test('Swift 同構：正則與 TS 相同、analyze 帶 store、OfferTracker/telemetry 帶店名', () => {
  const swift = read('../targets/broadcast/OrderDetector.swift');
  const lit = (name) => {
    const m = new RegExp(`static let ${name} =\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(swift);
    assert.ok(m, name);
    return m[1].replace(/\\\\/g, '\\');
  };
  assert.equal(lit('storeStopPattern'), STORE_STOP_RX.source);
  assert.equal(lit('storeAddrMarkPattern').replace(/\\x\{(\w+)\}/g, '\\u$1'), STORE_ADDR_MARK_RX.source);
  assert.equal(lit('storeAddrTextPattern'), STORE_ADDR_TEXT_RX.source);
  assert.equal(lit('storeRejectPattern'), STORE_REJECT_RX.source);
  assert.equal(lit('storeNumericPattern'), '^[0-9.,:+\\-()（）%]*$');
  assert.ok(read('../src/screenInfo.ts').includes('const STORE_NUMERIC_RX = /^[0-9.,:+\\-()（）%]*$/;'));
  assert.ok(swift.includes('static let storeMax = 40'));
  assert.ok(swift.includes('store: accept ? extractStoreName(raw) : nil)'));
  const tracker = read('../targets/broadcast/OfferTracker.swift');
  assert.ok(tracker.includes('store = s.store'));
  assert.ok(tracker.includes('if let st = o.store, !st.isEmpty { out.store = st }'));
  const ext = read('../targets/broadcast/SampleHandler.swift');
  assert.equal((ext.match(/if let st = d\.offer\.store \{ fields\["store"\] = st \}/g) || []).length, 2, 'order＋offer_decided 都帶');
  // 店名只在這兩個事件：其他 log 不准帶 store
  assert.equal((ext.match(/"store"/g) || []).length, 2);
});

test('OfferTracker（TS）：邀請畫面讀到的店名進 Offer，判定（接/未接）都帶著', () => {
  const run = (after) => {
    const t = new OfferTracker(DEFAULT_OFFER, 90);
    const ev = [];
    ev.push(...t.observe(0, summarizeScreen(INVITE_1)));
    // 第二幀店名沒讀到 → 保留前一次
    ev.push(...t.observe(1.5, summarizeScreen(INVITE_1.replace('微笑早午餐 (高雄藍田店)', ''))));
    ev.push(...t.observe(3, summarizeScreen('')), ...t.observe(4.5, summarizeScreen('')), ...t.observe(6, summarizeScreen(after)));
    return ev;
  };
  const acc = run('前往取餐');
  assert.equal(acc[0].offer.store, '微笑早午餐 (高雄藍田店)');
  const d1 = acc.find((e) => e.type === 'decided');
  assert.equal(d1.result, 'accept');
  assert.equal(d1.offer.store, '微笑早午餐 (高雄藍田店)');
  const d2 = run('已拒絕').find((e) => e.type === 'decided');
  assert.equal(d2.result, 'reject');
  assert.equal(d2.offer.store, '微笑早午餐 (高雄藍田店)');
});

// ── 拒單 ──
const FIX = JSON.parse(read('./fixtures/declined-real.json'));
const dayOf = (d) => ({ ...FIX.days[d], from: taipeiDayStart(d), to: taipeiDayStart(d) + 86_400_000 });

test('拒單 2026-11-25（真資料）：18:32 14 分逾時、19:17 7 分、19:18 8 分、19:19 24 分；接單的都不算', () => {
  const d = dayOf('2026-11-25');
  const list = declinedOffers({ events: d.events, orders: d.orders, from: d.from, to: d.to });
  assert.deepEqual(
    list.map((x) => [hms(x.t).slice(0, 5), x.min, x.amt, x.reason]),
    [
      ['18:32', 14, 57.17, 'timeout'],
      ['19:17', 7, 45, 'superseded'],
      ['19:18', 8, 45, 'superseded'],
      ['19:19', 24, 98.01, 'timeout'],
    ],
  );
  assert.equal(list[0].km, 3.3, '公里從 offer_seen 補');
  const live = d.orders.filter((o) => !o.deleted && o.status !== 'canceled');
  const p = participation(live, list, { start: d.from, end: d.to });
  assert.deepEqual([p.accepted, p.declined], [11, 4]);
  assert.equal(participationText(p), '參與率約 73%（接 11／派 15）');
});

test('拒單 2026-11-22（真資料）：18:43 逾時後按「有接」（confirm 單）→ 不算拒單', () => {
  const d = dayOf('2026-11-22');
  const list = declinedOffers({ events: d.events, orders: d.orders, from: d.from, to: d.to });
  assert.deepEqual(list.map((x) => [hms(x.t).slice(0, 5), x.min, x.reason]), [['17:51', 13, 'timeout'], ['18:38', 11, 'timeout']]);
  // 拿掉那張 confirm 單 → 18:43 那張就算拒單
  const noConfirm = d.orders.filter((o) => o.source !== 'confirm');
  assert.equal(declinedOffers({ events: d.events, orders: noConfirm, from: d.from, to: d.to }).length, 3);
});

test('拒單去重規則：誤讀 replaced、60 秒內同一張、之後被判接單、有訂單', () => {
  const T = Date.UTC(2026, 10, 25, 10, 0, 0);
  const ev = (dt, o) => ({ src: 'ext', t: T + dt * 1000, ...o });
  const seen = (dt, min, amt, extra = {}) => ev(dt, { ev: 'offer_seen', min, amt, ...extra });
  const rej = (dt, min, amt, reason, extra = {}) => ev(dt, { ev: 'offer_decided', result: 'reject', min, amt, reason, wait: 5, ...extra });
  const run = (events, orders = []) => declinedOffers({ events, orders, from: T - 3_600_000, to: T + 3_600_000 });
  // 正常一張逾時：時間＝offer_seen、店名從判定事件
  assert.deepEqual(run([seen(0, 14, 57.17, { km: 3.3 }), rej(65, 14, 57.17, 'timeout', { store: '微笑早午餐' })]).map((x) => [x.t, x.km, x.store]), [[T, 3.3, '微笑早午餐']]);
  // replaced 且金額不可能（14 分 $5.7 → 誤讀）→ 不算；replaced 後 10 秒內同分鐘新邀請 → 同一張重讀
  assert.equal(run([seen(0, 14, 5.71), rej(3, 14, 5.71, 'replaced'), seen(3, 14, 57.17)]).length, 0);
  assert.equal(run([seen(0, 14, 57.17), rej(3, 14, 57.17, 'replaced'), seen(4, 14, 57.17)]).length, 0);
  // replaced 換成不同分鐘的另一張 → 算
  assert.equal(run([seen(0, 14, 57.17), rej(3, 14, 57.17, 'replaced'), seen(4, 20, 81.67)]).length, 1);
  // 60 秒內同分鐘同金額兩筆拒單 → 一張；隔 2 分鐘 → 兩張
  assert.equal(run([seen(0, 7, 45), rej(20, 7, 45, 'superseded'), seen(25, 7, 45), rej(50, 7, 45, 'timeout')]).length, 1);
  assert.equal(run([seen(0, 7, 45), rej(20, 7, 45, 'superseded'), seen(140, 7, 45), rej(170, 7, 45, 'timeout')]).length, 2);
  // 判未接後 60 秒內同一張又被判接單（或 ext order）→ 不算
  assert.equal(run([seen(0, 9, 45), rej(20, 9, 45, 'timeout'), ev(50, { ev: 'offer_decided', result: 'accept', min: 9, amt: 45 })]).length, 0);
  assert.equal(run([seen(0, 9, 45), rej(20, 9, 45, 'timeout'), ev(50, { ev: 'order', min: 9, amt: 45 })]).length, 0);
  // 有訂單（confirm／auto，任何狀態）同分鐘、接單 ±120 秒 → 不算；分鐘不同或太遠 → 算；已刪的不算數
  const o = (dt, min, extra = {}) => ({ acceptedAt: T + dt * 1000, estimateMin: min, status: 'delivered', source: 'confirm', deleted: false, ...extra });
  assert.equal(run([seen(0, 13, 53.09), rej(60, 13, 53.09, 'timeout')], [o(5, 13)]).length, 0);
  assert.equal(run([seen(0, 13, 53.09), rej(60, 13, 53.09, 'timeout')], [o(170, 13, { source: 'auto', status: 'canceled' })]).length, 0);
  assert.equal(run([seen(0, 13, 53.09), rej(60, 13, 53.09, 'timeout')], [o(5, 14)]).length, 1);
  assert.equal(run([seen(0, 13, 53.09), rej(60, 13, 53.09, 'timeout')], [o(400, 13)]).length, 1);
  assert.equal(run([seen(0, 13, 53.09), rej(60, 13, 53.09, 'timeout')], [o(5, 13, { deleted: true })]).length, 1);
  // 舊事件沒有 result（只有 note）也認；範圍外的不列
  assert.equal(run([seen(0, 7, 45), ev(20, { ev: 'offer_decided', note: 'reject', min: 7, amt: 45, reason: 'rejected' })]).length, 1);
  assert.equal(declinedOffers({ events: [seen(0, 7, 45), rej(20, 7, 45, 'timeout')], orders: [], from: T + 1000, to: T + 3_600_000 }).length, 0);
  // app 來源的事件不算
  assert.equal(run([{ ...rej(20, 7, 45, 'timeout'), src: 'app' }]).length, 0);
});

test('App 拒單：解析、依日分組、列文字、參與率、網址', () => {
  const T = Date.UTC(2026, 10, 25, 11, 17, 15); // 19:17:15 台北
  const raw = {
    declined: [
      { t: T, min: 7, amt: 45, km: 0.9, store: ' 麥當勞\u0001 (德中店) ', reason: 'superseded' },
      { t: T - 86_400_000, min: 14, amt: null, km: null, store: null, reason: 'timeout' },
      { t: 'x', min: 7 },
      { t: T, min: 0 },
      null,
    ],
  };
  const list = parseDeclinedResponse(raw);
  assert.equal(list.length, 2);
  assert.equal(list[0].store, '麥當勞 (德中店)');
  assert.equal(declinedRowText(list[0]), '19:17・7 分・$45・0.9 公里・麥當勞 (德中店)・未接');
  assert.equal(declinedRowText(list[1]), '19:17・14 分・逾時');
  const byDay = declinedByDay(list);
  assert.deepEqual([...byDay.keys()], ['2026-11-25', '2026-11-24']);
  assert.equal(parseDeclinedResponse({}), null);
  assert.equal(parseDeclinedResponse([]), null);
  assert.equal(declinedUrlFrom('https://x.example/pandatimer/api/sync'), 'https://x.example/pandatimer/api/declined');
  assert.equal(declinedUrlFrom(null), null);
  const range = { start: T - 3_600_000, end: T + 3_600_000 };
  const orders = [
    { acceptedAt: T - 60_000, status: 'delivered' },
    { acceptedAt: T, status: 'active' },
    { acceptedAt: T, status: 'canceled' },
    { acceptedAt: T - 7_200_000, status: 'delivered' },
  ];
  assert.deepEqual(participation(orders, list, range), { accepted: 2, declined: 1, rate: 2 / 3 });
  assert.equal(participation([], [], range), null);
});

// ── 同步 wire ──
test('同步 wire：store 往返、指紋含 store、伺服器補的店名（同 updatedAt）App 會套用', () => {
  const T0 = Date.UTC(2026, 10, 25, 10, 0, 0);
  const base = { id: 's1', acceptedAt: T0, estimateMin: 23, deadline: T0 + 23 * 60_000, status: 'delivered', deliveredAt: T0 + 20 * 60_000, actualMin: 20, source: 'auto', updatedAt: T0 + 20 * 60_000 };
  // 本機沒店名 → wire 不帶
  assert.equal('store' in orderToWire(base), false);
  const withStore = { ...base, store: '微笑早午餐 (高雄藍田店)' };
  assert.equal(orderToWire(withStore).store, '微笑早午餐 (高雄藍田店)');
  assert.notEqual(syncFingerprint(base), syncFingerprint(withStore));
  const w = parseWireOrder({ ...orderToWire(base), store: '  微笑早午餐  ', deleted: false });
  assert.equal(w.store, '微笑早午餐');
  assert.equal(wireToOrder(w).store, '微笑早午餐');
  assert.equal(wireToOrder({ ...w, store: null }).store, undefined);
  assert.equal(parseWireOrder({ ...orderToWire(base), store: 5, deleted: false }).store, undefined);
  // 伺服器補店名：updatedAt 不變、內容不同 → 套用（本機已上傳過這版）
  const m = mergeServerOrders([base], {}, { s1: base.updatedAt }, [{ ...orderToWire(base), store: '微笑早午餐', deleted: false }]);
  assert.equal(m.applied, 1);
  assert.equal(m.orders[0].store, '微笑早午餐');
  assert.equal(m.orders[0].updatedAt, base.updatedAt);
  // 本機有較新的修改（還沒上傳）→ 伺服器補店名的舊版不蓋掉本機（LWW）；之後伺服器回送的 echo（同 updatedAt＋店名）才套用
  const edited = { ...base, tip: 30, updatedAt: base.updatedAt + 60_000 };
  const keep = mergeServerOrders([edited], {}, { s1: base.updatedAt }, [{ ...orderToWire(base), store: '微笑早午餐', deleted: false }]);
  assert.equal(keep.applied, 0);
  assert.equal(keep.orders[0].tip, 30);
  const echo = mergeServerOrders([edited], {}, { s1: edited.updatedAt }, [{ ...orderToWire(edited), store: '微笑早午餐', deleted: false }]);
  assert.equal(echo.orders[0].tip, 30);
  assert.equal(echo.orders[0].store, '微笑早午餐');
  // 同步套用不蓋 updatedAt；本機改別的欄位 → 店名留著
  const st = stampChanges(echo.orders, [{ ...echo.orders[0], note: 'x' }], edited.updatedAt + 5);
  assert.equal(st.orders[0].store, '微笑早午餐');
});
