import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addTombstones, applyPrune, describePlan, dropTombstonedEvents, formatTaipeiDateTime,
  parseTaipeiDateTime, parseTombstones, planPrune, pruneTombstones, taipeiStartOfDay, TOMBSTONE_TTL_MS,
} from '../src/prune.ts';
import { applyNativeEvents } from '../src/nativeEvents.ts';

const MIN = 60_000;
const H = 60 * MIN;
// 台北 2026-11-12 10:00 = UTC 02:00
const NOW = Date.UTC(2026, 10, 12, 2, 0);
const ord = (id, acceptedAt, status = 'delivered', extra = {}) => ({
  id, acceptedAt, estimateMin: 18, deadline: acceptedAt + 18 * MIN, status,
  ...(status === 'delivered' ? { deliveredAt: acceptedAt + 20 * MIN, actualMin: 20 } : {}), ...extra,
});
const list = [
  ord('a', NOW - 1 * H, 'active', { activityId: 'card' }),   // 台北 09:00 今天
  ord('b', NOW - 5 * H),                                      // 台北 05:00 今天
  ord('c', NOW - 11 * H, 'canceled'),                         // 台北 前一天 23:00
  ord('d', NOW - 30 * H),                                     // 前一天
];

test('單筆刪除', () => {
  const p = planPrune(list, { kind: 'ids', ids: ['b'] });
  assert.deepEqual(p.ids, ['b']);
  assert.equal(p.activeCount, 0);
  assert.deepEqual(applyPrune(list, p.ids).map((o) => o.id), ['a', 'c', 'd']);
});

test('單筆刪除進行中單：active 旗標帶出該單供收動態島', () => {
  const p = planPrune(list, { kind: 'ids', ids: ['a'] });
  assert.equal(p.activeCount, 1);
  assert.equal(p.active[0].activityId, 'card');
  assert.match(describePlan(p), /進行中/);
});

test('今天（台北時區）：台北 00:00 邊界', () => {
  assert.equal(taipeiStartOfDay(NOW), Date.UTC(2026, 10, 11, 16, 0)); // 台北 11/12 00:00
  const p = planPrune(list, { kind: 'today', now: NOW });
  assert.deepEqual(p.ids.sort(), ['a', 'b']);
  assert.equal(p.activeCount, 1);
  // 邊界：剛好 00:00 算今天、差 1ms 不算
  const edge = [ord('x', taipeiStartOfDay(NOW)), ord('y', taipeiStartOfDay(NOW) - 1)];
  assert.deepEqual(planPrune(edge, { kind: 'today', now: NOW }).ids, ['x']);
  // UTC 日期還是前一天、但台北已是今天（UTC 17:00 = 台北隔天 01:00）
  const late = Date.UTC(2026, 10, 11, 17, 0);
  assert.equal(taipeiStartOfDay(late), Date.UTC(2026, 10, 11, 16, 0));
});

test('某時間以前（不含該時間點），含取消單', () => {
  const ts = parseTaipeiDateTime('2026-11-12 05:00'); // = b 的接單時間
  assert.equal(ts, NOW - 5 * H);
  const p = planPrune(list, { kind: 'before', ts });
  assert.deepEqual(p.ids.sort(), ['c', 'd']);
  assert.equal(p.activeCount, 0);
});

test('全部', () => {
  const p = planPrune(list, { kind: 'all' });
  assert.equal(p.count, 4);
  assert.equal(p.activeCount, 1);
  assert.deepEqual(applyPrune(list, p.ids), []);
});

test('日期時間解析／格式化', () => {
  assert.equal(parseTaipeiDateTime('2026-02-31 10:00'), null);
  assert.equal(parseTaipeiDateTime('2026-11-12 25:00'), null);
  assert.equal(parseTaipeiDateTime('abc'), null);
  assert.equal(formatTaipeiDateTime(NOW), '2026-11-12 10:00');
  assert.equal(parseTaipeiDateTime(formatTaipeiDateTime(NOW)), NOW);
});

test('墓碑：已刪單的 start 事件 drain 後不會復活', () => {
  const orders = applyPrune(list, ['a']);
  const t = addTombstones({}, ['a'], NOW);
  const events = [
    { type: 'start', id: 'a', acceptedAt: NOW - H, estimateMin: 18, deadline: NOW, activityId: 'card' },
    { type: 'start', id: 'new', acceptedAt: NOW, estimateMin: 20, deadline: NOW + 20 * MIN },
    { type: 'done', at: NOW, orderId: 'a' },
  ];
  // 沒墓碑 → 復活（證明有必要）
  assert.ok(applyNativeEvents(orders, events).some((o) => o.id === 'a'));
  const out = applyNativeEvents(orders, dropTombstonedEvents(events, t));
  assert.ok(!out.some((o) => o.id === 'a'));
  assert.ok(out.some((o) => o.id === 'new'));
});

test('墓碑 7 天後過期；損毀資料被濾掉', () => {
  const t = addTombstones({}, ['a'], NOW);
  assert.ok('a' in pruneTombstones(t, NOW + TOMBSTONE_TTL_MS - 1));
  assert.ok(!('a' in pruneTombstones(t, NOW + TOMBSTONE_TTL_MS)));
  assert.ok(!('old' in addTombstones({ old: NOW - TOMBSTONE_TTL_MS - 1 }, ['n'], NOW)));
  assert.deepEqual(parseTombstones({ a: 1, b: 'x', c: null }), { a: 1 });
  assert.deepEqual(parseTombstones([1, 2]), {});
});
