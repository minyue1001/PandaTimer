// v0.9 UI 改版：src/ui/logic.ts 純函式（膠囊判定、行動提示、歷史分組/日小計、訂單卡、分頁）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionHint,
  BEAT_STALE_SEC,
  dayTitle,
  daySubText,
  daySummaryText,
  detectPill,
  estActText,
  groupHistory,
  overMinutes,
  rowStatusText,
  onTimeTone,
  orderAmount,
  orderCountdown,
  orderTags,
  overrunTone,
  parseTab,
  pctText,
  shouldJumpHome,
  sortActive,
  taipeiClock,
  taipeiDayLabel,
} from '../src/ui/logic.ts';
import { parseDetectorStatus } from '../src/detector.ts';
import { DEFAULT_GOALS, goalProgress, summarize } from '../src/stats.ts';
import { DEFAULT_PAY } from '../src/earnings.ts';

const tp = (s) => Date.parse(`${s}+08:00`); // 台北時間字串 → ms
const status = (o) => parseDetectorStatus(JSON.stringify(o));

test('detectPill：沒原生/沒 armed → ⚪ 未開始（開始偵測）；非預期停止 → 🔴 已停止（重新開始）', () => {
  const now = tp('2026-11-12T18:00:00');
  assert.equal(detectPill(null, now).kind, 'idle');
  assert.equal(detectPill(null, now).action, 'start');
  const idle = detectPill(status({ armed: false }), now);
  assert.deepEqual([idle.kind, idle.tone, idle.action, idle.canStop], ['idle', 'gray', 'start', false]);
  const stopped = detectPill(status({ armed: false, stoppedUnexpectedAt: now - 60_000 }), now);
  assert.deepEqual([stopped.kind, stopped.tone, stopped.action], ['stopped', 'red', 'restart']);
  assert.match(stopped.detail, /17:59/);
});

test('detectPill：armed＋心跳新鮮 → 🟢 偵測中（心跳秒數、保活方式；省電欄位有才顯示）', () => {
  const now = 1_000_000;
  const p = detectPill(status({ armed: true, keepAlive: '定位中', lastBeatAt: now - 12_000 }), now);
  assert.deepEqual([p.kind, p.tone, p.action, p.canStop], ['running', 'green', null, true]);
  assert.equal(p.detail, '心跳 12 秒前・定位中');
  const saver = detectPill(status({ armed: true, keepAlive: '定位中', lastBeatAt: now - 5_000, saver: true }), now);
  assert.equal(saver.detail, '心跳 5 秒前・定位中・省電中');
  const low = detectPill(status({ armed: true, keepAlive: '定位中', lastBeatAt: now - 5_000, lowPower: true }), now);
  assert.match(low.detail, /省電中/);
});

test('detectPill：邀請判定中 → 🟡 ✓ 可以按接受（180 秒後過期回 🟢）', () => {
  const now = 2_000_000;
  const base = { armed: true, keepAlive: '定位中', lastBeatAt: now - 3_000, offerPendingMinutes: 27 };
  const w = detectPill(status({ ...base, offerPendingAt: now - 8_000 }), now);
  assert.deepEqual([w.kind, w.tone], ['waiting', 'yellow']);
  assert.equal(w.title, '✓ 可以按接受');
  assert.equal(w.detail, '已偵測到邀請 27 分・8 秒前');
  assert.equal(detectPill(status({ ...base, offerPendingAt: now - 181_000 }), now).kind, 'running');
});

