import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSignalNames,
  beatAgeSec,
  countAutoToday,
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
  assert.deepEqual(s, { armed: true, keepAlive: '音訊中', keepAliveError: undefined, lastBeatAt: 1000, lastOrderMinutes: 27, lastOrderAt: 2000, lastOrderHow: 'x', autoCountSinceLaunch: 2 });
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
