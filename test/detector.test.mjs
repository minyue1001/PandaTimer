import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptDelayName,
  allSignalNames,
  offerLine,
  offerPendingName,
  restoreAcceptedAt,
  beatAgeSec,
  countAutoToday,
  locationAuthPending,
  missedSignals,
  orderSignalName,
  parseDetectorStatus,
  parseSignalName,
  telemetryLine,
} from '../src/detector.ts';

test('v0.6 parseSignalName：order.<N>.<S>，N 只收 1…90 的純數字、S 只收 0…3', () => {
  assert.deepEqual(parseSignalName('com.pandatimer.order.27.0'), { kind: 'order', minutes: 27, seq: 0 });
  assert.deepEqual(parseSignalName('com.pandatimer.order.1.3'), { kind: 'order', minutes: 1, seq: 3 });
  assert.deepEqual(parseSignalName('com.pandatimer.order.90.2'), { kind: 'order', minutes: 90, seq: 2 });
  for (const bad of ['27', '0.0', '91.0', '07.1', '+5.0', '5.0.1', '5.4', '5.-1', '5.', '.1', '', 'abc', '27.0 ', '100.0', '5.00']) {
    assert.equal(parseSignalName(`com.pandatimer.order.${bad}`), null, bad);
  }
});

test('v0.6 orderSignalName：編碼後解得回來；序號 mod 4；分鐘超出範圍 → null', () => {
  for (let m = 1; m <= 90; m++) {
    for (let seq = 0; seq < 9; seq++) {
      const name = orderSignalName(m, seq);
      assert.deepEqual(parseSignalName(name), { kind: 'order', minutes: m, seq: seq % 4 }, name);
    }
  }
  assert.equal(orderSignalName(0, 0), null);
  assert.equal(orderSignalName(91, 0), null);
  assert.equal(orderSignalName(27.5, 0), null);
  // 同分鐘連續兩單 → 名稱不同（App 被暫停時 Darwin 同名通知會合併）
  assert.notEqual(orderSignalName(27, 0), orderSignalName(27, 1));
});

test('v0.6 missedSignals：序號跳號＝訊號遺失', () => {
  assert.equal(missedSignals(null, 0), 0);
  assert.equal(missedSignals(0, 1), 0);
  assert.equal(missedSignals(3, 0), 0); // 3 → 0 是 mod 4 繞回
  assert.equal(missedSignals(0, 2), 1);
  assert.equal(missedSignals(1, 0), 2);
  assert.equal(missedSignals(2, 2), 3); // 同序號＝漏了 3 則（或 4 的倍數）
});

test('parseSignalName：狀態訊號與垃圾', () => {
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.started'), { kind: 'started' });
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.stopped'), { kind: 'stopped' });
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.heartbeat'), { kind: 'heartbeat' });
  assert.deepEqual(parseSignalName('com.pandatimer.drain'), { kind: 'drain' });
  assert.equal(parseSignalName('com.pandatimer.broadcast.paused'), null);
  assert.equal(parseSignalName('com.other.order.5.0'), null);
  assert.equal(parseSignalName(null), null);
  assert.equal(parseSignalName(5), null);
});

test('allSignalNames：v0.8 共 579 個（< 1000）、每個都解析得回來、無重複', () => {
  const names = allSignalNames();
  assert.equal(names.length, 4 + 90 * 4 + 90 + 1 + 61 + 1 + 1 + 61);
  assert.equal(names.length, 579);
  assert.ok(names.length < 1000);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.notEqual(parseSignalName(n), null, n);
});

