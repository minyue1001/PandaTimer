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

test('v0.6 多單：自動單共用偵測卡 activityId；動態島送達（只帶 activityId）結的是最早截止那單', () => {
  const ev = parseNativeEvents([
    { type: 'start', id: 'a1', acceptedAt: 0, estimateMin: 30, deadline: 30 * MIN, activityId: 'DET', notifIds: [], source: 'auto' },
    { type: 'start', id: 'a2', acceptedAt: 5 * MIN, estimateMin: 18, deadline: 23 * MIN, activityId: 'DET', notifIds: [], source: 'auto' },
    { type: 'start', id: 'x', acceptedAt: 6 * MIN, estimateMin: 10, deadline: 16 * MIN, source: 'weird' },
  ]);
  assert.equal(ev[0].source, 'auto');
  assert.equal('source' in ev[2], false);
  const out = applyNativeEvents([jsOrder('j1', 1 * MIN, { activityId: 'OTHER' })], ev);
  const a1 = out.find((o) => o.id === 'a1');
  const a2 = out.find((o) => o.id === 'a2');
  // 不再讓出 activityId：兩單都掛在偵測卡上
  assert.equal(a1.activityId, 'DET');
  assert.equal(a2.activityId, 'DET');
  assert.equal(a2.source, 'auto');
  assert.equal(out.find((o) => o.id === 'j1').activityId, 'OTHER');
  // 卡上顯示的是最早截止的 a2（23 分 < 30 分）→ 只帶 activityId 的送達結 a2
  const after = applyNativeEvents(out, parseNativeEvents([{ type: 'done', at: 20 * MIN, activityId: 'DET' }]));
  assert.equal(after.find((o) => o.id === 'a2').status, 'delivered');
  assert.equal(after.find((o) => o.id === 'a1').status, 'active');
  // 再送達一次 → 換 a1
  const after2 = applyNativeEvents(after, parseNativeEvents([{ type: 'done', at: 25 * MIN, activityId: 'DET' }]));
  assert.equal(after2.find((o) => o.id === 'a1').status, 'delivered');
  assert.equal(after2.find((o) => o.id === 'j1').status, 'active');
});

test('v0.8：原生 start 事件的 stacked 帶進訂單；非 true 一律忽略', () => {
  const ev = parseNativeEvents([
    { type: 'start', id: 's1', acceptedAt: 1000, estimateMin: 12, deadline: 1000 + 12 * MIN, source: 'auto', stacked: true },
    { type: 'start', id: 's2', acceptedAt: 2000, estimateMin: 12, deadline: 2000 + 12 * MIN, stacked: 'yes' },
  ]);
  assert.equal(ev[0].stacked, true);
  assert.equal(ev[1].stacked, undefined);
  const list = applyNativeEvents([], ev);
  assert.equal(list.find((o) => o.id === 's1').stacked, true);
  assert.equal('stacked' in list.find((o) => o.id === 's2'), false);
});
