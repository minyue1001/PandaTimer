// v1.3：星號風險（單接又超過預估）、本期/今日星號數、件數進度、Goals 舊存檔相容、新提示/摘要純函式
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GOALS,
  countProgress,
  goalProgress,
  parseGoals,
  parsePeriodOrdersInput,
  periodStarCount,
  starRisk,
  summarize,
  todayStarCount,
} from '../src/stats.ts';
import { countHint, countPaceText, daySummaryText, groupHistory, orderTags } from '../src/ui/logic.ts';

const tp = (s) => Date.parse(`${s}+08:00`);
const MIN = 60_000;
const ord = (id, at, est, act, extra = {}) => {
  const acceptedAt = tp(at);
  return {
    id, acceptedAt, estimateMin: est, deadline: acceptedAt + est * MIN, status: 'delivered',
    actualMin: act, deliveredAt: acceptedAt + act * MIN, ...extra,
  };
};
const NOW = tp('2026-11-12T20:00:00');

test('starRisk：單接晚到 → true', () => {
  const a = ord('a', '2026-11-12T10:00:00', 20, 25);
  assert.equal(starRisk(a, [a], NOW), true);
});

test('starRisk：疊單期間晚到 → false（對方已送達的重疊）', () => {
  const a = ord('a', '2026-11-12T10:00:00', 20, 25);
  const b = ord('b', '2026-11-12T10:10:00', 20, 15); // 10:10~10:25 與 a 重疊
  assert.equal(starRisk(a, [a, b], NOW), false);
});

test('starRisk：準時（含剛好等於預估）→ false；多 0.01 分（未超過 ×1.05 也算）→ true', () => {
  const ok = ord('a', '2026-11-12T10:00:00', 20, 20);
  assert.equal(starRisk(ok, [ok], NOW), false);
  const slightly = ord('b', '2026-11-12T12:00:00', 20, 20.5); // 未超過 ×1.05 彈性線，但實際>預估＝星號風險
  assert.equal(starRisk(slightly, [slightly], NOW), true);
});

test('starRisk：noTiming／未送達／取消的重疊單不算', () => {
  const nt = ord('n', '2026-11-12T10:00:00', 20, 30, { noTiming: true });
  assert.equal(starRisk(nt, [nt], NOW), false);
  const act = { id: 'x', acceptedAt: tp('2026-11-12T10:00:00'), estimateMin: 20, deadline: 0, status: 'active' };
  assert.equal(starRisk(act, [act], NOW), false);
  const a = ord('a', '2026-11-12T10:00:00', 20, 25);
  const cx = { id: 'c', acceptedAt: tp('2026-11-12T10:05:00'), estimateMin: 20, deadline: 0, status: 'canceled' };
  assert.equal(starRisk(a, [a, cx], NOW), true); // 取消的不算重疊
});

test('starRisk：進行中的其他單算重疊（區間到 now）；沒重疊的進行中單不影響', () => {
  const a = ord('a', '2026-11-12T10:00:00', 20, 25);
  const running = { id: 'r', acceptedAt: tp('2026-11-12T10:20:00'), estimateMin: 20, deadline: 0, status: 'active' };
  assert.equal(starRisk(a, [a, running], NOW), false); // 10:20 接的單與 a(10:00~10:25) 重疊
  const later = { id: 'l', acceptedAt: tp('2026-11-12T10:30:00'), estimateMin: 20, deadline: 0, status: 'active' };
  assert.equal(starRisk(a, [a, later], NOW), true);
  // 前一單剛送達（端點相接）不算重疊
  const prev = ord('p', '2026-11-12T09:35:00', 20, 25); // 09:35~10:00
  assert.equal(starRisk(a, [a, prev], NOW), true);
});

test('periodStarCount／todayStarCount：本期（台北週期）內、補登不算', () => {
  const orders = [
    ord('a', '2026-11-12T10:00:00', 20, 25), // 星
    ord('b', '2026-11-12T12:00:00', 20, 18), // 準時
    ord('c', '2026-11-12T14:00:00', 20, 25), // 星
    ord('d', '2026-11-13T10:00:00', 20, 25), // 星（另一天）
    ord('old', '2026-11-08T10:00:00', 20, 25), // 上一期
  ];
  assert.equal(periodStarCount(orders, tp('2026-11-13T12:00:00')), 3);
  assert.equal(todayStarCount(orders, tp('2026-11-13T12:00:00')), 1);
  assert.equal(todayStarCount(orders, tp('2026-11-12T20:00:00')), 2);
});

