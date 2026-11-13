// v1.1 以「#單號」配對送達：單號擷取、接單 seq 綁定、對話框消失判定、OCR 誤讀防護、App 槽對應
// （TS 版＝targets/broadcast/OrderNumbers.swift、OfferTracker.swift、DetectorHub.swift 的測試替身）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_DIALOG_KEYWORDS,
  DIALOG_NO_PATTERN,
  ORDER_NO_PATTERN,
  OrderNumberBook,
  deliveryNumber,
  extractOrderNumbers,
  hasDeliveryDialog,
  mergeScans,
  scanNumbers,
  slotOf,
} from '../src/orderNumbers.ts';
import { DEFAULT_DELIVERY, DeliveryWatch, pickDeliveredOrder } from '../src/deliveryDetector.ts';
import { DEFAULT_OFFER, OfferTracker } from '../src/offerTracker.ts';
import { summarizeScreen } from '../src/screenInfo.ts';
import { DELIVERED_SEQ_PREFIX, deliveredSeqName, parseSignalName, slotTarget, slotsAfterOrder } from '../src/detector.ts';
import { stackMark } from '../src/nativeEvents.ts';
import { DEFAULT_CONFIG, validateConfig } from '../src/remoteConfig.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const swiftLit = (s) => s.replaceAll('\\', '\\\\');

const DIALOG = 'z0ja-2646-icgr(#7318) 是否已送達?\n確認已送達  取消';
const DIALOG_BUTTON_ONLY = '確認已送達\n取消'; // 主 OCR（下半部）只看得到按鈕
const DIALOG_QUESTION = 'z0ja-2646-icgr(#7318)\n是否已送達?'; // 上方補掃看到問句

test('單號擷取：#/＃、全形數字、去前導 0、不收 6 位以上、去重', () => {
  assert.deepEqual(extractOrderNumbers('#7318\nz0ja-2646-icgr - #7318 - 王小明'), ['7318']);
  assert.deepEqual(extractOrderNumbers('＃ ７３１８ 與 #0042'), ['7318', '42']);
  assert.deepEqual(extractOrderNumbers('#123456 #0 2646'), []);
  assert.deepEqual(extractOrderNumbers(''), []);
  assert.deepEqual(extractOrderNumbers(null), []);
});

test('對話框單號：優先取緊接「是否已送達」的；否則畫面上只有一個號碼才用', () => {
  assert.equal(deliveryNumber(DIALOG), '7318');
  assert.equal(deliveryNumber(DIALOG_QUESTION), '7318');
  assert.equal(deliveryNumber('#1111 #2222\nabc(#7318）是否送達'), '7318');
  assert.equal(deliveryNumber('#1111 #2222\n是否已送達?'), '2222'); // 問句換行也算緊接
  assert.equal(deliveryNumber('#1111 #2222 取餐\n是否已送達?'), null);
  assert.equal(deliveryNumber('送餐中 #5566'), '5566');
  assert.equal(deliveryNumber('確認已送達'), null);
});

test('對話框/按鈕偵測：預設字樣、去空白、壞正則退回預設', () => {
  assert.equal(hasDeliveryDialog(DIALOG_BUTTON_ONLY), true);
  assert.equal(hasDeliveryDialog('確 認 已 送 達'), true);
  assert.equal(hasDeliveryDialog('是否已送达?'), true);
  assert.equal(hasDeliveryDialog('完成訂單\n聯絡\n無法聯繫'), false);
  assert.equal(hasDeliveryDialog('確認已送達', '(['), true);
  assert.equal(hasDeliveryDialog('交付完成', '交付完成'), true);
});

test('主畫面＋上方補掃合併：號碼聯集、對話框號碼以補掃為準', () => {
  const main = scanNumbers(DIALOG_BUTTON_ONLY);
  assert.deepEqual(main, { numbers: [], dialogNo: null, dialog: true, final: false });
  const merged = mergeScans(main, scanNumbers(DIALOG_QUESTION));
  assert.deepEqual(merged, { numbers: ['7318'], dialogNo: '7318', dialog: true, final: false });
  assert.deepEqual(mergeScans(main, null), main);
  // 「訂單完成」彈窗在上半部：主畫面看不到、補掃看到
  const popup = mergeScans(scanNumbers('上線中'), scanNumbers('訂單完成\n#7318'));
  assert.equal(popup.final, true);
  assert.equal(scanNumbers('訂單完成', undefined, '([').final, true); // 壞正則退回預設
});

