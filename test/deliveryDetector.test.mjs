// v0.7（需求 G）自動偵測送達：extension 邊緣觸發＋60 秒不重送、App 挑單（minOrderAge）、手動/自動互斥
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AUTO_GUARD_SEC,
  DEFAULT_DELIVERY,
  DeliveryEdge,
  MANUAL_GRACE_SEC,
  manualBlockedByAuto,
  pickDeliveredOrder,
} from '../src/deliveryDetector.ts';
import { summarizeScreen } from '../src/screenInfo.ts';
import { DEFAULT_CONFIG, validateConfig } from '../src/remoteConfig.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const kind = (a) => (a ? a.kind : null);

test('關鍵字命中 → 邊緣觸發：同一次出現只送一次，連 2 次沒命中才算消失（pendingSec=0＝v0.7 行為）', () => {
  const e = new DeliveryEdge(0);
  const s = (t) => summarizeScreen(t);
  const seq = [
    [0, '前往送餐\n導航'], [1.5, '完成訂單\n聯絡'], [3, '完成訂單\n聯絡'], [4.5, ''], [6, '完成訂單'], [7.5, ''], [9, ''],
  ].map(([t, text]) => kind(e.observe(t, s(text).delivered, s(text).deliveredFinal)));
  assert.deepEqual(seq, [null, 'send', null, null, null, null, null]);
});

test('60 秒內同一畫面再出現不重送；超過 60 秒再出現才送', () => {
  const e = new DeliveryEdge(0);
  assert.equal(kind(e.observe(0, true)), 'send');
  e.observe(2, false);
  e.observe(4, false); // 消失
  assert.equal(kind(e.observe(30, true)), 'repeat');
  e.observe(32, false);
  e.observe(34, false);
  assert.equal(kind(e.observe(61, true)), 'send');
});

test('v0.8 送達：「訂單完成」優先；只看到確認對話框先待定，30 秒內出現訂單完成用後者時間、否則以對話框時間', () => {
  const s = (t) => summarizeScreen(t);
  const dialog = s('#7318 是否已送達?\n確認已送達\n取消');
  const done = s('訂單完成\n繼續保持訂單品質！');
  assert.deepEqual([dialog.delivered, dialog.deliveredFinal], [true, false]);
  assert.deepEqual([done.delivered, done.deliveredFinal, done.deliveredHit], [true, true, ['訂單完成']]);
  assert.ok(dialog.deliveredHit.includes('已送達'));
  assert.ok(dialog.kw.includes('確認已送達') && dialog.kw.includes('是否已送達'));
  // ① 對話框 → 按確認 → 訂單完成（12 秒後）：以訂單完成時間（delay 0）送一次
  let e = new DeliveryEdge();
  assert.equal(e.pendingSec, 30);
  assert.deepEqual(e.observe(100, dialog.delivered, dialog.deliveredFinal), { kind: 'pending' });
  assert.equal(e.deadline, 130);
  assert.equal(e.observe(101.5, dialog.delivered, dialog.deliveredFinal), null);
  assert.equal(e.observe(103, false), null);
  assert.equal(e.observe(104.5, false), null);
  assert.deepEqual(e.observe(112, done.delivered, done.deliveredFinal), { kind: 'send', delaySec: 0, why: 'finalAfterPending' });
  assert.equal(e.deadline, null);
  assert.equal(e.observe(113.5, done.delivered, done.deliveredFinal), null); // 同一次出現
  // ② 只有對話框、訂單完成沒被看到 → 30 秒到期（計時器 tick）以對話框時間送（delay 30）
  e = new DeliveryEdge();
  e.observe(200, true, false);
  e.observe(202, false);
  e.observe(204, false);
  assert.equal(e.tick(229), null);
  assert.deepEqual(e.tick(230.4), { kind: 'send', delaySec: 30, why: 'timeout' });
  // 之後才看到訂單完成（60 秒內）→ 不重送
  assert.deepEqual(e.observe(240, true, true), { kind: 'repeat' });
  // ③ 直接看到訂單完成（沒看到對話框）→ 立刻送
  e = new DeliveryEdge();
  assert.deepEqual(e.observe(0, true, true), { kind: 'send', delaySec: 0, why: 'final' });
  // ④ 待定中廣播停止 → 照對話框時間送出（首日停止常緊接在送達對話框之後）
  e = new DeliveryEdge();
  e.observe(50, true, false);
  assert.deepEqual(e.finish(51.2), { kind: 'send', delaySec: 1, why: 'stopped' });
  assert.equal(e.finish(52), null);
  // ⑤ 對話框一直停在畫面上：每次 OCR 都會檢查到期
  e = new DeliveryEdge();
  e.observe(0, true, false);
  assert.equal(e.observe(10, true, false), null);
  assert.deepEqual(e.observe(31, true, false), { kind: 'send', delaySec: 31, why: 'timeout' });
  // 延遲上限 60（訊號只編 0~60）
  e = new DeliveryEdge(60);
  e.observe(0, true, false);
  assert.deepEqual(e.finish(500), { kind: 'send', delaySec: 60, why: 'stopped' });
});

