// v0.7（需求 F）：本期統計對齊 foodpanda 報酬單＋目標追蹤
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_GOALS,
  DEFAULT_STATS,
  goalProgress,
  goalText,
  graceLine,
  isOnTime,
  mergeBaseline,
  parseBaseline,
  overrunRatio,
  parseGoals,
  parsePercentInput,
  periodAndToday,
  periodOf,
  summarize,
  taipeiDayStart,
} from '../src/stats.ts';
import { DEFAULT_CONFIG, validateConfig } from '../src/remoteConfig.ts';

const tp = (s) => Date.parse(`${s}+08:00`); // 台北時間字串 → ms

test('彈性線 L＝預估×1.05；準時＝實際≤L（含浮點邊界）', () => {
  assert.equal(graceLine(20), 21);
  assert.ok(isOnTime({ est: 20, act: 21 }));
  assert.ok(!isOnTime({ est: 20, act: 21.01 }));
  assert.ok(isOnTime({ est: 16, act: 16.8 })); // 16×1.05 浮點＝16.8000000000000001
  assert.ok(!isOnTime({ est: 10, act: 11 }));
  assert.ok(isOnTime({ est: 10, act: 11 }, { graceFactor: 1.1, overrunCap: 1 }));
});

test('單筆超時比例：(實際−L)/L，夾 0…上限', () => {
  assert.equal(overrunRatio({ est: 20, act: 15 }), 0);
  assert.equal(overrunRatio({ est: 20, act: 31.5 }), 0.5);
  assert.equal(overrunRatio({ est: 10, act: 100 }), 1); // 上限 1
  assert.equal(overrunRatio({ est: 10, act: 100 }, { graceFactor: 1.05, overrunCap: 2 }), 2);
  assert.equal(overrunRatio({ est: 0, act: 5 }), 0);
});

test('summarize：準時率、超時率（平均）；零單 → null', () => {
  const s = summarize([{ est: 20, act: 15 }, { est: 20, act: 31.5 }, { est: 10, act: 100 }, { est: 20, act: 21 }]);
  assert.equal(s.count, 4);
  assert.equal(s.onTime, 2);
  assert.equal(s.onTimeRate, 0.5);
  assert.equal(s.overrunRate, (0 + 0.5 + 1 + 0) / 4);
  assert.deepEqual(summarize([]), { count: 0, onTime: 0, onTimeRate: null, overrunSum: 0, overrunRate: null });
});

test('週期：每 14 天、錨點 2026-09-28 00:00 台北；邊界跨日以台北時間為準', () => {
  assert.equal(periodOf(tp('2026-09-28T00:00:00')).id, '2026-09-28');
  assert.equal(periodOf(tp('2026-09-27T23:59:59')).id, '2026-09-14');
  assert.equal(periodOf(tp('2026-10-11T23:59:59')).id, '2026-09-28');
  assert.equal(periodOf(tp('2026-10-12T00:00:00')).id, '2026-10-12');
  // UTC 11/08 16:00 ＝ 台北 11/09 00:00 → 新的一期
  assert.equal(periodOf(Date.UTC(2026, 10, 8, 15, 59, 59)).id, '2026-10-26');
  assert.equal(periodOf(Date.UTC(2026, 10, 8, 16, 0, 0)).id, '2026-11-09');
  const p = periodOf(tp('2026-11-12T18:00:00'));
  assert.equal(p.label, '11/09–11/22');
  assert.equal(p.end - p.start, 14 * 86_400_000);
  assert.equal(periodOf(tp('2026-11-23T00:00:00')).label, '11/23–12/06');
  for (const id of ['2026-09-28', '2026-10-12', '2026-10-26', '2026-11-09', '2026-11-23', '2026-12-07']) {
    assert.equal(periodOf(tp(`${id}T00:00:00`)).id, id);
  }
  // 台北日 00:00
  assert.equal(taipeiDayStart(Date.UTC(2026, 10, 11, 16, 30)), tp('2026-11-12T00:00:00'));
  assert.equal(taipeiDayStart(Date.UTC(2026, 10, 11, 15, 59)), tp('2026-11-11T00:00:00'));
});