test('countProgress：剩餘天數含今天、每天要幾單、達標、今日還要', () => {
  // 期間 11/09–11/22（末日 11/22），11/12 18:00 → 剩 11/12..11/22 ＝ 11 天
  const now = tp('2026-11-12T18:00:00');
  const p = countProgress(100, 375, now, 10);
  assert.equal(p.daysLeft, 11);
  assert.equal(p.remaining, 275);
  assert.equal(p.perDay, 25); // ceil(275/11)=25
  assert.equal(p.done, false);
  // 今日配額：今天前 90 單 → ceil(285/11)=26；今日已 10 → 還要 16
  assert.equal(p.todayLeft, 16);
  const done = countProgress(375, 375, now, 3);
  assert.deepEqual([done.done, done.perDay, done.todayLeft, done.remaining], [true, 0, 0, 0]);
  // 最後一天：剩 1 天
  assert.equal(countProgress(0, 375, tp('2026-11-22T23:00:00')).daysLeft, 1);
  assert.equal(countPaceText(p), '還剩 11 天，平均每天要 25 單');
  assert.equal(countPaceText(done), '已達標 🎉');
});

test('countHint：落後提示今天還要 X 單；有星號提示單接盯倒數；低於底線警示', () => {
  const g = DEFAULT_GOALS;
  const gp = goalProgress(summarize([{ est: 20, act: 18 }]), g);
  const prog = countProgress(100, 375, tp('2026-11-12T18:00:00'), 10);
  const h = countHint(prog, 2, gp, g);
  assert.equal(h.main, '今天還要 16 單');
  assert.match(h.star, /單接盯倒數，歸零前送到就不會被打星/);
  assert.equal(countHint(prog, 0, gp, g).star, null);
  assert.equal(countHint(countProgress(375, 375, NOW), 0, gp, g).main, '本期件數已達標 🎉');
  const low = goalProgress(summarize([{ est: 20, act: 40 }, { est: 20, act: 40 }]), g);
  assert.equal(countHint(prog, 0, low, g).overrun, '準時率低於底線 40%');
});

test('Goals：預設 375／準時目標＝底線 40%；舊存檔補 periodOrders、自訂值保留、壞值 → 預設', () => {
  assert.deepEqual(DEFAULT_GOALS, { onTimeRate: 0.4, onTimeFloor: 0.4, overrunRate: 0.2, periodOrders: 375 });
  assert.deepEqual(parseGoals(null), DEFAULT_GOALS);
  // 舊存檔（v1.2：只有三個率）→ 自訂 50% 保留、補 375
  assert.deepEqual(parseGoals('{"onTimeRate":0.5,"onTimeFloor":0.4,"overrunRate":0.2}'), { onTimeRate: 0.5, onTimeFloor: 0.4, overrunRate: 0.2, periodOrders: 375 });
  assert.equal(parseGoals({ periodOrders: 420 }).periodOrders, 420);
  assert.equal(parseGoals({ periodOrders: 10 }).periodOrders, 375);
  assert.equal(parseGoals({ periodOrders: 5000 }).periodOrders, 375);
  assert.equal(parseGoals({ periodOrders: 'x' }).periodOrders, 375);
  assert.equal(parsePeriodOrdersInput('375'), 375);
  assert.equal(parsePeriodOrdersInput(' 50 '), 50);
  assert.equal(parsePeriodOrdersInput('49'), null);
  assert.equal(parsePeriodOrdersInput('1001'), null);
  assert.equal(parsePeriodOrdersInput('abc'), null);
});

test('紀錄頁：星號列有 star／tags、日摘要加 ⭐N', () => {
  const orders = [ord('a', '2026-11-12T10:00:00', 20, 25), ord('b', '2026-11-12T12:00:00', 20, 18)];
  const r = groupHistory(orders, { now: NOW });
  const g = r.groups[0];
  assert.equal(g.subtotal.star, 1);
  const rowA = g.rows.find((x) => x.order.id === 'a');
  assert.equal(rowA.star, true);
  assert.ok(rowA.tags.includes('星號風險'));
  assert.equal(g.rows.find((x) => x.order.id === 'b').star, false);
  assert.match(daySummaryText(g.subtotal), /⭐1$/);
  assert.doesNotMatch(daySummaryText({ count: 1, onTimeRate: 1, payout: 45, star: 0 }), /⭐/);
  assert.deepEqual(orderTags({ source: 'auto' }, true), ['自動', '星號風險']);
});