test('DeliveryWatch：對話框不見了但同一單號還在畫面上（聊天/拍照/捲動）→ 不算消失；單號也不見才算', () => {
  const w = new DeliveryWatch();
  w.observe(0, W({ dialog: true, dialogNo: '7318' }));
  assert.equal(w.observe(5, W({ numbers: ['7318'] })), null);
  assert.equal(w.deadline, null);
  assert.equal(w.observe(6, W({ numbers: ['7318', '8001'] })), null);
  assert.equal(w.tick(30), null);
  assert.equal(w.active, true);
  assert.equal(w.observe(40, W({ numbers: ['8001'] })), null); // 換到下一張單的頁面
  assert.deepEqual(w.tick(41), { kind: 'send', delaySec: 1, why: 'disappear', no: '7318' });
  // 沒讀到對話框單號 → 這條防護不適用
  const v = new DeliveryWatch();
  v.observe(0, W({ dialog: true }));
  v.observe(5, W({ numbers: ['7318'] }));
  assert.equal(v.deadline, 6);
});

test('綁號：恰好一個新號碼 → 給最近一張還沒綁號的；已綁/已送過/兩個以上/超過時窗/接單前就出現 → 不綁', () => {
  const b = new OrderNumberBook(300);
  b.accepted(1, 100);
  assert.equal(b.pendingBind(100), true);
  assert.deepEqual(b.bind(101, ['7318']), { seq: 1, waitSec: 1 });
  assert.equal(b.pendingBind(101), false);
  b.accepted(2, 200);
  assert.equal(b.bind(201, ['7318']), null); // 已綁過
  assert.equal(b.bind(202, ['8001', '8002']), null); // 兩個新號碼：不確定
  assert.deepEqual(b.bind(203, ['7318', '8001']), { seq: 2, waitSec: 3 }); // 7318 已綁 → 只剩 8001
  // 時窗外不綁
  b.accepted(3, 300);
  assert.equal(b.bind(700, ['9001']), null);
  // 接單前就在畫面上的號碼（例如前一張單的頁面）不綁給新單
  const c = new OrderNumberBook(300);
  c.see(10, ['5555']);
  c.accepted(0, 50);
  assert.equal(c.bind(51, ['5555']), null);
  c.see(52, ['6666']);
  assert.deepEqual(c.bind(53, ['5555', '6666']), null); // 兩個候選
  assert.deepEqual(c.bind(54, ['6666']), { seq: 0, waitSec: 4 });
});

test('resolve：綁過 → seq＋槽；沒號碼/沒綁過 → plain；同槽有更新的單 → slotReused；送過 1 小時內 → repeat', () => {
  const b = new OrderNumberBook(300);
  b.accepted(1, 0);
  b.bind(1, ['7318']);
  assert.deepEqual(b.resolve(10, '7318'), { kind: 'seq', seq: 1, slot: 1 });
  assert.deepEqual(b.resolve(10, null), { kind: 'plain', reason: 'noNumber' });
  assert.deepEqual(b.resolve(10, '9999'), { kind: 'plain', reason: 'unbound' });
  b.markSent(10, '7318', 1);
  assert.deepEqual(b.resolve(20, '7318'), { kind: 'repeat' });
  assert.deepEqual(b.resolve(10 + 3600, '7318'), { kind: 'plain', reason: 'unbound' });
  // 沒綁過的號碼送過也記住，不重送
  b.markSent(30, '9999', null);
  assert.deepEqual(b.resolve(40, '9999'), { kind: 'repeat' });
  // 槽：seq 2 與 seq 6 同槽 → 舊的那張不能用槽
  const c = new OrderNumberBook(300);
  c.accepted(2, 0);
  c.bind(1, ['1111']);
  c.accepted(6, 100);
  c.bind(101, ['2222']);
  assert.deepEqual(c.resolve(200, '1111'), { kind: 'plain', reason: 'slotReused' });
  assert.deepEqual(c.resolve(200, '2222'), { kind: 'seq', seq: 6, slot: 2 });
  assert.equal(slotOf(7), 3);
  assert.equal(slotOf(-1), 3);
});

const W = (o) => ({ dialog: false, final: false, panda: true, dialogNo: null, changed: true, ...o });