test('App 挑單（v0.8）：截止最早且接單超過 minOrderAgeSec；太新/沒單/停用/90 秒內有手動結單 → 不結', () => {
  const now = 1_000_000_000;
  const s = DEFAULT_DELIVERY;
  assert.equal(s.minOrderAgeSec, 120);
  const o = (id, agoMin, est) => ({ id, acceptedAt: now - agoMin * 60_000, deadline: now - agoMin * 60_000 + est * 60_000 });
  const a = o('a', 30, 40); // 截止 +10
  const b = o('b', 10, 15); // 截止 +5（較晚接、較早截止）
  const fresh = o('c', 1, 3);
  assert.deepEqual(pickDeliveredOrder([b, a, fresh], now, s, null), { id: 'b' });
  // 同截止 → 較早接單
  assert.deepEqual(pickDeliveredOrder([o('y', 10, 20), o('x', 20, 30)], now, s, null), { id: 'x' });
  assert.deepEqual(pickDeliveredOrder([fresh], now, s, null), { skip: 'tooNew' });
  assert.deepEqual(pickDeliveredOrder([o('x', 2, 9)], now, s, null), { id: 'x' }); // 剛好 120 秒
  assert.deepEqual(pickDeliveredOrder([], now, s, null), { skip: 'noActive' });
  assert.deepEqual(pickDeliveredOrder([a], now, { ...s, enabled: false }, null), { skip: 'disabled' });
  assert.deepEqual(pickDeliveredOrder([a], now, s, now - (MANUAL_GRACE_SEC - 1) * 1000), { skip: 'manualRecent' });
  assert.deepEqual(pickDeliveredOrder([a], now, s, now - (MANUAL_GRACE_SEC + 1) * 1000), { id: 'a' });
  assert.deepEqual(pickDeliveredOrder([fresh], now, { ...s, minOrderAgeSec: 30 }, null), { id: 'c' });
  assert.deepEqual(pickDeliveredOrder([a, b], now, s, null), { id: 'b' });
});

test('手動送達：自動結單後 20 秒內擋掉（同時發生只結一次）', () => {
  const now = 5_000_000;
  assert.equal(manualBlockedByAuto(null, now), false);
  assert.equal(manualBlockedByAuto(now - 5_000, now), true);
  assert.equal(manualBlockedByAuto(now - AUTO_GUARD_SEC * 1000, now), false);
});

test('遠端設定 delivery/ocr：預設、範圍、正則不得命中空字串、enabled 要布林', () => {
  assert.deepEqual(DEFAULT_CONFIG.delivery, DEFAULT_DELIVERY);
  assert.deepEqual(DEFAULT_CONFIG.ocr, { memSkipMB: 36, memHighMB: 44, rebuildEvery: 30, englishToo: false });
  assert.ok(DEFAULT_DELIVERY.completedKeywords.startsWith('訂單完成|'));
  const bad = validateConfig({
    version: 'x',
    delivery: { enabled: 'yes', minOrderAgeSec: -1, completedKeywords: '完成|', finalKeywords: '.*', pendingSec: 61 },
    ocr: { memSkipMB: 5, memHighMB: 200, rebuildEvery: 0, englishToo: 'no' },
  });
  assert.deepEqual(bad.config.delivery, DEFAULT_DELIVERY);
  assert.deepEqual(bad.config.ocr, DEFAULT_CONFIG.ocr);
  for (const k of ['delivery.enabled', 'delivery.minOrderAgeSec', 'delivery.completedKeywords', 'delivery.finalKeywords', 'delivery.pendingSec',
    'ocr.memSkipMB', 'ocr.memHighMB', 'ocr.rebuildEvery', 'ocr.englishToo']) {
    assert.ok(bad.problems.some((p) => p.startsWith(k)), k);
  }
  const ok = validateConfig({ version: 'x', delivery: { enabled: false, minOrderAgeSec: 300, completedKeywords: '交付成功', finalKeywords: '完成囉', pendingSec: 0 } });
  assert.deepEqual(ok.config.delivery, { enabled: false, minOrderAgeSec: 300, completedKeywords: '交付成功', finalKeywords: '完成囉', pendingSec: 0 });
});

