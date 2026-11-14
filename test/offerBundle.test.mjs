// v1.2（11/14 實機五件事）：組合單拆分、小費、金額誤讀、常駐字不當接單證據、送單畫面 N 筆訂單提示（TS＝Swift 的測試替身）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evenSplit, screenOrderCount, ScreenOrdersWatch, splitBundle } from '../src/offerBundle.ts';
import { DEFAULT_OFFER, OfferTracker, acceptEvidence, fareCents, plausibleAmount, sameOffer } from '../src/offerTracker.ts';
import { extractOrderCount, extractTip, summarizeScreen } from '../src/screenInfo.ts';
import { exactFare } from '../src/orders.ts';
import {
  allSignalNames,
  MAX_SIGNAL_NAMES,
  pairedTip,
  parseDetectorStatus,
  parseSignalName,
  screenOrdersName,
  TIP_SIGNAL_VALUES,
  tipSignalName,
  tipSignalValue,
} from '../src/detector.ts';
import { applyNativeEvents, parseNativeEvents } from '../src/nativeEvents.ts';
import { EMPTY_STATE, matchOrder, parseMinutesInput, recordOffer, screenOrdersHint } from '../src/unconfirmedOffers.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const compact = (t) => t.replace(/\s+/g, '');

// ── ① 組合單 ──
const BUNDLE_INVITE = '每單收入\n94.01 $\n(6.2 公里)\n23 分鐘\n店名\n送餐資訊\n顧客A\n送餐資訊\n顧客B\n接受訂單';

test('組合單拆分：94.01/23 分/2 張 → [12, 11]（49.01＋45）；扣掉小費後同樣能拆', () => {
  assert.deepEqual(splitBundle(23, 94.01, 2), [12, 11]);
  assert.equal(Math.round((exactFare(12) + exactFare(11)) * 100), 9401);
  assert.deepEqual(splitBundle(23, 124.01, 2, 30), [12, 11]);
  // 誤差 ≤0.02 也算
  assert.deepEqual(splitBundle(23, 94.03, 2), [12, 11]);
});

test('組合單拆分：多解或無解 → 平均分（餘數給前面）；不夠分/不是組合單 → 不拆', () => {
  // 10 分 $90：1+9、2+8…5+5 全都是 45+45 → 多解
  assert.deepEqual(splitBundle(10, 90, 2), [5, 5]);
  assert.deepEqual(splitBundle(11, 90, 2), [6, 5]);
  // 無解（金額對不上任何組合，例如含了沒讀到的小費）
  assert.deepEqual(splitBundle(23, 150, 2), [12, 11]);
  assert.deepEqual(splitBundle(25, 150, 3), [9, 8, 8]);
  // 沒金額 → 平均分
  assert.deepEqual(splitBundle(23, null, 2), [12, 11]);
  assert.deepEqual(splitBundle(23, 94.01, 1), [23]);
  assert.deepEqual(splitBundle(1, 45, 2), [1]);
  assert.deepEqual(splitBundle(30, 200, 9).length, 4); // 上限 4 張
  assert.deepEqual(evenSplit(23, 2), [12, 11]);
  // 三張：12+12+11 → 49.01×2＋45（唯一解）
  assert.deepEqual(splitBundle(35, 143.02, 3), [12, 12, 11]);
  // 兩張都 ≥12 分：報酬幾乎線性 → 15+15、14+16… 都對得上 → 多解 → 平均分
  assert.deepEqual(splitBundle(30, exactFare(15) * 2, 2), [15, 15]);
  assert.deepEqual(splitBundle(31, exactFare(13) + exactFare(18), 2), [16, 15]);
});

test('組合單畫面：「送餐資訊」出現 2 次 → bundle 2；接單後 Offer.bundle 2（給 extension 拆單）', () => {
  const s = summarizeScreen(BUNDLE_INVITE);
  assert.deepEqual([s.accept, s.minutes, s.amount, s.bundle], [true, 23, 94.01, 2]);
  assert.equal(summarizeScreen('送餐资讯\n送餐資訊\n接受訂單').bundle, 2);
  assert.equal(summarizeScreen('每單收入\n57.17 $\n14 分鐘\n送餐資訊\n接受訂單').bundle, 1);
  const t = new OfferTracker({ ...DEFAULT_OFFER, ambiguousAs: 'reject' }, 90);
  const ev = [
    ...t.observe(0, summarizeScreen('每單收入\n94.01 $\n23 分鐘\n送餐資訊\n接受訂單')), // 第一次只讀到一個區塊
    ...t.observe(0.6, s),
    ...t.observe(1.2, summarizeScreen('')),
    ...t.observe(1.8, summarizeScreen('')),
    ...t.observe(2.4, summarizeScreen('店名\n預計7分鐘後抵達店家・2筆訂單')),
  ];
  const d = ev.find((e) => e.type === 'decided');
  assert.deepEqual([d.result, d.offer.minutes, d.offer.bundle], ['accept', 23, 2]);
  assert.deepEqual(splitBundle(d.offer.minutes, d.offer.amount, d.offer.bundle, d.offer.tip), [12, 11]);
});