test('DeliveryWatch：按鈕/對話框一直在 → 不送；消失（連 2 次）→ 以第一次消失的時間送', () => {
  const w = new DeliveryWatch();
  assert.deepEqual(w.observe(0, W({ dialog: true, dialogNo: '7318' })), { kind: 'visible' });
  assert.equal(w.knowsNumber, true);
  for (let t = 10; t <= 120; t += 10) assert.equal(w.observe(t, W({ dialog: true })), null); // 等在門口 2 分鐘
  assert.equal(w.observe(130, W({ changed: false, panda: true })), null); // 第 1 次沒看到（同畫面重掃，不啟動計時）
  assert.equal(w.deadline, null);
  assert.deepEqual(w.observe(132, W({})), { kind: 'send', delaySec: 2, why: 'disappear', no: '7318' });
  assert.equal(w.active, false);
});

test('DeliveryWatch：畫面變了的第 1 次沒看到 → 1 秒內沒再出現就送（計時器）；又出現 → 重來', () => {
  const w = new DeliveryWatch();
  w.observe(0, W({ dialog: true }));
  assert.equal(w.observe(5, W({})), null);
  assert.equal(w.deadline, 6);
  assert.equal(w.tick(5.5), null);
  assert.deepEqual(w.tick(6.2), { kind: 'send', delaySec: 1, why: 'disappear', no: null });
  // 又出現 → 重來
  const v = new DeliveryWatch();
  v.observe(0, W({ dialog: true, dialogNo: '1' }));
  v.observe(5, W({}));
  assert.equal(v.observe(5.4, W({ dialog: true })), null);
  assert.equal(v.deadline, null);
  assert.equal(v.tick(10), null);
});

test('DeliveryWatch：切到別的 App（不是 pandarider）不算消失；訂單完成＝確認；之後 60 秒內的訂單完成不重送', () => {
  const w = new DeliveryWatch();
  w.observe(0, W({ dialog: true, dialogNo: '42' }));
  assert.equal(w.observe(3, W({ panda: false })), null);
  assert.equal(w.observe(6, W({ panda: false })), null);
  assert.equal(w.tick(20), null);
  assert.equal(w.active, true);
  assert.deepEqual(w.observe(21, W({ final: true })), { kind: 'send', delaySec: 0, why: 'finalAfterDialog', no: '42' });
  assert.equal(w.observe(22, W({ final: true })), null); // 同一個彈窗
  assert.equal(w.observe(23, W({})), null);
  assert.equal(w.observe(24, W({})), null);
  assert.deepEqual(w.observe(40, W({ final: true })), { kind: 'repeat' });
  // 從沒看到對話框的「訂單完成」→ 照送（退路）
  const v = new DeliveryWatch();
  assert.deepEqual(v.observe(0, W({ final: true })), { kind: 'send', delaySec: 0, why: 'final', no: null });
});

test('DeliveryWatch.finish：按鈕還在（沒按）→ 不送；剛消失 → 送', () => {
  const w = new DeliveryWatch();
  w.observe(0, W({ dialog: true }));
  assert.equal(w.finish(10), null);
  const v = new DeliveryWatch();
  v.observe(0, W({ dialog: true, dialogNo: '9' }));
  v.observe(3, W({}));
  assert.deepEqual(v.finish(3.5), { kind: 'send', delaySec: 1, why: 'stopped', no: '9' });
});