test('Swift/TS 名稱一致：原生兩邊都含同樣的字串', async () => {
  const fs = await import('node:fs');
  const hub = fs.readFileSync(new URL('../modules/live-activity/ios/DetectorHub.swift', import.meta.url), 'utf8');
  const ext = fs.readFileSync(new URL('../targets/broadcast/SampleHandler.swift', import.meta.url), 'utf8');
  const shared = fs.readFileSync(new URL('../native/intents/DeliverActivityIntent.swift', import.meta.url), 'utf8');
  for (const s of ['com.pandatimer.order.', 'com.pandatimer.broadcast.started', 'com.pandatimer.broadcast.stopped', 'com.pandatimer.broadcast.heartbeat']) {
    assert.ok(hub.includes(`"${s}"`), `DetectorHub 缺 ${s}`);
    assert.ok(ext.includes(`"${s}"`), `SampleHandler 缺 ${s}`);
  }
  assert.ok(hub.includes('"com.pandatimer.drain"'));
  assert.ok(shared.includes('"com.pandatimer.drain"'));
  assert.ok(!/import ActivityKit/.test(ext), 'extension 不得 import ActivityKit（v0.3 實測不可用）');
  // v0.6：order.<N>.<S> 的組法三邊一致（extension 送、App 註冊/解析、TS 測試替身）
  assert.ok(ext.includes('post("\\(orderPrefix)\\(minutes).\\(((seq % seqMod) + seqMod) % seqMod)")'), 'SampleHandler 的 order 名稱組法');
  assert.ok(ext.includes('static let seqMod = 4'));
  assert.ok(hub.includes('static let seqMod = 4'));
  assert.ok(hub.includes('names.append("\\(orderPrefix)\\(n).\\(s)")'), 'DetectorHub 註冊名稱組法');
  // App 端不得再有「同分鐘數」去重（v0.5 只偵測到第一單的原因之一）
  assert.ok(!/orderDedupe/.test(hub), 'DetectorHub 不得再有 orderDedupe');
});

test('parseDetectorStatus：容錯', () => {
  assert.equal(parseDetectorStatus(null), null);
  assert.equal(parseDetectorStatus('not json'), null);
  assert.equal(parseDetectorStatus('[]'), null);
  const s = parseDetectorStatus(JSON.stringify({ armed: true, keepAlive: '音訊中', lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2 }));
  assert.deepEqual(s, { armed: true, keepAlive: '音訊中', keepAliveMode: 'none', locationAuth: 'unknown', keepAliveError: undefined, lastFixAt: null, islandCheck: '', lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2, telemetryLastOk: null, telemetryPending: 0, telemetryError: undefined, configVersion: 'default', offerPendingMinutes: null, offerPendingAt: null, offerNote: '', stoppedUnexpectedAt: null });
  const v5 = parseDetectorStatus(JSON.stringify({ armed: true, keepAlive: '定位中', keepAliveMode: 'location', locationAuth: 'whenInUse', lastFixAt: 5000, islandCheck: '動態島：已更新✓（背景）' }));
  assert.equal(v5.keepAliveMode, 'location');
  assert.equal(v5.locationAuth, 'whenInUse');
  assert.equal(v5.lastFixAt, 5000);
  assert.equal(v5.islandCheck, '動態島：已更新✓（背景）');
  const d = parseDetectorStatus('{"armed":"yes","lastBeatAt":"x"}');
  assert.equal(d.armed, false);
  assert.equal(d.lastBeatAt, null);
  assert.equal(d.autoCountSinceLaunch, 0);
  assert.equal(beatAgeSec(s, 31_000), 30);
  assert.equal(beatAgeSec(d, 31_000), null);
});

test('countAutoToday：只算今天、auto、未取消', () => {
  const now = new Date(2026, 10, 11, 15, 0).getTime();
  const today = new Date(2026, 10, 11, 9, 0).getTime();
  const yesterday = new Date(2026, 10, 10, 23, 0).getTime();
  const o = (acceptedAt, extra) => ({ id: String(Math.random()), acceptedAt, estimateMin: 20, deadline: acceptedAt + 1, status: 'active', ...extra });
  const orders = [
    o(today, { source: 'auto' }),
    o(today, { source: 'auto', status: 'delivered' }),
    o(today, { source: 'auto', status: 'canceled' }),
    o(today, {}),
    o(yesterday, { source: 'auto' }),
  ];
  assert.equal(countAutoToday(orders, now), 2);
});

test('locationAuthPending：只有偵測中且授權還沒結果時才等', () => {
  const base = parseDetectorStatus(JSON.stringify({ armed: true, keepAliveMode: 'none', locationAuth: 'unknown' }));
  assert.equal(locationAuthPending(base), true);
  assert.equal(locationAuthPending({ ...base, keepAliveMode: 'auth', locationAuth: 'notDetermined' }), true);
  assert.equal(locationAuthPending({ ...base, keepAliveMode: 'location', locationAuth: 'whenInUse' }), false);
  assert.equal(locationAuthPending({ ...base, keepAliveMode: 'audio', locationAuth: 'denied' }), false);
  assert.equal(locationAuthPending({ ...base, armed: false }), false);
  assert.equal(locationAuthPending(null), false);
});