test('detectPill：心跳逾時 / 從沒心跳 → 🔴 沒有回應；剛按開始偵測 → 🟡 等待開始直播', () => {
  const now = 5_000_000;
  const stale = detectPill(status({ armed: true, lastBeatAt: now - (BEAT_STALE_SEC + 1) * 1000 }), now);
  assert.deepEqual([stale.kind, stale.tone, stale.action, stale.canStop], ['stopped', 'red', 'restart', true]);
  assert.match(stale.detail, /151 秒前/);
  assert.equal(detectPill(status({ armed: true, lastBeatAt: now - BEAT_STALE_SEC * 1000 }), now).kind, 'running');
  const never = detectPill(status({ armed: true }), now);
  assert.equal(never.kind, 'stopped');
  assert.match(never.detail, /還沒收到心跳/);
  // 剛按開始偵測（armedAt 之後還沒新心跳）→ 等待開始直播；之後收到心跳 → 偵測中
  const armedAt = now - 10_000;
  const starting = detectPill(status({ armed: true, lastBeatAt: now - 3_600_000 }), now, armedAt);
  assert.deepEqual([starting.kind, starting.tone, starting.action], ['starting', 'yellow', 'picker']);
  assert.equal(detectPill(status({ armed: true, lastBeatAt: now - 2_000 }), now, armedAt).kind, 'running');
  // 等太久（>120 秒）還沒心跳 → 紅燈
  assert.equal(detectPill(status({ armed: true }), now, now - 121_000).kind, 'stopped');
});

test('parseDetectorStatus：power 欄位只有原生帶了才存在（v0.9 原生沒帶 → 無 key）', () => {
  assert.equal('power' in status({ armed: true }), false);
  assert.deepEqual(status({ armed: true, lowPower: false, thermal: 2, memMB: 31.5 }).power, { lowPower: false, thermal: 2, memMB: 31.5 });
  assert.equal('power' in status({ armed: true, thermal: 'x' }), false);
});

// 晚到＝實際超過彈性線 21 分（再多 0.01 分），超時比例≈lateRatio
const sum = (onTime, late, lateRatio = 0.5) =>
  summarize([
    ...Array.from({ length: onTime }, () => ({ est: 20, act: 18 })),
    ...Array.from({ length: late }, () => ({ est: 20, act: 21 * (1 + lateRatio) + 0.01 })),
  ]);

test('actionHint：達標（還能晚 N 單）／黃（再準時 N 單＋還能晚 M 單守底線）／紅（連續準時 N 單）／零單', () => {
  const g = DEFAULT_GOALS; // 50 / 40 / 20
  assert.deepEqual(actionHint(goalProgress(summarize([]), g), g), { main: '本期還沒有單', tone: 'gray', overrun: null });
  // 6 準 4 晚 → 60%：6/(10+k) ≥ 0.5 → k ≤ 2
  const met = actionHint(goalProgress(sum(6, 4, 0), g), g);
  assert.equal(met.main, '還能晚 2 單仍達 50%');
  assert.equal(met.tone, 'green');
  // 剛好 50%
  assert.equal(actionHint(goalProgress(sum(5, 5, 0), g), g).main, '剛好 50%：下一單要準時');
  // 9 準 11 晚 → 45%：再準時 2 單 → 11/22＝50%；還能晚 (9/0.4 − 20)=2 單守 40%
  const mid = actionHint(goalProgress(sum(9, 11, 0), g), g);
  assert.equal(mid.main, '再準時 2 單達 50%・還能晚 2 單守 40%');
  assert.equal(mid.tone, 'yellow');
  // 3 準 7 晚 → 30%：(3+n)/(10+n) ≥ 0.4 → n ≥ 1.67 → 2
  const low = actionHint(goalProgress(sum(3, 7, 0), g), g);
  assert.equal(low.main, '要連續準時 2 單回到 40%');
  assert.equal(low.tone, 'red');
  // 底線 100% 且有晚到 → 回不去
  const strict = { onTimeRate: 1, onTimeFloor: 1, overrunRate: 0.2 };
  assert.equal(actionHint(goalProgress(sum(3, 1, 0), strict), strict).main, '低於底線 100%，本期回不去了');
});