test('11/13 三張疊單重演：A/B/C 依單號各自結，送達順序 B→C→A，事後重複的對話框不再結', () => {
  // extension 端（秒）：接單 → 接單後畫面看到 #號 → 綁；送達對話框（號碼在上方補掃）→ 消失 → resolve
  const book = new OrderNumberBook(DEFAULT_DELIVERY.bindWindowSec);
  const watch = new DeliveryWatch();
  const T = (hms) => { const [h, m, s] = hms.split(':').map(Number); return h * 3600 + m * 60 + s; };
  const bindScreen = (t, text) => {
    const sum = summarizeScreen(text);
    const sc = scanNumbers(text);
    book.see(t, sc.numbers);
    if (!sum.accept && !sc.dialog && sum.offerAccepted && book.pendingBind(t)) return book.bind(t, sc.numbers);
    return null;
  };
  book.accepted(1, T('11:40:20')); // A（seq 1，14 分）
  assert.equal(bindScreen(T('11:40:22'), '#3001\n預計7分鐘後抵達店家・1筆訂單\n取餐體驗如何呢?').seq, 1);
  book.accepted(2, T('11:42:10')); // B（seq 2，7 分）
  assert.equal(bindScreen(T('11:42:12'), '#3001 #3002\n抵達店家\n2筆訂單').seq, 2);
  book.accepted(3, T('11:42:55')); // C（seq 3，3 分）
  assert.equal(bindScreen(T('11:42:58'), '#3002\n#3003\n即將準備完成\n3筆訂單').seq, 3);

  const signals = [];
  const deliver = (t0, no) => {
    // 抵達：送餐頁出現「確認已送達」按鈕（下半部）＋上方問句；等一下才按
    const main = scanNumbers(DIALOG_BUTTON_ONLY);
    const extra = scanNumbers(`z0ja-2646-icgr(#${no})\n是否已送達?`);
    const sc = mergeScans(main, extra);
    watch.observe(t0, W({ dialog: sc.dialog, dialogNo: sc.dialogNo }));
    watch.observe(t0 + 20, W({ dialog: true })); // 按鈕還在
    const a = watch.observe(t0 + 45, W({})) ?? watch.tick(t0 + 46);
    assert.equal(a.kind, 'send');
    const r = book.resolve(t0 + 46, a.no);
    if (r.kind === 'seq') book.markSent(t0 + 46, a.no, r.seq);
    signals.push(r.kind === 'seq' ? deliveredSeqName(r.seq) : r.kind);
    return a;
  };
  assert.equal(deliver(T('11:44:00'), '3002').delaySec, 1); // B
  deliver(T('11:55:30'), '3003'); // C
  deliver(T('12:04:00'), '3001'); // A
  assert.deepEqual(signals, [`${DELIVERED_SEQ_PREFIX}2`, `${DELIVERED_SEQ_PREFIX}3`, `${DELIVERED_SEQ_PREFIX}1`]);
  // 12:05:47 起又看到 A 的對話框（同號）→ 不再結
  watch.observe(T('12:05:47'), W({ dialog: true, dialogNo: '3001' }));
  const again = watch.observe(T('12:05:50'), W({})) ?? watch.tick(T('12:05:51'));
  assert.deepEqual(book.resolve(T('12:05:51'), again.no), { kind: 'repeat' });

  // App 端（毫秒）：槽 → 訂單 id；送達對到 → 只結那張（就算剛接、就算 90 秒內有手動結單）
  let map = {};
  map = slotsAfterOrder(map, 1, 0, 'A', 1);
  map = slotsAfterOrder(map, 2, 0, 'B', 2);
  map = slotsAfterOrder(map, 3, 0, 'C', 3);
  const active = [
    { id: 'A', acceptedAt: 0, deadline: 14 * 60_000 },
    { id: 'B', acceptedAt: 110_000, deadline: 110_000 + 7 * 60_000 },
    { id: 'C', acceptedAt: 155_000, deadline: 155_000 + 3 * 60_000 },
  ];
  const settings = { enabled: true, minOrderAgeSec: 120 };
  assert.deepEqual(pickDeliveredOrder(active, 160_000, settings, 159_000, slotTarget(map, 2, 10)), { id: 'B' });
  // 先送 A 的時候：舊邏輯（沒對到）挑截止最早且滿 120 秒的 → B（結錯）；單號對到槽 1 → A
  assert.deepEqual(pickDeliveredOrder(active, 240_000, settings, null), { id: 'B' });
  assert.deepEqual(pickDeliveredOrder(active, 240_000, settings, null, slotTarget(map, 1, 10)), { id: 'A' });
  // 對到的單已手動送達 → 不退回挑別張
  assert.deepEqual(pickDeliveredOrder(active.filter((o) => o.id !== 'B'), 240_000, settings, null, 'B'), { skip: 'matchedGone' });
});

test('App 槽對應：漏掉的槽清掉、太舊不算；delivered.seq 名稱編解碼', () => {
  let map = slotsAfterOrder({}, 0, 0, 'x0', 0);
  map = slotsAfterOrder(map, 1, 0, 'x1', 0);
  map = slotsAfterOrder(map, 2, 0, 'x2', 0);
  // 收到槽 1、中間漏了 2 則（槽 3、槽 0）→ 槽 3/0 清掉
  map = slotsAfterOrder(map, 1, 2, 'y1', 10);
  assert.deepEqual(Object.keys(map).sort(), ['1', '2']);
  assert.equal(slotTarget(map, 1, 20), 'y1');
  assert.equal(slotTarget(map, 0, 20), null);
  assert.equal(slotTarget(map, 2, 4 * 3600_000 + 1), null);
  for (let seq = 0; seq < 9; seq++) assert.deepEqual(parseSignalName(deliveredSeqName(seq)), { kind: 'deliveredSeq', slot: seq % 4 });
  for (const bad of ['4', '01', '-1', '', 'a']) assert.equal(parseSignalName(`${DELIVERED_SEQ_PREFIX}${bad}`), null, bad);
  assert.deepEqual(parseSignalName('com.pandatimer.delivered'), { kind: 'delivered' });
});