// ── ② 小費 ──
test('小費解析：「包含額外 30.00 $ 元」→ 30；簡體/無空白/全形點也收；沒有 → null', () => {
  assert.equal(extractTip(compact('包含額外 30.00 $ 元')), 30);
  assert.equal(extractTip(compact('包含额外30$元')), 30);
  assert.equal(extractTip(compact('包含額外 $ 12.5 元')), 13);
  assert.equal(extractTip(compact('包含額外 50．00 $')), 50);
  assert.equal(extractTip(compact('每單收入 95.34 $')), null);
  assert.equal(extractTip(compact('包含額外 0.00 $ 元')), null);
  assert.equal(extractTip(compact('包含額外 2500 $ 元')), null);
  const s = summarizeScreen('每單收入\n95.34 $\n包含額外 30.00 $ 元\n(4.6 公里)\n16 分鐘\n送餐資訊\n接受訂單');
  assert.deepEqual([s.minutes, s.amount, s.tip], [16, 95.34, 30]);
  assert.equal(summarizeScreen('每單收入\n65.34 $\n16 分鐘\n接受訂單').tip, null);
  // 邀請金額含小費：95.34 − 30 ＝ 16 分的報酬
  assert.equal(Math.round((s.amount - s.tip) * 100), fareCents(16));
});

test('小費訊號：值 1~100、110~300 每 10；超過 300 送 300；名稱解析得回來；App 端 10 秒內配對', () => {
  assert.equal(TIP_SIGNAL_VALUES.length, 120);
  assert.equal(tipSignalValue(30), 30);
  assert.equal(tipSignalValue(100), 100);
  assert.equal(tipSignalValue(101), 100);
  assert.equal(tipSignalValue(105), 110);
  assert.equal(tipSignalValue(144), 140);
  assert.equal(tipSignalValue(295), 300);
  assert.equal(tipSignalValue(2000), 300);
  assert.equal(tipSignalValue(0), null);
  assert.equal(tipSignalValue(NaN), null);
  for (let t = 1; t <= 2000; t++) assert.ok(TIP_SIGNAL_VALUES.includes(tipSignalValue(t)), String(t));
  assert.deepEqual(parseSignalName(tipSignalName(30)), { kind: 'tip', yuan: 30 });
  assert.deepEqual(parseSignalName('com.pandatimer.tip.300'), { kind: 'tip', yuan: 300 });
  for (const bad of ['0', '105', '301', '030', '1000', 'x']) assert.equal(parseSignalName(`com.pandatimer.tip.${bad}`), null, bad);
  assert.equal(pairedTip(20_000, { yuan: 30, at: 12_000 }), 30);
  assert.equal(pairedTip(20_000, { yuan: 30, at: 9_000 }), null); // 超過 10 秒
  assert.equal(pairedTip(20_000, { yuan: 30, at: 21_500 }), 30); // 亂序 2 秒內
  assert.equal(pairedTip(20_000, null), null);
});

test('小費進 start 事件 → Order.tip；壞值/0 不寫', () => {
  const base = { type: 'start', acceptedAt: 1000, estimateMin: 16, deadline: 1000 + 16 * 60_000, source: 'auto' };
  const ev = parseNativeEvents([
    { ...base, id: 'a', tip: 30 },
    { ...base, id: 'b', tip: 0 },
    { ...base, id: 'c', tip: 'x' },
    { ...base, id: 'd' },
  ]);
  assert.deepEqual(ev.map((e) => e.tip), [30, undefined, undefined, undefined]);
  const orders = applyNativeEvents([], ev);
  const byId = Object.fromEntries(orders.map((o) => [o.id, o]));
  assert.equal(byId.a.tip, 30);
  assert.equal(byId.a.amount, 65.34);
  for (const id of ['b', 'c', 'd']) assert.ok(!('tip' in byId[id]), id);
});