test('actionHint：超時率未達標 → 第二行；顏色函式', () => {
  const g = DEFAULT_GOALS;
  // 1 準 1 晚（超時比例 0.5）→ 超時率 25% > 20%：sum 0.5 / 0.2 − 2 = 0.5 → 1 單
  const gp = goalProgress(sum(1, 1, 0.5), g);
  const h = actionHint(gp, g);
  assert.equal(h.overrun, '要連續 1 單不超時，超時率回到 20%');
  assert.equal(overrunTone(gp), 'red');
  assert.equal(onTimeTone(gp), 'green'); // 1/2＝50%＝達目標
  assert.equal(onTimeTone(goalProgress(sum(9, 11), g)), 'yellow');
  assert.equal(onTimeTone(goalProgress(sum(3, 7), g)), 'red');
  const ok = goalProgress(sum(5, 0), g);
  assert.equal(actionHint(ok, g).overrun, null);
  assert.equal(overrunTone(ok), 'green');
  assert.equal(onTimeTone(ok), 'green');
  assert.equal(overrunTone(goalProgress(summarize([]), g)), 'gray');
});

test('orderCountdown：剩餘 mm:ss、<3 分 urgent、超時 lateMin（無條件捨去）', () => {
  const now = 10_000_000;
  assert.deepEqual(orderCountdown({ deadline: now + 125_000 }, now), { leftMs: 125_000, late: false, lateMin: 0, urgent: true, timeText: '02:05' });
  assert.equal(orderCountdown({ deadline: now + 180_000 }, now).urgent, false);
  const late = orderCountdown({ deadline: now - 199_000 }, now);
  assert.deepEqual([late.late, late.lateMin, late.urgent, late.timeText], [true, 3, false, '03:19']);
});

test('orderAmount / orderTags / sortActive', () => {
  assert.deepEqual(orderAmount({ estimateMin: 21, amount: 85.76 }), { value: 85.76, estimated: false });
  const est = orderAmount({ estimateMin: 21 }, DEFAULT_PAY);
  assert.equal(est.estimated, false); // 平台確切算法，視為確切值
  assert.equal(est.value, 85.76);
  assert.equal(orderAmount({ estimateMin: 5 }).value, 45); // 最低車資
  assert.deepEqual(orderTags({ source: 'auto', stacked: true }), ['自動', '夾單']);
  assert.deepEqual(orderTags({ source: 'import' }), ['匯入']);
  assert.deepEqual(orderTags({}), []);
  const list = [
    { id: 'a', status: 'active', acceptedAt: 1, deadline: 500 },
    { id: 'b', status: 'active', acceptedAt: 2, deadline: 300 },
    { id: 'c', status: 'delivered', acceptedAt: 3, deadline: 100 },
    { id: 'd', status: 'active', acceptedAt: 0, deadline: 300 },
  ];
  assert.deepEqual(sortActive(list).map((o) => o.id), ['d', 'b', 'a']);
});

const delivered = (id, accepted, est, act, extra = {}) => ({
  id,
  acceptedAt: tp(accepted),
  estimateMin: est,
  deadline: tp(accepted) + est * 60_000,
  status: 'delivered',
  actualMin: act,
  deliveredAt: tp(accepted) + act * 60_000,
  ...extra,
});