test('v0.6：telemetryLine 顯示最後成功時間／待送／錯誤', () => {
  const base = parseDetectorStatus(JSON.stringify({ armed: true }));
  assert.equal(telemetryLine(null), null);
  assert.equal(telemetryLine(base), '回報：尚未成功');
  const ok = new Date(2026, 10, 12, 9, 5, 7).getTime();
  assert.equal(telemetryLine({ ...base, telemetryLastOk: ok }), '回報：最後成功 09:05:07');
  assert.equal(telemetryLine({ ...base, telemetryLastOk: ok, telemetryPending: 3, telemetryError: 'HTTP 429' }), '回報：最後成功 09:05:07（待送 3）・HTTP 429');
  assert.equal(telemetryLine({ ...base, telemetryLastOk: ok, configVersion: '2026-11-12.1' }), '回報：最後成功 09:05:07・設定 2026-11-12.1');
});

test('v0.6：extension 通知 userInfo（偵測時間＋序號）與 App 端讀法一致；鏡像鍵名一致', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const f of ['"pandatimer": "detected"', '"detectedAt": detectedMs', '"seq": seqValue']) assert.ok(ext.includes(f), `SampleHandler 缺 ${f}`);
  assert.ok(hub.includes('(info["pandatimer"] as? String) == "detected"'));
  assert.ok(hub.includes('(info["seq"] as? NSNumber)'));
  for (const p of ['../native/intents/DeliverActivityIntent.swift', '../native/intents/DetectorCardPlan.swift', '../modules/live-activity/ios/LiveActivityModule.swift']) {
    assert.ok(read(p).includes('"pandatimer.native.activeOrders.v1"'), p);
  }
});

test('v0.6：app.json 背景模式／定位說明／runtimeVersion 與 OtaBox 一致／回報金鑰', async () => {
  const fs = await import('node:fs');
  const app = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  const plist = app.ios.infoPlist;
  assert.deepEqual([...plist.UIBackgroundModes].sort(), ['audio', 'location']);
  assert.ok(plist.NSLocationWhenInUseUsageDescription.length > 5);
  assert.ok(plist.NSLocationAlwaysAndWhenInUseUsageDescription.length > 5);
  assert.equal(app.runtimeVersion, '0.9');
  // v0.6 遠端回報：寫入金鑰在 extra（進 App 可接受），網址 https；讀取金鑰絕不進 repo
  assert.match(app.extra.telemetryKey, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(app.extra.telemetryUrl, /^https:\/\/.+\/api\/telemetry$/);
  assert.ok(app.plugins.includes('./plugins/withTelemetry'));
  assert.equal(app.extra.telemetryReadKey, undefined);
  assert.match(app.extra.configUrl, /^https:\/\/.+\/api\/config$/);
  const ota = fs.readFileSync(new URL('../src/OtaBox.tsx', import.meta.url), 'utf8');
  assert.ok(ota.includes(`const APP_VERSION = '${app.runtimeVersion}'`));
  // 零 entitlement：app.json 不得出現 entitlements 設定
  assert.equal(app.ios.entitlements, undefined);
});

test('v0.7 offer.pending / offer.cleared / accept.delay：編碼與解析、邊界', () => {
  assert.deepEqual(parseSignalName('com.pandatimer.offer.pending.27'), { kind: 'offerPending', minutes: 27 });
  assert.deepEqual(parseSignalName('com.pandatimer.offer.cleared'), { kind: 'offerCleared' });
  assert.deepEqual(parseSignalName('com.pandatimer.delivered'), { kind: 'delivered' });
  assert.equal(parseSignalName('com.pandatimer.delivered.1'), null);
  assert.deepEqual(parseSignalName('com.pandatimer.accept.delay.0'), { kind: 'acceptDelay', seconds: 0 });
  assert.deepEqual(parseSignalName('com.pandatimer.accept.delay.60'), { kind: 'acceptDelay', seconds: 60 });
  for (const bad of ['offer.pending.0', 'offer.pending.91', 'offer.pending.07', 'offer.pending.', 'offer.pending.5.0', 'accept.delay.61', 'accept.delay.00', 'accept.delay.-1', 'accept.delay.', 'offer.cleared.1']) {
    assert.equal(parseSignalName(`com.pandatimer.${bad}`), null, bad);
  }
  for (let m = 1; m <= 90; m++) assert.deepEqual(parseSignalName(offerPendingName(m)), { kind: 'offerPending', minutes: m });
  assert.equal(offerPendingName(0), null);
  assert.equal(offerPendingName(91), null);
  assert.equal(acceptDelayName(12.4), 'com.pandatimer.accept.delay.12');
  assert.equal(acceptDelayName(-3), 'com.pandatimer.accept.delay.0');
  assert.equal(acceptDelayName(99), 'com.pandatimer.accept.delay.60');
});

test('v0.7 restoreAcceptedAt：延遲配對（前後 2 秒）、App 暫停用通知時間、配不到用收到時間', () => {
  const t = 1_000_000;
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: false, delay: { seconds: 12, at: t - 50 } }), t - 12_000);
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: false, delay: { seconds: 12, at: t + 1500 } }), t - 12_000); // 亂序：延遲晚到
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: false, delay: { seconds: 12, at: t - 2500 } }), t); // 太舊
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: false, delay: null }), t);
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: true, notifiedAt: t - 90_000, delay: { seconds: 5, at: t } }), t - 90_000);
  assert.equal(restoreAcceptedAt({ receivedAt: t, suspended: true, notifiedAt: null }), t);
});