// ── ③ 金額誤讀 ──
test('same()：分鐘相同且一方金額不可能地低 → 同一張；兩個都合理但不同 → 不同張', () => {
  assert.equal(sameOffer(11, 45, 11, 11), true);
  assert.equal(sameOffer(12, 49.01, 12, 1), true);
  assert.equal(sameOffer(16, 65.34, 16, 95.34), false);
  assert.equal(sameOffer(11, 45, 12, 11), false);
  assert.equal(plausibleAmount(11, 45), true);
  assert.equal(plausibleAmount(11, 44.99), true); // fare−0.01 還算合理（OCR 進位誤差）
  assert.equal(plausibleAmount(11, 44.98), false);
  assert.equal(plausibleAmount(23, null), true);
  for (let m = 1; m <= 90; m++) assert.equal(fareCents(m), Math.round(exactFare(m) * 100), String(m));
  // 狀態機：誤讀不判 replaced，金額保留合理的
  const t = new OfferTracker(DEFAULT_OFFER, 90);
  const ev = [
    ...t.observe(0, summarizeScreen('每單收入\n45.00 $\n11 分鐘\n接受訂單')),
    ...t.observe(4, summarizeScreen('每單收入\n11 $\n11 分鐘\n接受訂單')),
    ...t.observe(5, summarizeScreen('')),
    ...t.observe(6, summarizeScreen('')),
    ...t.observe(7, summarizeScreen('前往取餐')),
  ];
  assert.deepEqual(ev.map((e) => e.type), ['seen', 'decided']);
  assert.equal(ev[1].offer.amount, 45);
  // 先誤讀、後讀到合理金額 → 換成合理的
  const t2 = new OfferTracker(DEFAULT_OFFER, 90);
  t2.observe(0, summarizeScreen('每單收入\n11 $\n11 分鐘\n接受訂單'));
  t2.observe(1, summarizeScreen('每單收入\n45.00 $\n11 分鐘\n接受訂單'));
  t2.observe(2, summarizeScreen(''));
  t2.observe(3, summarizeScreen(''));
  const d2 = t2.observe(4, summarizeScreen('前往取餐')).find((e) => e.type === 'decided');
  assert.equal(d2.offer.amount, 45);
  assert.equal(d2.offer.key, '11/45');
});

// ── ④ 常駐字 ──
test('筆訂單/取餐體驗單獨命中不算接單證據；「取餐體驗」裡的「取餐」一起去掉；抵達店家仍是強證據', () => {
  const delivering = summarizeScreen('即將抵達\n1筆訂單\n取餐體驗如何呢?');
  assert.deepEqual([delivering.offerAccepted, delivering.acceptStrong, delivering.acceptWeak, delivering.orders], [true, false, true, 1]);
  const pickup = summarizeScreen('預計7分鐘後抵達店家・2筆訂單\n再 8 分鐘即將準備完成');
  assert.deepEqual([pickup.acceptStrong, pickup.acceptWeak, pickup.orders], [true, true, 2]);
  assert.equal(summarizeScreen('前往取餐').acceptStrong, true);
  assert.equal(summarizeScreen('前往取餐').acceptWeak, false);
  assert.equal(extractOrderCount(compact('抵達店家・ 3 筆訂單')), 3);
  assert.equal(extractOrderCount(compact('筆訂單')), null);
  // acceptEvidence：只剩常駐字 → 看邀請前
  const weakOnly = { offerAccepted: true, acceptStrong: false, acceptWeak: true, orders: 1 };
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: 1 }, weakOnly), false);
  assert.equal(acceptEvidence({ baseWeak: false, baseOrders: null }, weakOnly), true);
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: 1 }, { ...weakOnly, orders: 2 }), true);
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: null }, { ...weakOnly, orders: 2 }), false);
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: 1 }, { ...weakOnly, acceptStrong: true }), true);
  // 舊樣本（沒有 acceptStrong 欄）＝舊行為
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: 1 }, { offerAccepted: true }), true);
  assert.equal(acceptEvidence({ baseWeak: false, baseOrders: null }, { offerAccepted: false }), false);
});

