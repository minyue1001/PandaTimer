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

test('關鍵字命中 → 邊緣觸發：同一次出現只送一次，連 2 次沒命中才算消失', () => {
  const e = new DeliveryEdge();
  const hit = (t) => summarizeScreen(t).delivered;
  const seq = [
    [0, '前往送餐\n導航'], [1.5, '完成訂單\n聯絡'], [3, '完成訂單\n聯絡'], [4.5, ''], [6, '完成訂單'], [7.5, ''], [9, ''],
  ].map(([t, text]) => e.observe(t, hit(text)));
  assert.deepEqual(seq, [null, 'send', null, null, null, null, null]);
});

test('60 秒內同一畫面再出現不重送；超過 60 秒再出現才送', () => {
  const e = new DeliveryEdge();
  assert.equal(e.observe(0, true), 'send');
  e.observe(2, false);
  e.observe(4, false); // 消失
  assert.equal(e.observe(30, true), 'repeat');
  e.observe(32, false);
  e.observe(34, false);
  assert.equal(e.observe(61, true), 'send');
});

test('App 挑單：最早接單且接單超過 minOrderAgeSec；太新/沒單/停用/90 秒內有手動結單 → 不結', () => {
  const now = 1_000_000_000;
  const s = DEFAULT_DELIVERY;
  assert.equal(s.minOrderAgeSec, 120);
  const a = { id: 'a', acceptedAt: now - 30 * 60_000 };
  const b = { id: 'b', acceptedAt: now - 10 * 60_000 };
  const fresh = { id: 'c', acceptedAt: now - 60_000 };
  assert.deepEqual(pickDeliveredOrder([b, a, fresh], now, s, null), { id: 'a' });
  assert.deepEqual(pickDeliveredOrder([fresh], now, s, null), { skip: 'tooNew' });
  assert.deepEqual(pickDeliveredOrder([{ id: 'x', acceptedAt: now - 120_000 }], now, s, null), { id: 'x' }); // 剛好 120 秒
  assert.deepEqual(pickDeliveredOrder([], now, s, null), { skip: 'noActive' });
  assert.deepEqual(pickDeliveredOrder([a], now, { ...s, enabled: false }, null), { skip: 'disabled' });
  assert.deepEqual(pickDeliveredOrder([a], now, s, now - (MANUAL_GRACE_SEC - 1) * 1000), { skip: 'manualRecent' });
  assert.deepEqual(pickDeliveredOrder([a], now, s, now - (MANUAL_GRACE_SEC + 1) * 1000), { id: 'a' });
  assert.deepEqual(pickDeliveredOrder([fresh], now, { ...s, minOrderAgeSec: 30 }, null), { id: 'c' });
});

test('手動送達：自動結單後 20 秒內擋掉（同時發生只結一次）', () => {
  const now = 5_000_000;
  assert.equal(manualBlockedByAuto(null, now), false);
  assert.equal(manualBlockedByAuto(now - 5_000, now), true);
  assert.equal(manualBlockedByAuto(now - AUTO_GUARD_SEC * 1000, now), false);
});

test('遠端設定 delivery/ocr：預設、範圍、正則不得命中空字串、enabled 要布林', () => {
  assert.deepEqual(DEFAULT_CONFIG.delivery, DEFAULT_DELIVERY);
  assert.deepEqual(DEFAULT_CONFIG.ocr, { memSkipMB: 38, memHighMB: 44 });
  const bad = validateConfig({ version: 'x', delivery: { enabled: 'yes', minOrderAgeSec: -1, completedKeywords: '完成|' }, ocr: { memSkipMB: 5, memHighMB: 200 } });
  assert.deepEqual(bad.config.delivery, DEFAULT_DELIVERY);
  assert.deepEqual(bad.config.ocr, DEFAULT_CONFIG.ocr);
  for (const k of ['delivery.enabled', 'delivery.minOrderAgeSec', 'delivery.completedKeywords', 'ocr.memSkipMB', 'ocr.memHighMB']) {
    assert.ok(bad.problems.some((p) => p.startsWith(k)), k);
  }
  const ok = validateConfig({ version: 'x', delivery: { enabled: false, minOrderAgeSec: 300, completedKeywords: '交付成功' } });
  assert.deepEqual(ok.config.delivery, { enabled: false, minOrderAgeSec: 300, completedKeywords: '交付成功' });
});

test('Swift 與 TS 同規則：extension DeliveryEdge、App AutoDelivery、互斥鍵名、預設值與範圍', () => {
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['static let goneAfterMisses = 2', 'static let repeatSeconds: TimeInterval = 60', 'static let delivered = "com.pandatimer.delivered"',
    'PandaSignal.post(PandaSignal.delivered)', 'if s.delivery.enabled {', 'if currentMB > s.ocrGuard.memSkipMB && !starving {', 'lastOcrDoneAt.map { Date().timeIntervalSince($0) >= 15 } ?? true', 'if ocr.lastInnerMB > s.ocrGuard.memHighMB {']) {
    assert.ok(ext.includes(s), s);
  }
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  for (const s of ['static let deliveredName = "com.pandatimer.delivered"', 'static let manualGraceSeconds: Double = 90',
    'if nowMs - accepted < Double(settings.minOrderAgeSec) * 1000 { continue }', 'defaults.set(nowMs, forKey: lastAutoKey)',
    'await DetectorCardPlan.afterFinish(activityId: aid']) {
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
    'var memSkipMB = 38.0', 'var memHighMB = 44.0', 'number(o["memSkipMB"], 20, 60, out.memSkipMB)', 'number(o["memHighMB"], 25, 80, out.memHighMB)']) {
    assert.ok(rc.includes(s), s);
  }
});