test('v0.7 offerLine：等待接單中（秒數）、過期不顯示、最近判定', () => {
  const base = parseDetectorStatus(JSON.stringify({ armed: true }));
  assert.equal(offerLine(null, 0), null);
  assert.equal(offerLine(base, 0), null);
  const p = parseDetectorStatus(JSON.stringify({ armed: true, offerPendingMinutes: 27, offerPendingAt: 10_000 }));
  assert.equal(offerLine(p, 22_000), '偵測到邀請 27 分，等你接單…（12 秒）');
  assert.equal(offerLine({ ...p, offerNote: '已接單 18 分（18:00:00）' }, 10_000 + 181_000), '最近：已接單 18 分（18:00:00）');
  assert.equal(offerLine({ ...p, offerPendingAt: null, offerNote: '未接單 27 分（18:01:02）' }, 0), '最近：未接單 27 分（18:01:02）');
});

test('v0.7：Swift 兩邊（extension 送、App 註冊/解析）的新訊號名稱與 TS 一致；送 order 前先送延遲', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['com.pandatimer.offer.pending.', 'com.pandatimer.offer.cleared', 'com.pandatimer.accept.delay.', 'com.pandatimer.delivered']) {
    assert.ok(hub.includes(`"${s}"`), `DetectorHub 缺 ${s}`);
    assert.ok(ext.includes(`"${s}"`), `SampleHandler 缺 ${s}`);
  }
  assert.ok(ext.includes('static let maxAcceptDelay = 60') && hub.includes('static let maxAcceptDelay = 60'));
  assert.ok(hub.includes('static let delayPairWindow: TimeInterval = 2'));
  // extension：延遲訊號一定在 order 訊號之前送
  const body = ext.slice(ext.indexOf('private func decided('), ext.indexOf('/// 畫面分類或接單鈕狀態有變才記一筆'));
  const iDelay = body.indexOf('PandaSignal.postAcceptDelay(');
  const iOrder = body.indexOf('PandaSignal.postOrder(');
  assert.ok(iDelay > 0 && iOrder > iDelay, '要先送 accept.delay 再送 order');
  // 只有判定接單才送 order（runOCR 不得直接送）
  const ocr = ext.slice(ext.indexOf('private func runOCR('), ext.indexOf('// MARK: - v0.7 邀請 → 接單判定'));
  assert.ok(!ocr.includes('postOrder('), 'runOCR 不得直接送 order 訊號');
  assert.ok(hub.includes('for n in 1...maxMinutes { names.append("\\(offerPendingPrefix)\\(n)") }'));
  assert.ok(hub.includes('for d in 0...maxAcceptDelay { names.append("\\(acceptDelayPrefix)\\(d)") }'));
});