test('periodAndToday：本期/今日只算已送達、取消/進行中不計、按台北日切', () => {
  const o = (at, est, act, status = 'delivered') => ({ id: String(at), acceptedAt: tp(at), estimateMin: est, deadline: 0, status, actualMin: act });
  const orders = [
    o('2026-11-12T10:00:00', 20, 15),
    o('2026-11-12T00:10:00', 20, 30),
    o('2026-11-11T23:50:00', 20, 15), // 昨天（台北），本期
    o('2026-11-08T23:00:00', 20, 15), // 上一期
    o('2026-11-12T11:00:00', 20, 50, 'canceled'),
    { ...o('2026-11-12T12:00:00', 20, undefined, 'active') },
  ];
  const r = periodAndToday(orders, tp('2026-11-12T18:00:00'));
  assert.equal(r.period.label, '11/09–11/22');
  assert.equal(r.current.count, 3);
  assert.equal(r.today.count, 2);
  assert.equal(r.today.onTime, 1);
});

const sum = (onTime, count, overrunSum = 0) => ({ count, onTime, onTimeRate: count ? onTime / count : null, overrunSum, overrunRate: count ? overrunSum / count : null });

test('準時率三層（目標 50%／底線 40%）：達標、介於中間、低於底線；超時率單一門檻 ≤20%', () => {
  const g = DEFAULT_GOALS;
  assert.deepEqual(g, { onTimeRate: 0.5, onTimeFloor: 0.4, overrunRate: 0.2 });
  // 達標 8/10 → 8/(10+k) ≥ 0.5 → 還能晚 6 單
  let gp = goalProgress(sum(8, 10, 0.5), g);
  assert.equal(gp.onTimeLevel, 'met');
  assert.deepEqual([gp.needToGoal, gp.slackGoal, gp.slackFloor], [0, 6, 10]);
  assert.equal(goalText(gp, g).onTime, '準時率達標：還能晚 6 單仍達目標 50%');
  // 剛好 5/10＝目標 → 達標、還能晚 0 單
  gp = goalProgress(sum(5, 10), g);
  assert.deepEqual([gp.onTimeLevel, gp.slackGoal], ['met', 0]);
  // 介於：9/20＝45% → 再準時 2 單達目標（11/22＝50%）；底線 9/(20+k) ≥ 0.4 → 還能晚 2 單
  gp = goalProgress(sum(9, 20), g);
  assert.equal(gp.onTimeLevel, 'between');
  assert.deepEqual([gp.needToGoal, gp.slackFloor, gp.needToFloor], [2, 2, 0]);
  assert.equal(goalText(gp, g).onTime, '再準時 2 單達到目標 50%／還能晚 2 單仍在底線 40% 以上');
  // 剛好在底線 4/10 → between、還能晚 0 單、到目標要 2 單
  gp = goalProgress(sum(4, 10), g);
  assert.deepEqual([gp.onTimeLevel, gp.needToGoal, gp.slackFloor], ['between', 2, 0]);
  // 低於底線 3/10 → (3+n)/(10+n) ≥ 0.4 → n=2（5/12≈41.7%；少一單 4/11≈36.4%）
  gp = goalProgress(sum(3, 10, 3), g);
  assert.equal(gp.onTimeLevel, 'below');
  assert.deepEqual([gp.needToFloor, gp.needToGoal, gp.slackFloor, gp.slackGoal], [2, 4, 0, 0]);
  assert.equal(goalText(gp, g).onTime, '還要連續準時 2 單才回到底線 40%');
  // 超時率：3/10＝30% > 20% → 高於 10 個百分點、要連續 5 單不超時（3/15＝20%）
  assert.equal(gp.overrunMet, false);
  assert.ok(Math.abs(gp.overrunGap - 0.1) < 1e-9);
  assert.equal(gp.overrunNeed, 5);
  assert.equal(goalText(gp, g).overrun, '超時率未達標（高於目標 20% 10 個百分點，要連續 5 單不超時）');
  gp = goalProgress(sum(8, 10, 1), g);
  assert.deepEqual([gp.overrunMet, gp.overrunNeed], [true, 0]);
  assert.equal(goalText(gp, g).overrun, '超時率達標（低於目標 20% 10 個百分點）');
  // 零單
  gp = goalProgress(sum(0, 0), g);
  assert.equal(gp.onTimeLevel, null);
  assert.deepEqual(goalText(gp, g), { onTime: '還沒有單', overrun: '還沒有單' });
  // 自訂：目標 100% 且已有晚到 → 到目標不可能；底線 0% → 無限寬容
  gp = goalProgress(sum(2, 3), { onTimeRate: 1, onTimeFloor: 0, overrunRate: 0.2 });
  assert.deepEqual([gp.onTimeLevel, gp.needToGoal, gp.slackFloor], ['between', null, null]);
  // 驗算：照 need 補完剛好達標、少一單就不達標
  for (const [onTime, count, goal] of [[3, 10, 0.5], [0, 1, 0.5], [40, 100, 0.47], [7, 9, 0.9], [3, 10, 0.4]]) {
    const need = goalProgress(sum(onTime, count), { onTimeRate: goal, onTimeFloor: goal, overrunRate: 1 }).needToGoal;
    assert.ok((onTime + need) / (count + need) >= goal - 1e-9, `${onTime}/${count}`);
    if (need > 0) assert.ok((onTime + need - 1) / (count + need - 1) < goal - 1e-9, `${onTime}/${count} 少一單`);
  }
});