test('OCR 誤讀防護：分鐘 < 3 且同畫面有接單後字樣 → suspect、不送 pending；之後正確分鐘照常', () => {
  const t = new OfferTracker(DEFAULT_OFFER, 90);
  const misread = summarizeScreen('1分鐘\n接受訂單\n取餐\n再 2 分鐘即將準備完成\n取餐體驗如何呢?');
  assert.equal(misread.accept, true);
  assert.equal(misread.offerAccepted, true);
  const ev = t.observe(0, { ...misread, minutes: 1 });
  assert.deepEqual(ev.map((e) => e.type), ['suspect']);
  assert.equal(t.active, false);
  const real = t.observe(6, { ...summarizeScreen('3 分鐘\n45.00 $\n接受訂單'), minutes: 3 });
  assert.deepEqual(real.map((e) => e.type), ['seen']);
  // 正在看的這張就是 2 分（真的短單）→ 不算誤讀
  const u = new OfferTracker(DEFAULT_OFFER, 90);
  u.observe(0, { ...summarizeScreen('接受訂單'), minutes: 2, amount: 45 });
  assert.deepEqual(u.observe(1, { ...misread, minutes: 2, amount: 45 }).map((e) => e.type), []);
  // 0＝關閉
  const off = new OfferTracker({ ...DEFAULT_OFFER, suspectBelowMinutes: 0 }, 90);
  assert.deepEqual(off.observe(0, { ...misread, minutes: 1 }).map((e) => e.type), ['seen']);
});

test('疊單標記：夾單字樣＝offer、接單時已有進行中單＝carry', () => {
  assert.deepEqual(stackMark({ stacked: true }, true), { stacked: true, stackKind: 'offer' });
  assert.deepEqual(stackMark({}, true), { stacked: true, stackKind: 'carry' });
  assert.deepEqual(stackMark({}, false), {});
});

test('遠端設定 delivery v1.1 欄位：mode 列舉、dialogKeywords 不得命中空字串、補掃範圍 top < bottom', () => {
  assert.equal(DEFAULT_CONFIG.delivery.mode, 'disappear');
  const bad = validateConfig({
    version: 'x',
    delivery: { mode: 'later', dialogKeywords: '送達|', numberScan: 1, numberScanTop: 0.7, numberScanBottom: 0.5, bindWindowSec: 5 },
  });
  for (const k of ['mode', 'dialogKeywords', 'numberScan', 'numberScanTop', 'bindWindowSec']) {
    assert.equal(bad.config.delivery[k], DEFAULT_DELIVERY[k], k);
  }
  assert.ok(bad.problems.some((p) => p.startsWith('delivery.numberScanTop >= numberScanBottom')));
  const ok = validateConfig({ version: 'x', delivery: { mode: 'appear', dialogKeywords: '交付確認', numberScan: false, numberScanTop: 0, numberScanBottom: 1, bindWindowSec: 600 } });
  assert.deepEqual(
    [ok.config.delivery.mode, ok.config.delivery.dialogKeywords, ok.config.delivery.numberScan, ok.config.delivery.numberScanTop, ok.config.delivery.numberScanBottom, ok.config.delivery.bindWindowSec],
    ['appear', '交付確認', false, 0, 1, 600],
  );
  assert.equal(validateConfig({ version: 'x', offer: { suspectBelowMinutes: 11 } }).config.offer.suspectBelowMinutes, 3);
});

