import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nativeEventsModule from '../src/nativeEvents.ts';
import { applyNativeEvents, parseNativeEvents, activeMirror } from '../src/nativeEvents.ts';

const MIN = 60_000;
const jsOrder = (id, acceptedAt, extra = {}) => ({
  id, acceptedAt, estimateMin: 18, deadline: acceptedAt + 18 * MIN, status: 'active', ...extra,
});

test('start 事件新增進行中訂單，重複 id 忽略', () => {
  const ev = parseNativeEvents([
    { type: 'start', id: 'n1', acceptedAt: 1000, estimateMin: 22, deadline: 1000 + 22 * MIN, activityId: 'A1', notifIds: ['x', 'y'] },
    { type: 'start', id: 'n1', acceptedAt: 1000, estimateMin: 22, deadline: 1000 + 22 * MIN },
    { type: 'start', id: 'bad' }, // 欄位不完整 → 丟掉
  ]);
  assert.equal(ev.length, 2);
  const out = applyNativeEvents([], ev);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'n1', acceptedAt: 1000, estimateMin: 22, deadline: 1000 + 22 * MIN, status: 'active', activityId: 'A1', notifIds: ['x', 'y'] });
});

test('done 無指定 → 最早一筆進行中；含原生剛開的單', () => {
  const orders = [jsOrder('j2', 5 * MIN), jsOrder('j1', 2 * MIN)];
  const out = applyNativeEvents(orders, parseNativeEvents([{ type: 'done', at: 20 * MIN }]));
  const j1 = out.find((o) => o.id === 'j1');
  assert.equal(j1.status, 'delivered');
  assert.equal(j1.actualMin, 18);
  assert.equal(out.find((o) => o.id === 'j2').status, 'active');
});

test('done 指定 orderId（DeliveredIntent 從鏡像挑的）只結那一單', () => {
  const orders = [jsOrder('j2', 5 * MIN), jsOrder('j1', 2 * MIN)];
  const out = applyNativeEvents(orders, parseNativeEvents([{ type: 'done', at: 10 * MIN, orderId: 'j2', activityId: 'zz' }]));
  assert.equal(out.find((o) => o.id === 'j2').status, 'delivered');
  assert.equal(out.find((o) => o.id === 'j1').status, 'active');
});

test('done 只有 activityId（動態島按鈕、鏡像沒這單）→ 以 activityId 對應', () => {
  const orders = [jsOrder('j1', 2 * MIN, { activityId: 'A' }), jsOrder('j2', 3 * MIN, { activityId: 'B' })];
  const out = applyNativeEvents(orders, parseNativeEvents([{ type: 'done', at: 10 * MIN, activityId: 'B' }]));
  assert.equal(out.find((o) => o.id === 'j2').status, 'delivered');
  assert.equal(out.find((o) => o.id === 'j1').status, 'active');
});

test('done 指定但找不到（已在 App 內結掉）→ 不誤結別張', () => {
  const orders = [jsOrder('j1', 2 * MIN), { ...jsOrder('j0', 1 * MIN), status: 'canceled' }];
  const out = applyNativeEvents(orders, parseNativeEvents([{ type: 'done', at: 10 * MIN, orderId: 'j0' }]));
  assert.equal(out.find((o) => o.id === 'j1').status, 'active');
  assert.equal(out.find((o) => o.id === 'j0').status, 'canceled');
});

test('start 後 done（都在背景發生）依序套用', () => {
  const out = applyNativeEvents([], parseNativeEvents([
    { type: 'start', id: 'n1', acceptedAt: 0, estimateMin: 12, deadline: 12 * MIN },
    { type: 'done', at: 15 * MIN, orderId: 'n1' },
  ]));
  assert.equal(out[0].status, 'delivered');
  assert.equal(out[0].actualMin, 15);
});

test('非陣列 / 垃圾輸入 → 空', () => {
  assert.deepEqual(parseNativeEvents(null), []);
  assert.deepEqual(parseNativeEvents({}), []);
  assert.deepEqual(parseNativeEvents([1, 'x', null]), []);
});

test('activeMirror 只含進行中、最早在前', () => {
  const m = activeMirror([jsOrder('b', 5), { ...jsOrder('c', 1), status: 'delivered' }, jsOrder('a', 2, { activityId: 'A' })]);
  assert.deepEqual(m.map((o) => o.id), ['a', 'b']);
  assert.equal(m[0].activityId, 'A');
  assert.equal('activityId' in m[1], false);
});

test('orphanActivityIds：偵測卡一律保留，其餘照舊對帳', () => {
  const { orphanActivityIds } = nativeEventsModule;
  const alive = [
    { id: 'A1', mode: 'countdown', detector: false }, // 進行中訂單的卡 → 保留
    { id: 'A2', mode: 'countdown', detector: false }, // 訂單已結束 → 孤兒
    { id: 'S1', mode: 'standby', detector: true }, // 偵測待命 → 保留
    { id: 'S2', mode: 'countdown', detector: true }, // 偵測程式改成倒數（JS 不知道）→ 保留
    { id: 'S3', mode: 'stopped', detector: true }, // 偵測已停止 → 保留
  ];
  assert.deepEqual(orphanActivityIds(alive, ['A1', undefined]), ['A2']);
  assert.deepEqual(orphanActivityIds([], ['A1']), []);
});

test('v0.4 自動單：source 保留；沿用偵測卡時舊單讓出 activityId', () => {
  const ev = parseNativeEvents([
    { type: 'start', id: 'a1', acceptedAt: 0, estimateMin: 20, deadline: 20 * MIN, activityId: 'DET', notifIds: [], source: 'auto' },
    { type: 'start', id: 'a2', acceptedAt: 5 * MIN, estimateMin: 27, deadline: 32 * MIN, activityId: 'DET', notifIds: [], source: 'auto' },
    { type: 'start', id: 'x', acceptedAt: 6 * MIN, estimateMin: 10, deadline: 16 * MIN, source: 'weird' },
  ]);
  assert.equal(ev[0].source, 'auto');
  assert.equal('source' in ev[2], false);
  const out = applyNativeEvents([jsOrder('j1', 1 * MIN, { activityId: 'OTHER' })], ev);
  const a1 = out.find((o) => o.id === 'a1');
  const a2 = out.find((o) => o.id === 'a2');
  assert.equal(a1.activityId, undefined);
  assert.equal(a2.activityId, 'DET');
  assert.equal(a2.source, 'auto');
  assert.equal(out.find((o) => o.id === 'j1').activityId, 'OTHER');
  // 之後動態島送達（只帶 activityId）→ 結的是最新那單 a2
  const after = applyNativeEvents(out, parseNativeEvents([{ type: 'done', at: 30 * MIN, activityId: 'DET' }]));
  assert.equal(after.find((o) => o.id === 'a2').status, 'delivered');
  assert.equal(after.find((o) => o.id === 'a1').status, 'active');
});
