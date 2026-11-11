import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSignalNames,
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

test('allSignalNames：364 個（< 1000）、每個都解析得回來、無重複', () => {
  const names = allSignalNames();
  assert.equal(names.length, 4 + 90 * 4);
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
  assert.deepEqual(s, { armed: true, keepAlive: '音訊中', keepAliveMode: 'none', locationAuth: 'unknown', keepAliveError: undefined, lastFixAt: null, islandCheck: '', lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2, telemetryLastOk: null, telemetryPending: 0, telemetryError: undefined, configVersion: 'default' });
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
  assert.equal(app.runtimeVersion, '0.6');
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