test('11:53 實機重現：送前一張（畫面一直有 1筆訂單）時沒接 14 分邀請 → 不判 accepted；邀請前的紀錄只看 120 秒內', () => {
  const s = (t) => summarizeScreen(t);
  const run = (gap) => {
    const t = new OfferTracker({ ...DEFAULT_OFFER, ambiguousAs: 'reject', decideWindowSec: 45 }, 90);
    const ev = [
      ...t.observe(0, s('送達\n無法聯繫顧客\n1筆訂單')),
      ...t.observe(gap, s('每單收入\n57.17 $\n14 分鐘\n送餐資訊\n接受訂單')),
      ...t.observe(gap + 3, s('即將抵達\n1筆訂單\n取餐體驗如何呢?')),
      ...t.observe(gap + 4, s('即將抵達\n1筆訂單\n取餐體驗如何呢?')),
      ...t.tick(gap + 60),
    ];
    return ev.find((e) => e.type === 'decided');
  };
  const d = run(10);
  assert.deepEqual([d.result, d.reason], ['reject', 'timeout']);
  // 常駐字是 3 分鐘前看到的（超過 BASELINE_SEC）→ 當作邀請前沒看過 → 算接單
  const d2 = run(200);
  assert.deepEqual([d2.result, d2.reason], ['accept', 'accepted']);
});

// ── ⑤ 送單畫面 N 筆訂單 ──
test('screenOrderCount：N 筆訂單取 N、只有「疊單」＝2、都沒有 → null', () => {
  assert.equal(screenOrderCount(2, false), 2);
  assert.equal(screenOrderCount(null, true), 2);
  assert.equal(screenOrderCount(3, true), 3);
  assert.equal(screenOrderCount(1, false), 1);
  assert.equal(screenOrderCount(null, false), null);
  const s = summarizeScreen('疊單\n店名A\n店名B');
  assert.deepEqual([s.stackScreen, s.orders], [true, null]);
  assert.equal(summarizeScreen('叠单').stackScreen, true);
});

test('ScreenOrdersWatch 去抖：連 2 次同 N 才送、同 N 5 分鐘一次、邀請中/接單鈕重置、接單後 15 秒內不送、N 上限 5', () => {
  const w = new ScreenOrdersWatch();
  assert.equal(w.observe(0, 2, false), null); // 第一次
  assert.equal(w.observe(2, 2, false), 2); // 連續第二次 → 送
  assert.equal(w.observe(4, 2, false), null); // 5 分鐘內同 N 不再送
  assert.equal(w.observe(100, 2, false), null);
  assert.equal(w.observe(301, 2, false), null); // 上次送在 2 秒 → 還差 1 秒
  assert.equal(w.observe(303, 2, false), 2); // 超過 300 秒 → 再送
  // 中間斷掉（沒讀到/邀請中）→ 重新計
  const w2 = new ScreenOrdersWatch();
  assert.equal(w2.observe(0, 3, false), null);
  assert.equal(w2.observe(1, null, false), null);
  assert.equal(w2.observe(2, 3, false), null);
  assert.equal(w2.observe(3, 3, true), null);
  assert.equal(w2.observe(4, 3, false), null);
  assert.equal(w2.observe(5, 3, false), 3);
  // N 變了 → 重新計；N=1 不送；>5 → 5
  assert.equal(w2.observe(6, 1, false), null);
  assert.equal(w2.observe(7, 9, false), null);
  assert.equal(w2.observe(8, 9, false), 5);
  // 接單後 15 秒內不送（組合單第二張訊號還在路上），之後照常
  const w3 = new ScreenOrdersWatch();
  w3.accepted(100);
  assert.equal(w3.observe(101, 2, false), null);
  assert.equal(w3.observe(103, 2, false), null);
  assert.equal(w3.observe(116, 2, false), 2);
  assert.equal(screenOrdersName(2), 'com.pandatimer.screenorders.2');
  assert.equal(screenOrdersName(7), 'com.pandatimer.screenorders.5');
  assert.equal(screenOrdersName(1), null);
  assert.deepEqual(parseSignalName('com.pandatimer.screenorders.3'), { kind: 'screenOrders', count: 3 });
  for (const bad of ['1', '6', '02']) assert.equal(parseSignalName(`com.pandatimer.screenorders.${bad}`), null, bad);
});

test('App 提示卡：原生 screenOrders → 進行中 < N 才顯示；補記到 N、按過「不用」、超過 30 分鐘 → 不顯示', () => {
  const st = parseDetectorStatus(JSON.stringify({ armed: true, screenOrders: 2, screenOrdersActive: 1, screenOrdersAt: 1000 }));
  assert.deepEqual(st.screenOrders, { n: 2, active: 1, at: 1000 });
  assert.equal(parseDetectorStatus(JSON.stringify({ armed: true })).screenOrders, undefined);
  const so = st.screenOrders;
  assert.deepEqual(screenOrdersHint(so, 1, null, 5000), { n: 2, active: 1, at: 1000 });
  assert.equal(screenOrdersHint(so, 2, null, 5000), null);
  assert.equal(screenOrdersHint(so, 1, 1000, 5000), null);
  assert.deepEqual(screenOrdersHint(so, 1, 999, 5000)?.n, 2);
  assert.equal(screenOrdersHint(so, 1, null, 1000 + 30 * 60_000), null);
  assert.equal(screenOrdersHint(null, 0, null, 5000), null);
  assert.equal(parseMinutesInput('5'), 5);
  assert.equal(parseMinutesInput(' 12 '), 12);
  for (const bad of ['0', '91', '5.5', '', 'abc', null]) assert.equal(parseMinutesInput(bad), null, String(bad));
});

