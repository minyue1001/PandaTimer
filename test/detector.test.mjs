import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSignalNames,
  beatAgeSec,
  countAutoToday,
  locationAuthPending,
  parseDetectorStatus,
  parseSignalName,
} from '../src/detector.ts';

test('parseSignalName：order.N 只收 1…90 的純數字', () => {
  assert.deepEqual(parseSignalName('com.pandatimer.order.27'), { kind: 'order', minutes: 27 });
  assert.deepEqual(parseSignalName('com.pandatimer.order.1'), { kind: 'order', minutes: 1 });
  assert.deepEqual(parseSignalName('com.pandatimer.order.90'), { kind: 'order', minutes: 90 });
  for (const bad of ['0', '91', '07', '+5', '5.0', '', 'abc', '27 ', '100']) {
    assert.equal(parseSignalName(`com.pandatimer.order.${bad}`), null, bad);
  }
});

test('parseSignalName：狀態訊號與垃圾', () => {
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.started'), { kind: 'started' });
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.stopped'), { kind: 'stopped' });
  assert.deepEqual(parseSignalName('com.pandatimer.broadcast.heartbeat'), { kind: 'heartbeat' });
  assert.deepEqual(parseSignalName('com.pandatimer.drain'), { kind: 'drain' });
  assert.equal(parseSignalName('com.pandatimer.broadcast.paused'), null);
  assert.equal(parseSignalName('com.other.order.5'), null);
  assert.equal(parseSignalName(null), null);
  assert.equal(parseSignalName(5), null);
});

test('allSignalNames：94 個、每個都解析得回來、無重複', () => {
  const names = allSignalNames();
  assert.equal(names.length, 94);
  assert.equal(new Set(names).size, 94);
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
});

test('parseDetectorStatus：容錯', () => {
  assert.equal(parseDetectorStatus(null), null);
  assert.equal(parseDetectorStatus('not json'), null);
  assert.equal(parseDetectorStatus('[]'), null);
  const s = parseDetectorStatus(JSON.stringify({ armed: true, keepAlive: '音訊中', lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2 }));
  assert.deepEqual(s, { armed: true, keepAlive: '音訊中', keepAliveMode: 'none', locationAuth: 'unknown', keepAliveError: undefined, lastFixAt: null, islandCheck: '', lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2 });
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

test('v0.5：最近一次自動偵測的鍵名，App（LastAutoStore）與按鈕 intent 一致', async () => {
  const fs = await import('node:fs');
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  const intent = read('../native/intents/StartDetectedCountdownIntent.swift');
  const key = '"pandatimer.detector.lastAuto.v1"';
  assert.ok(hub.includes(key));
  assert.ok(intent.includes(key));
  // 進行中鏡像鍵名與 PandaSharedStore / NativeSync 一致
  assert.ok(intent.includes('"pandatimer.native.activeOrders.v1"'));
  assert.ok(read('../native/intents/DeliverActivityIntent.swift').includes('"pandatimer.native.activeOrders.v1"'));
  // JSON 欄位名
  for (const f of ['"orderId"', '"minutes"', '"detectedAt"', '"activityId"']) {
    assert.ok(hub.includes(f), `DetectorHub 缺 ${f}`);
    assert.ok(intent.includes(f), `intent 缺 ${f}`);
  }
  // extension 通知 userInfo 與 App 端讀法一致
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const f of ['"pandatimer": "detected"', '"detectedAt"']) assert.ok(ext.includes(f), `SampleHandler 缺 ${f}`);
  assert.ok(hub.includes('(info["pandatimer"] as? String) == "detected"'));
});

test('v0.5：app.json 背景模式／定位說明／runtimeVersion 與 OtaBox 一致', async () => {
  const fs = await import('node:fs');
  const app = JSON.parse(fs.readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo;
  const plist = app.ios.infoPlist;
  assert.deepEqual([...plist.UIBackgroundModes].sort(), ['audio', 'location']);
  assert.ok(plist.NSLocationWhenInUseUsageDescription.length > 5);
  assert.ok(plist.NSLocationAlwaysAndWhenInUseUsageDescription.length > 5);
  assert.equal(app.runtimeVersion, '0.5');
  const ota = fs.readFileSync(new URL('../src/OtaBox.tsx', import.meta.url), 'utf8');
  assert.ok(ota.includes(`const APP_VERSION = '${app.runtimeVersion}'`));
  // 零 entitlement：app.json 不得出現 entitlements 設定
  assert.equal(app.ios.entitlements, undefined);
});