test('目標存取與輸入解析：壞資料 → 預設', () => {
  assert.deepEqual(parseGoals(null), DEFAULT_GOALS);
  assert.deepEqual(parseGoals('not json'), DEFAULT_GOALS);
  assert.deepEqual(parseGoals('{"onTimeRate":0.6,"onTimeFloor":0.45,"overrunRate":0.15}'), { onTimeRate: 0.6, onTimeFloor: 0.45, overrunRate: 0.15 });
  assert.deepEqual(parseGoals({ onTimeRate: 2, overrunRate: 'x' }), DEFAULT_GOALS);
  // v0.7 初版只存兩個欄位 → 底線補預設；底線高於目標 → 底線＝目標
  assert.deepEqual(parseGoals({ onTimeRate: 0.6, overrunRate: 0.2 }), { onTimeRate: 0.6, onTimeFloor: 0.4, overrunRate: 0.2 });
  assert.deepEqual(parseGoals({ onTimeRate: 0.3, onTimeFloor: 0.4, overrunRate: 0.2 }), { onTimeRate: 0.3, onTimeFloor: 0.3, overrunRate: 0.2 });
  assert.equal(parsePercentInput('50'), 0.5);
  assert.equal(parsePercentInput(' 47.5 % '), 0.475);
  assert.equal(parsePercentInput('101'), null);
  assert.equal(parsePercentInput('abc'), null);
});

test('遠端設定 stats：預設 1.05/1、缺漏補預設、範圍外用預設', () => {
  assert.deepEqual(DEFAULT_CONFIG.stats, DEFAULT_STATS);
  assert.deepEqual(DEFAULT_STATS, { graceFactor: 1.05, overrunCap: 1 });
  assert.deepEqual(validateConfig({ version: 'x' }).config.stats, DEFAULT_STATS);
  assert.deepEqual(validateConfig({ version: 'x', stats: { graceFactor: 1.1, overrunCap: 2 } }).config.stats, { graceFactor: 1.1, overrunCap: 2 });
  const bad = validateConfig({ version: 'x', stats: { graceFactor: 0.9, overrunCap: 0 } });
  assert.deepEqual(bad.config.stats, DEFAULT_STATS);
  assert.ok(bad.problems.some((p) => p.startsWith('stats.graceFactor')));
});

test('本期補登：N0=0 → 原樣；只有補登；補登＋App 紀錄加權合併；目標推算用合併值', () => {
  const own = summarize([{ est: 20, act: 15 }, { est: 20, act: 31.5 }]); // 1 準時、超時比例 0 與 0.5
  const b = (count, onTimeRate, overrunRate) => ({ periodId: '2026-11-09', count, onTimeRate, overrunRate });
  // N0=0／null → 原樣
  assert.deepEqual(mergeBaseline(own, b(0, 0.9, 0.1)), { ...own, baselineCount: 0 });
  assert.deepEqual(mergeBaseline(own, null), { ...own, baselineCount: 0 });
  // 只有補登（App 沒有單）
  const only = mergeBaseline(summarize([]), b(40, 0.45, 0.19));
  assert.equal(only.count, 40);
  assert.ok(Math.abs(only.onTimeRate - 0.45) < 1e-12);
  assert.ok(Math.abs(only.overrunRate - 0.19) < 1e-12);
  assert.equal(only.baselineCount, 40);
  // 合併：準時率＝(40·0.45 + 1)/(40+2)＝19/42；超時率＝(40·0.19 + 0.5)/42＝8.1/42
  const m = mergeBaseline(own, b(40, 0.45, 0.19));
  assert.equal(m.count, 42);
  assert.ok(Math.abs(m.onTimeRate - 19 / 42) < 1e-12);
  assert.ok(Math.abs(m.overrunRate - 8.1 / 42) < 1e-12);
  // 目標推算用合併值：19/42≈45.2% → 介於；再準時 n：(19+n)/(42+n) ≥ 0.5 → n=4
  const gp = goalProgress(m, DEFAULT_GOALS);
  assert.deepEqual([gp.onTimeLevel, gp.needToGoal], ['between', 4]);
  // periodAndToday：同期的補登才合併；今日不含補登；換期失效
  const o = (at, est, act) => ({ id: at, acceptedAt: tp(at), estimateMin: est, deadline: 0, status: 'delivered', actualMin: act });
  const orders = [o('2026-11-12T10:00:00', 20, 15)];
  const r = periodAndToday(orders, tp('2026-11-12T18:00:00'), DEFAULT_STATS, b(30, 0.5, 0.2));
  assert.deepEqual([r.current.count, r.current.baselineCount, r.own.count, r.today.count], [31, 30, 1, 1]);
  const next = periodAndToday(orders, tp('2026-11-23T09:00:00'), DEFAULT_STATS, b(30, 0.5, 0.2));
  assert.deepEqual([next.period.id, next.current.count, next.current.baselineCount], ['2026-11-23', 0, 0]);
});