test('v0.8 offer.stacked / delivered.delay：編碼與解析、配對（前後 2 秒）', async () => {
  const d = await import('../src/detector.ts');
  assert.deepEqual(d.parseSignalName('com.pandatimer.offer.stacked'), { kind: 'offerStacked' });
  assert.deepEqual(d.parseSignalName('com.pandatimer.delivered.delay.0'), { kind: 'deliveredDelay', seconds: 0 });
  assert.deepEqual(d.parseSignalName('com.pandatimer.delivered.delay.60'), { kind: 'deliveredDelay', seconds: 60 });
  for (const bad of ['com.pandatimer.delivered.delay.61', 'com.pandatimer.delivered.delay.07', 'com.pandatimer.delivered.delay.', 'com.pandatimer.delivered.x']) {
    assert.equal(d.parseSignalName(bad), null, bad);
  }
  assert.deepEqual(d.parseSignalName('com.pandatimer.delivered'), { kind: 'delivered' });
  assert.equal(d.deliveredDelayName(99), 'com.pandatimer.delivered.delay.60');
  assert.equal(d.deliveredDelayName(-3), 'com.pandatimer.delivered.delay.0');
  assert.equal(d.restoreDeliveredAt(100_000, { seconds: 30, at: 99_500 }), 70_000);
  assert.equal(d.restoreDeliveredAt(100_000, { seconds: 30, at: 97_000 }), 100_000);
  assert.equal(d.restoreDeliveredAt(100_000, null), 100_000);
  assert.equal(d.pairedStacked(100_000, 99_000), true);
  assert.equal(d.pairedStacked(100_000, 97_500), false);
  assert.equal(d.pairedStacked(100_000, null), false);
  assert.ok(d.allSignalNames().length <= d.MAX_SIGNAL_NAMES);
});

test('v0.8 廣播停止補救：偵測中才通知、60 秒內不重複；redetect 通知資料', async () => {
  const d = await import('../src/detector.ts');
  assert.equal(d.shouldNotifyStopped(false, null, 0), false);
  assert.equal(d.shouldNotifyStopped(true, null, 0), true);
  assert.equal(d.shouldNotifyStopped(true, 0, 59_999), false);
  assert.equal(d.shouldNotifyStopped(true, 0, 60_000), true);
  assert.equal(d.isRedetectData({ pandatimer: 'redetect' }), true);
  assert.equal(d.isRedetectData({ pandatimer: 'detected' }), false);
  assert.equal(d.isRedetectData(null), false);
  assert.equal(d.parseDetectorStatus(JSON.stringify({ armed: false, stoppedUnexpectedAt: 1234 })).stoppedUnexpectedAt, 1234);
});

test('v0.8 Swift：新訊號名稱一致、送 order 前先送夾單與延遲、App 鎖屏回報與停止通知', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['com.pandatimer.offer.stacked', 'com.pandatimer.delivered.delay.']) {
    assert.ok(hub.includes(`"${s}"`), `DetectorHub 缺 ${s}`);
    assert.ok(ext.includes(`"${s}"`), `SampleHandler 缺 ${s}`);
  }
  const body = ext.slice(ext.indexOf('private func decided('), ext.indexOf('/// 畫面分類或接單鈕狀態有變才記一筆'));
  const iStacked = body.indexOf('PandaSignal.post(PandaSignal.offerStacked)');
  assert.ok(iStacked > 0 && iStacked < body.indexOf('PandaSignal.postAcceptDelay(') && body.indexOf('PandaSignal.postAcceptDelay(') < body.indexOf('PandaSignal.postOrder('));
  assert.ok(hub.includes('names.append(offerStackedName)'));
  assert.ok(hub.includes('for d in 0...maxDeliveredDelay { names.append("\\(deliveredDelayPrefix)\\(d)") }'));
  assert.ok(hub.includes('static let maxDeliveredDelay = 60'));
  for (const s of ['UIApplication.protectedDataWillBecomeUnavailableNotification', 'UIApplication.protectedDataDidBecomeAvailableNotification',
    'self.telemetry.log("lock"', 'self.telemetry.log("unlock"', 'static let stopNoticeRepeatSeconds: TimeInterval = 60',
    'static let redetectTag = "redetect"', 'let unexpected = armed', 'if isStacked { order["stacked"] = true }']) {
    assert.ok(hub.includes(s), s);
  }
  for (const s of ['override func broadcastPaused() {\n    detector.paused()', 'override func broadcastResumed() {\n    detector.resumed()',
    'self.telemetry.log("pause"', 'self.telemetry.log("resume"']) {
    assert.ok(ext.includes(s), s);
  }
});