test('groupHistory：依台北日分組（新→舊）、今天/昨天、日小計（準時率/超時率/預計發放/夾單）、台北時間', () => {
  const orders = [
    delivered('t1', '2026-11-12T10:00:00', 20, 18),
    delivered('t2', '2026-11-12T12:00:00', 20, 25, { stacked: true, source: 'auto' }),
    delivered('t3', '2026-11-12T00:10:00', 10, 9, { source: 'import', amount: 60 }),
    delivered('y1', '2026-11-11T23:50:00', 20, 20),
    delivered('old', '2026-11-09T09:00:00', 20, 30),
    { id: 'act', acceptedAt: tp('2026-11-12T13:00:00'), estimateMin: 20, deadline: 0, status: 'active' },
    { id: 'cx', acceptedAt: tp('2026-11-12T13:00:00'), estimateMin: 20, deadline: 0, status: 'canceled' },
  ];
  const r = groupHistory(orders, { now: tp('2026-11-12T20:00:00') });
  assert.equal(r.total, 5);
  assert.equal(r.shown, 5);
  assert.deepEqual(r.groups.map((g) => [g.key, g.relative]), [
    ['2026-11-12', '今天'],
    ['2026-11-11', '昨天'],
    ['2026-11-09', ''],
  ]);
  const today = r.groups[0];
  assert.equal(today.label, '11/12（四）');
  assert.deepEqual(today.rows.map((x) => x.order.id), ['t2', 't1', 't3']); // 依送達時間新→舊
  assert.equal(today.rows[2].time, '00:10');
  assert.deepEqual(today.rows[0].tags, ['自動', '夾單']);
  assert.equal(today.rows[0].onTime, false);
  assert.equal(today.rows[0].overMin, 5);
  assert.equal(today.rows[1].onTime, true);
  assert.deepEqual([today.rows[2].amount, today.rows[2].amountEstimated, today.rows[2].tags], [60, false, ['匯入']]);
  assert.equal(today.subtotal.count, 3);
  assert.equal(today.subtotal.stacked, 1);
  assert.ok(Math.abs(today.subtotal.onTimeRate - 2 / 3) < 1e-9);
  // 預計發放（保守）＝預估報酬合計：20 分 ×2＋10 分（最低 45）
  assert.ok(Math.abs(today.subtotal.payout - (2 * 81.67 + 45)) < 1e-6);
  assert.equal(r.groups[2].label, '11/9（一）');
});

test('groupHistory：limit 截斷列數，但日小計永遠是整天', () => {
  const orders = [
    delivered('a', '2026-11-12T10:00:00', 20, 18),
    delivered('b', '2026-11-12T11:00:00', 20, 18),
    delivered('c', '2026-11-12T12:00:00', 20, 30),
    delivered('d', '2026-11-11T12:00:00', 20, 18),
  ];
  const r = groupHistory(orders, { now: tp('2026-11-12T20:00:00'), limit: 2 });
  assert.equal(r.shown, 2);
  assert.equal(r.total, 4);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].rows.length, 2);
  assert.equal(r.groups[0].hidden, 1);
  assert.equal(r.groups[0].subtotal.count, 3);
  assert.deepEqual(groupHistory([], { now: 0 }), { groups: [], total: 0, shown: 0 });
});

test('taipeiClock / taipeiDayLabel / pctText 不依賴裝置時區', () => {
  assert.equal(taipeiClock(Date.UTC(2026, 10, 11, 16, 5)), '00:05');
  assert.equal(taipeiDayLabel(Date.UTC(2026, 10, 11, 16, 5)), '11/12（四）');
  assert.equal(pctText(0.625), '62.5%');
  assert.equal(pctText(null), '—');
  assert.equal(pctText(0.5), '50%');
});

test('parseTab / shouldJumpHome：邊緣觸發切回首頁', () => {
  assert.equal(parseTab('history'), 'history');
  assert.equal(parseTab('nope'), null);
  assert.equal(parseTab(null), null);
  const a = (kind, activeCount = 0) => ({ kind, activeCount });
  assert.equal(shouldJumpHome(a('running'), a('stopped')), true);
  assert.equal(shouldJumpHome(a('running'), a('waiting')), true);
  assert.equal(shouldJumpHome(a('stopped'), a('stopped')), false); // 停在同一狀態不會一直拉回
  assert.equal(shouldJumpHome(a('waiting'), a('running', 1)), true); // 新單
  assert.equal(shouldJumpHome(a('running', 2), a('running', 1)), false); // 送達
  assert.equal(shouldJumpHome(null, a('stopped')), true);
  assert.equal(shouldJumpHome(null, a('idle', 3)), false);
  assert.equal(shouldJumpHome(a('idle'), a('starting')), false);
});