test('Swift 與 TS 同規則：extension DeliveryEdge、App AutoDelivery、互斥鍵名、預設值與範圍', () => {
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['static let goneAfterMisses = 2', 'static let repeatSeconds: TimeInterval = 60', 'static let delivered = "com.pandatimer.delivered"',
    'PandaSignal.post(PandaSignal.delivered)', 'if s.delivery.enabled {', 'if currentMB > s.ocrGuard.memSkipMB && !starving {', 'lastOcrDoneAt.map { Date().timeIntervalSince($0) >= 15 } ?? true', 'if ocr.lastInnerMB > s.ocrGuard.memHighMB {',
    // v0.8 待定/優先/停止時送出、延遲訊號在 delivered 之前
    'if isFinal && pendingAt != nil {', 'return .send(delay: 0, why: "finalAfterPending")', 'return flush(now, why: "timeout")', 'pendingAt == nil ? .idle : flush(now, why: "stopped")',
    'return .send(delay: d.isFinite ? min(60, max(0, Int(d))) : 0, why: why)', 'self.handleDelivery(self.deliveryEdge.finish(Date()), info: nil)',
    'static let deliveredDelayPrefix = "com.pandatimer.delivered.delay."']) {
    assert.ok(ext.includes(s), s);
  }
  assert.ok(ext.indexOf('PandaSignal.postDeliveredDelay(delay)') < ext.indexOf('PandaSignal.post(PandaSignal.delivered)'));
  const fin = ext.slice(ext.indexOf('func finish()'), ext.indexOf('/// v0.8：ReplayKit 暫停'));
  assert.ok(fin.indexOf('self.deliveryEdge.finish(Date())') < fin.indexOf('PandaSignal.post(PandaSignal.stopped)'));
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  for (const s of ['static let deliveredName = "com.pandatimer.delivered"', 'static let manualGraceSeconds: Double = 90',
    'if nowMs - accepted < Double(settings.minOrderAgeSec) * 1000 { continue }', 'defaults.set(nowMs, forKey: lastAutoKey)',
    'await DetectorCardPlan.afterFinish(activityId: aid',
    // v0.8：截止最早（同截止較早接單）、實際時間＝收到 − 延遲
    'if deadline < bestDeadline || (deadline == bestDeadline && accepted < best) {',
    'let now = received.addingTimeInterval(-Double(usedDelay ?? 0))', 'static let deliveredDelayPrefix = "com.pandatimer.delivered.delay."']) {
    assert.ok(hub.includes(s), s);
  }
  assert.equal(MANUAL_GRACE_SEC, 90);
  assert.equal(AUTO_GUARD_SEC, 20);
  const store = read('../native/intents/DeliverActivityIntent.swift');
  for (const k of ['pandatimer.native.lastManualDoneAt.v1', 'pandatimer.native.lastAutoDoneAt.v1']) {
    assert.ok(hub.includes(`"${k}"`) && store.includes(`"${k}"`), k);
  }
  assert.ok(store.includes('static let autoGuardSeconds: Double = 20'));
  assert.ok(read('../modules/live-activity/ios/LiveActivityModule.swift').includes('"pandatimer.native.lastManualDoneAt.v1"'));
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  for (const s of ['var enabled = true', 'var minOrderAgeSec = 120', 'int(d["minOrderAgeSec"], 0, 1800, out.minOrderAgeSec)',
    'var memSkipMB = 36.0', 'var memHighMB = 44.0', 'number(o["memSkipMB"], 20, 60, out.memSkipMB)', 'number(o["memHighMB"], 25, 80, out.memHighMB)',
    'var pendingSec = 30', 'int(d["pendingSec"], 0, 60, out.pendingSec)', 'var rebuildEvery = 30', 'int(o["rebuildEvery"], 1, 1000, out.rebuildEvery)',
    'var englishToo = false', `static let defaultFinalKeywords = "${DEFAULT_DELIVERY.finalKeywords}"`]) {
    assert.ok(rc.includes(s), s);
  }
});