test('parseBaseline：驗證欄位、綁期別（換期 → null）', () => {
  const good = { periodId: '2026-11-09', count: 37, onTimeRate: 0.47, overrunRate: 0.14 };
  assert.deepEqual(parseBaseline(JSON.stringify(good)), good);
  assert.deepEqual(parseBaseline(good, '2026-11-09'), good);
  assert.equal(parseBaseline(good, '2026-11-23'), null);
  for (const bad of [null, 'x', '[]', { ...good, count: -1 }, { ...good, count: 2.5 }, { ...good, count: 5000 }, { ...good, onTimeRate: 47 }, { ...good, periodId: '11/09' }, { ...good, overrunRate: null }]) {
    assert.equal(parseBaseline(bad), null, JSON.stringify(bad));
  }
});

// 使用者三期真實單（只在本機 scratchpad 有檔時跑；**不進 repo**）。PANDATIMER_FP_ORDERS 可指定路徑。
const FP = process.env.PANDATIMER_FP_ORDERS
  || '/tmp/claude-1000/-home-minyue-IOS/b3dd0835-74b1-456e-9c83-896250f87a7e/scratchpad/fp/orders.json';
test('三期真實報酬單：準時/超時率接近官方（43/19、45/19、40/21 ≈ 官方 44/19、47/14、39/20）', { skip: !fs.existsSync(FP) && '沒有本機樣本檔' }, () => {
  const rows = JSON.parse(fs.readFileSync(FP, 'utf8')).filter((r) => !String(r.id).includes('cancelled'));
  const by = new Map();
  for (const r of rows) {
    assert.equal(periodOf(Date.parse(`${r.date}T12:00:00+08:00`)).id.replaceAll('-', ''), r.p, `${r.date} 期別`);
    if (!by.has(r.p)) by.set(r.p, []);
    by.get(r.p).push({ est: r.est, act: r.act });
  }
  const got = Object.fromEntries([...by].map(([p, s]) => {
    const x = summarize(s);
    return [p, [Math.round(x.onTimeRate * 100), Math.round(x.overrunRate * 100)]];
  }));
  console.log('三期（準時%/超時%）', JSON.stringify(got));
  assert.deepEqual(got, { 20260928: [43, 19], 20261012: [45, 19], 20261026: [40, 21] });
});

test('v0.8 不含夾單的準時率/超時率（本期與今日；不併補登）', async () => {
  const { periodAndToday } = await import('../src/stats.ts');
  const now = Date.UTC(2026, 10, 12, 6, 0); // 台北 14:00
  const mk = (id, minAgo, est, act, stacked) => ({
    id, acceptedAt: now - minAgo * 60_000, estimateMin: est, deadline: now - minAgo * 60_000 + est * 60_000,
    status: 'delivered', actualMin: act, deliveredAt: now - minAgo * 60_000 + act * 60_000, ...(stacked ? { stacked: true } : {}),
  });
  const orders = [mk('a', 120, 20, 18), mk('b', 100, 12, 30, true), mk('c', 60, 15, 20)];
  const r = periodAndToday(orders, now);
  assert.equal(r.own.count, 3);
  assert.equal(r.noStacked.stackedCount, 1);
  assert.equal(r.noStacked.stackedToday, 1);
  assert.equal(r.noStacked.period.count, 2);
  assert.equal(r.noStacked.period.onTimeRate, 0.5); // a 準時、c 超時（20 > 15.75）
  assert.equal(r.noStacked.today.count, 2);
  assert.ok(r.noStacked.period.overrunRate < r.own.overrunRate);
});