test('Swift 與 TS 同規則：OrderNumbers/OrderNumberBook/DeliveryWatch、送達訊號、App 槽、誤讀防護、預設值', () => {
  const on = read('../targets/broadcast/OrderNumbers.swift');
  for (const s of [
    `static let numberPattern = "${swiftLit(ORDER_NO_PATTERN)}"`, `static let dialogNumberPattern = "${swiftLit(DIALOG_NO_PATTERN)}"`,
    'return all.count == 1 ? all[0] : nil', 'guard candidates.count == 1 else { return nil }', 'static let firstSeenGrace: TimeInterval = 2',
    'static let sentKeep: TimeInterval = 3600', 'static let entryKeep: TimeInterval = 4 * 3600', 'static let seqSlots = 4',
    'if entries.contains(where: { $0.seq > entry.seq && Self.slot($0.seq) == slot }) { return .plain("slotReused") }',
    'static let goneAfterMisses = 2', 'static let confirmSeconds: TimeInterval = 1', 'static let repeatSeconds: TimeInterval = 60',
    'if !panda { return tick(now) }', 'if changed { timerArmed = true }', 'return send(now, why: "finalAfterDialog", delay: 0)',
    'if let n = no, numbers.contains(n) {', 'finalHit: main.finalHit || e.finalHit', 'compact, finalPattern, fallback: RemoteConfig.DeliverySettings.defaultFinalKeywords) != nil',
    'let out: Action? = visible && firstMissAt != nil ? send(now, why: "stopped", delay: delayFrom(now)) : nil',
  ]) {
    assert.ok(on.includes(s), s);
  }
  assert.ok(!/import ActivityKit/.test(on));
  const ext = read('../targets/broadcast/SampleHandler.swift');
  const send = ext.slice(ext.indexOf('private func sendDelivered('), ext.indexOf('// MARK: - v0.7 邀請 → 接單判定'));
  assert.ok(send.indexOf('PandaSignal.postDeliveredDelay(delay)') < send.indexOf('PandaSignal.postDeliveredSeq(seq)'));
  assert.ok(send.indexOf('PandaSignal.postDeliveredDelay(delay)') < send.indexOf('PandaSignal.post(PandaSignal.delivered)'));
  assert.ok(!/telemetry\.log\([^)]*\bno\b/.test(send), '單號不得進 telemetry');
  for (const s of ['static let deliveredSeqPrefix = "com.pandatimer.delivered.seq."', 'if sent { book.accepted(seq: seq, at: acceptedAt) }',
    'self.handleWatch(self.watch.finish(Date()), info: nil)', 'self.handleWatch(self.watch.tick(Date()), info: nil)',
    'let deadlines = [tracker.deadline, deliveryEdge.deadline, watch.deadline].compactMap { $0 }', 'changed: why != "force"',
    'telemetry.log("offer_suspect", fields)', 'final: info.deliveredFinal || scan.finalHit', 'changed: why != "force", numbers: scan.numbers']) {
    assert.ok(ext.includes(s), s);
  }
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  for (const s of ['static let deliveredSeqPrefix = "com.pandatimer.delivered.seq."', 'for s in 0..<seqMod { names.append("\\(deliveredSeqPrefix)\\(s)") }',
    'setSeqOrders([:])', 'noteSeqOrder(slot: seq, gap: gap, id: orderId, at: now)', 'guard let i = active.firstIndex(where: { ($0["id"] as? String) == want }) else { return .skipped("matchedGone") }',
    'static let seqKeepSeconds: TimeInterval = 4 * 3600', 'order["stackKind"] = k', 'static func verifyOffer(']) {
    assert.ok(hub.includes(s), s);
  }
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  assert.equal(read('../targets/broadcast/RemoteConfig.swift'), rc);
  for (const s of [`static let defaultDialogKeywords = "${DEFAULT_DIALOG_KEYWORDS}"`, `var mode = "${DEFAULT_DELIVERY.mode}"`,
    `var numberScanTop = ${DEFAULT_DELIVERY.numberScanTop}`, `var numberScanBottom = ${DEFAULT_DELIVERY.numberScanBottom}`,
    `var bindWindowSec = ${DEFAULT_DELIVERY.bindWindowSec}`, 'out.mode = choice(d["mode"], ["disappear", "appear"], out.mode)',
    'int(d["bindWindowSec"], 30, 3600, out.bindWindowSec)', 'number(d["numberScanTop"], 0, 0.9, out.numberScanTop)',
    'number(d["numberScanBottom"], 0.1, 1, out.numberScanBottom)']) {
    assert.ok(rc.includes(s), s);
  }
  const ot = read('../targets/broadcast/OfferTracker.swift');
  assert.ok(ot.includes(`var suspectBelowMinutes = ${DEFAULT_OFFER.suspectBelowMinutes}`));
  assert.ok(ot.includes('RemoteConfig.int(o["suspectBelowMinutes"], 0, 10, suspectBelowMinutes)'));
  // telemetry 白名單：matched/stackKind 兩邊都有；沒有任何「單號」欄位
  const tel = read('../modules/live-activity/ios/PandaTelemetry.swift');
  assert.ok(tel.includes('"matched", "stackKind"'));
  for (const f of ['orderNo', 'number', 'no', 'num']) assert.ok(!tel.includes(`"${f}"`), f);
});
