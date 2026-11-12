import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmAcceptedAt, EMPTY_STATE, matchOrder, parseOfferState, recordOffer, removeEntry, tick, waitSecFor,
} from '../src/unconfirmedOffers.ts';

const T0 = 1_000_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;

test('waitSecFor：decideWindowSec+10，讀不到用 35', () => {
  assert.equal(waitSecFor(25), 35);
  assert.equal(waitSecFor(40), 50);
  assert.equal(waitSecFor(undefined), 35);
  assert.equal(waitSecFor(3), 35);
});

test('沒收到 order：逾時後變未確認，之前仍是 pending', () => {
  let s = recordOffer(EMPTY_STATE, 19, T0, 'a');
  assert.equal(tick(s, T0 + 34 * SEC, 35).unconfirmed.length, 0);
  s = tick(s, T0 + 35 * SEC, 35);
  assert.deepEqual(s.unconfirmed.map((e) => e.min), [19]);
  assert.equal(s.pending.length, 0);
});

test('窗內收到同分鐘 order：不會變未確認；不同分鐘不影響', () => {
  let s = recordOffer(EMPTY_STATE, 19, T0, 'a');
  s = matchOrder(s, 20);
  assert.equal(s.pending.length, 1);
  s = matchOrder(s, 19);
  assert.equal(s.pending.length, 0);
  assert.equal(tick(s, T0 + 60 * SEC, 35).unconfirmed.length, 0);
});

test('延遲入帳：未確認卡被同分鐘 order 移除，且只移除最早一張', () => {
  let s = recordOffer(EMPTY_STATE, 19, T0, 'a');
  s = recordOffer(s, 19, T0 + 5 * MIN, 'b');
  s = tick(s, T0 + 6 * MIN, 35);
  assert.equal(s.unconfirmed.length, 2);
  s = matchOrder(s, 19);
  assert.deepEqual(s.unconfirmed.map((e) => e.id), ['b']);
});

test('同分鐘 90 秒內重送視為同一張', () => {
  let s = recordOffer(EMPTY_STATE, 19, T0, 'a');
  s = recordOffer(s, 19, T0 + 30 * SEC, 'b');
  assert.equal(s.pending.length, 1);
  assert.equal(recordOffer(s, 0, T0, 'x'), s);
  assert.equal(recordOffer(s, 91, T0, 'x'), s);
});

test('最多留最近 3 張（新的在前）；超過 30 分鐘消失', () => {
  let s = EMPTY_STATE;
  for (let i = 0; i < 5; i++) s = recordOffer(s, 10 + i, T0 + i * 3 * MIN, `o${i}`);
  s = tick(s, T0 + 20 * MIN, 35);
  assert.deepEqual(s.unconfirmed.map((e) => e.id), ['o4', 'o3', 'o2']);
  s = tick(s, T0 + 12 * MIN + 31 * MIN, 35); // o4 於 T0+12min
  assert.equal(s.unconfirmed.length, 0);
});

test('App 重開：pending 已過窗 → 直接成未確認；已過 30 分鐘 → 丟掉', () => {
  const s = parseOfferState(JSON.stringify({ pending: [{ id: 'a', min: 19, at: T0 }, { id: 'z', min: 7, at: T0 - 40 * MIN }], unconfirmed: [] }));
  const t = tick(s, T0 + 10 * MIN, 35);
  assert.deepEqual(t.unconfirmed.map((e) => e.id), ['a']);
  assert.equal(t.pending.length, 0);
});

test('removeEntry、confirmAcceptedAt、壞資料', () => {
  const s = recordOffer(EMPTY_STATE, 19, T0, 'a');
  assert.equal(removeEntry(s, 'a').pending.length, 0);
  assert.equal(confirmAcceptedAt({ id: 'a', min: 19, at: T0 }), T0 + 5000);
  assert.deepEqual(parseOfferState('{bad'), { pending: [], unconfirmed: [] });
  assert.deepEqual(parseOfferState({ pending: [{ id: 1 }, null], unconfirmed: 'x' }), { pending: [], unconfirmed: [] });
  assert.deepEqual(parseOfferState(null), { pending: [], unconfirmed: [] });
});