test('v1.0 detectorStatus 省電/記憶體欄位：extension 模式/記憶體＋App 電量；膠囊與診斷文字', async () => {
  const { powerLine } = await import('../src/ui/logic.ts');
  const st = status({ armed: true, lowPower: false, thermal: 1, saver: false, batt: 63, charging: true, extMode: 'away', memMB: 31, peakMB: 44, extAt: 1234 });
  assert.deepEqual(st.power, { lowPower: false, thermal: 1, saver: false, memMB: 31, peakMB: 44, extMode: 'away', extAt: 1234, batt: 63, charging: true });
  assert.equal(powerLine(st.power), '正常・放慢辨識（非外送畫面）・溫度等級 1・電量 63%（充電中）・偵測記憶體 31/44MB');
  assert.equal(powerLine({ saver: true, peakMB: 40 }), '省電倍率中・偵測記憶體峰值 40MB');
  assert.equal('extMode' in status({ armed: true, thermal: 0, extMode: 'x' }).power, false);
  const now = 1_000_000;
  const p = detectPill(status({ armed: true, keepAlive: '定位中', lastBeatAt: now - 5_000, saver: true, extMode: 'away' }), now);
  assert.equal(p.detail, '心跳 5 秒前・定位中・省電中・放慢辨識');
});

test('v1.2 groupHistory：列帶 tip、日小計 tip 與 payout 含小費', () => {
  const orders = [
    delivered('a', '2026-11-12T10:00:00', 20, 18, { tip: 30 }),
    delivered('b', '2026-11-12T11:00:00', 20, 18),
  ];
  const g = groupHistory(orders, { now: tp('2026-11-12T20:00:00') }).groups[0];
  assert.equal(g.subtotal.tip, 30);
  assert.ok(Math.abs(g.subtotal.payout - (2 * 81.67 + 30)) < 1e-6);
  assert.deepEqual(g.rows.map((r) => [r.order.id, r.tip]).sort(), [['a', 30], ['b', 0]]);
});

test('v1.3 紀錄列純函式：超時分鐘、狀態文字、預估→實際、日標題', () => {
  assert.equal(overMinutes(22, 27), 5);
  assert.equal(overMinutes(3, 29), 26);
  assert.equal(overMinutes(20, 20.2), 1); // 向上取整、至少 1
  assert.equal(rowStatusText({ status: 'delivered', est: 22, act: 27, onTime: false }), '超 5 分');
  assert.equal(rowStatusText({ status: 'delivered', est: 18, act: 18, onTime: true }), '準時');
  assert.equal(rowStatusText({ status: 'active', est: 22 }), '進行中');
  assert.equal(rowStatusText({ status: 'canceled', est: 22 }), '已取消');
  assert.equal(estActText({ status: 'delivered', est: 22, act: 27 }), '22 分 → 27 分');
  assert.equal(estActText({ status: 'active', est: 22 }), '22 分 → 進行中');
  assert.equal(estActText({ status: 'canceled', est: 22 }), '已取消');
  assert.equal(dayTitle({ label: '11/13（四）', relative: '今天' }), '11/13（四）今天');
  assert.equal(dayTitle({ label: '11/9（一）', relative: '' }), '11/9（一）');
  assert.equal(daySummaryText({ count: 11, onTimeRate: 0.45, payout: 657.8 }), '11 單 · 準時 45% · $657.80');
  assert.equal(daySubText({ overrunRate: 0.1, tip: 15, stacked: 2 }), '超時率 10% · 小費 $15.00 · 夾單 2');
  assert.equal(daySubText({ overrunRate: null, tip: 0, stacked: 0 }), '超時率 —');
  const g = groupHistory([delivered('a', '2026-11-12T10:00:00', 20, 27, { tip: 15 })], { now: tp('2026-11-12T20:00:00') }).groups[0];
  assert.deepEqual([g.rows[0].statusText, g.rows[0].estActText], ['超 7 分', '20 分 → 27 分']);
});