test('未確認邀請：組合單拆出來的分鐘（12）帶 offerMin（23）→ 收掉 23 分那張；第二張沒有 offerMin 不動別張', () => {
  let s = recordOffer(EMPTY_STATE, 23, 1000, 'x');
  s = recordOffer(s, 11, 2000, 'y');
  s = matchOrder(s, 12, 23);
  assert.deepEqual(s.pending.map((e) => e.min), [11]);
  // 同分鐘優先（superseded 時 offerMin 指的是後一張）
  let s2 = recordOffer(recordOffer(EMPTY_STATE, 20, 1000, 'a'), 15, 2000, 'b');
  s2 = matchOrder(s2, 20, 15);
  assert.deepEqual(s2.pending.map((e) => e.min), [15]);
  assert.deepEqual(matchOrder(s2, 11), s2);
});

// ── Darwin 名稱總數與 Swift 同步 ──
test('Darwin 名稱：v1.2 共 874 個（< 1000）；Swift DetectorHub/extension 名稱與 TS 一致', () => {
  const names = allSignalNames();
  assert.equal(names.length, 874);
  assert.ok(names.length < MAX_SIGNAL_NAMES);
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['"com.pandatimer.tip."', '"com.pandatimer.screenorders."']) {
    assert.ok(hub.includes(s), `DetectorHub 缺 ${s}`);
    assert.ok(ext.includes(s), `SampleHandler 缺 ${s}`);
  }
  assert.ok(hub.includes('static let tipValues: [Int] = Array(1...100) + stride(from: 110, through: 300, by: 10).map { $0 }'));
  assert.ok(hub.includes('for v in tipValues { names.append("\\(tipPrefix)\\(v)") }'));
  assert.ok(hub.includes('for n in 2...5 { names.append("\\(screenOrdersPrefix)\\(n)") }'));
  assert.ok(hub.includes('if let t = tip { order["tip"] = t }'));
  assert.ok(hub.includes('static let tipPairBefore: TimeInterval = 10'));
  assert.ok(ext.includes('return (tip + 5) / 10 * 10'));
  // extension：小費在 order 之前送；組合單逐張送
  const part = ext.slice(ext.indexOf('private func sendOrderPart('), ext.indexOf('/// 畫面分類或接單鈕狀態有變才記一筆'));
  assert.ok(part.indexOf('PandaSignal.postTip(') < part.indexOf('PandaSignal.postOrder('));
  assert.ok(ext.includes('BundleSplit.split(totalMinutes: minutes, amount: d.offer.amount, count: bundle, tip: d.offer.tip)'));
  // Swift 規則鏡像
  const ot = read('../targets/broadcast/OfferTracker.swift');
  for (const s of [
    'max(4500, minutes * 24500 / 60 + 1)',
    'if !plausible(minutesA, amountA) || !plausible(minutesB, amountB) { return true }',
    'let better = !plausible(offer.minutes, offer.amount) && plausible(offer.minutes, amount)',
    'static let baselineSec: TimeInterval = 120',
    'if !offer.baseWeak { return true }',
    `static let defaultWeakAcceptedKeywords = "${DEFAULT_OFFER.weakAcceptedKeywords}"`,
    `static let defaultBundleKeywords = "${DEFAULT_OFFER.bundleKeywords}"`,
    `var maxBundle = ${DEFAULT_OFFER.maxBundle}`,
    'maxBundle = RemoteConfig.int(o["maxBundle"], 1, 4, maxBundle)',
    'if found.count > 1 { return }',
    'return found.count == 1 ? found[0] : evenParts',
    'var repeatSec: TimeInterval = 300',
    'var quietSec: TimeInterval = 15',
  ]) assert.ok(ot.includes(s), s);
  const od = read('../targets/broadcast/OrderDetector.swift');
  assert.ok(od.includes('private static let tipPattern = "包含[額额]外(?:NT)?[$＄]?([0-9]{1,4}(?:[.．][0-9]{1,2})?)"'));
  assert.ok(od.includes('private static let ordersPattern = "([1-9])(?:筆|笔)(?:訂單|订单)"'));
});
