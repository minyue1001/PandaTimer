// v0.8 收入（含補錢）：公式、最低 45、補錢、兩種情境、補登收入；並用使用者三期報酬單（scratchpad，不進 repo）對帳。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_PAY, fareFor, orderPay, summarizeEarnings, periodAndTodayEarnings, money } from '../src/earnings.ts';
import { parseBaseline, periodOf } from '../src/stats.ts';
import { validateConfig, DEFAULT_CONFIG } from '../src/remoteConfig.ts';

// 平台確切算法：245/60 每分鐘，加 1 分錢後捨去到分，最低 45（以整數運算獨立計算期望值）
const fare = (m) => Math.max(45, Math.floor((m * 245 * 100 + 60) / 60 + 1e-6) / 100);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('公式：max(45, 分鐘 × 245/60 加 1 分捨去到分)；最低 45', () => {
  near(fareFor(20), fare(20));
  // 與使用者報酬單逐分吻合的確切值
  assert.equal(fareFor(12), 49.01);
  assert.equal(fareFor(13), 53.09);
  assert.equal(fareFor(20), 81.67);
  assert.equal(fareFor(21), 85.76);
  assert.equal(fareFor(5), 45);
  assert.equal(fareFor(11), 45); // 11 × 245/60 = 44.92
  near(fareFor(12), fare(12)); // 49.01
});

test('單筆：準時不補、晚到補差額、實際分鐘四捨五入、補錢不為負', () => {
  const ontime = orderPay({ est: 20, act: 15 });
  assert.equal(ontime.adjustment, 0);
  assert.equal(ontime.late, false);
  near(ontime.estPay, fare(20));
  const late = orderPay({ est: 12, act: 31 });
  near(late.actPay, fare(31));
  near(late.adjustment, fare(31) - fare(12));
  assert.equal(late.late, true);
  // 最低 45：預估 10（45）、實際 11（45）→ 沒補，但仍算晚到
  const floor = orderPay({ est: 10, act: 11 });
  assert.equal(floor.adjustment, 0);
  assert.equal(floor.late, true);
  // 實際 20.4 → 20、20.6 → 21
  near(orderPay({ est: 15, act: 20.4 }).actPay, fare(20));
  near(orderPay({ est: 15, act: 20.6 }).actPay, fare(21));
  // 有 OCR 金額 → 當預估報酬
  const amt = orderPay({ est: 20, act: 30, estAmount: 80 });
  assert.equal(amt.estPay, 80);
  near(amt.adjustment, fare(30) - 80);
});

test('期別彙總：兩種情境、晚到單數、assumeStarredLate 切換', () => {
  const samples = [{ est: 20, act: 15 }, { est: 12, act: 31 }, { est: 30, act: 40 }];
  const cons = summarizeEarnings(samples, DEFAULT_PAY);
  const estTotal = fare(20) + fare(12) + fare(30);
  const adj = fare(31) - fare(12) + (fare(40) - fare(30));
  assert.equal(cons.count, 3);
  assert.equal(cons.lateCount, 2);
  near(cons.estTotal, estTotal);
  near(cons.adjustment, adj);
  near(cons.conservativeTotal, estTotal);
  near(cons.optimisticTotal, estTotal + adj);
  assert.equal(cons.scenario, 'conservative');
  near(cons.payout, estTotal);
  near(cons.payoutOther, estTotal + adj);
  const opt = summarizeEarnings(samples, { ...DEFAULT_PAY, assumeStarredLate: false });
  assert.equal(opt.scenario, 'optimistic');
  near(opt.payout, estTotal + adj);
  near(opt.payoutOther, estTotal);
  // 空
  const empty = summarizeEarnings([]);
  assert.equal(empty.payout, 0);
  assert.equal(empty.count, 0);
});

test('補登收入併入本期（兩種情境都加），今日不含；換期失效', () => {
  const now = Date.UTC(2026, 10, 12, 4, 0, 0); // 11/12 12:00 台北，本期 2026-11-09
  const per = periodOf(now);
  assert.equal(per.id, '2026-11-09');
  const mk = (id, est, act, at) => ({ id, acceptedAt: at, estimateMin: est, deadline: at + est * 60_000, status: 'delivered', actualMin: act, deliveredAt: at + act * 60_000 });
  const orders = [mk('a', 12, 31, now - 3_600_000), mk('b', 20, 15, now - 7_200_000)];
  const base = { periodId: '2026-11-09', count: 10, onTimeRate: 0.5, overrunRate: 0.1, income: 1000 };
  const e = periodAndTodayEarnings(orders, now, DEFAULT_PAY, base);
  near(e.period.estTotal, 1000 + fare(12) + fare(20));
  near(e.period.optimisticTotal, 1000 + fare(12) + fare(20) + (fare(31) - fare(12)));
  near(e.period.payout, 1000 + fare(12) + fare(20));
  assert.equal(e.period.baselineIncome, 1000);
  assert.equal(e.today.baselineIncome, 0);
  near(e.today.estTotal, fare(12) + fare(20));
  // 別期的補登不算
  const other = periodAndTodayEarnings(orders, now, DEFAULT_PAY, { ...base, periodId: '2026-10-26' });
  assert.equal(other.period.baselineIncome, 0);
  // 取消／進行中不計
  const act = [{ ...mk('c', 20, 25, now - 1000), status: 'canceled' }, { ...mk('d', 20, 25, now - 1000), status: 'active', actualMin: undefined }];
  assert.equal(periodAndTodayEarnings(act, now).period.count, 0);
});

test('parseBaseline 的 income 欄位：合法保留、不合法丟掉但補登仍有效', () => {
  const b = { periodId: '2026-11-09', count: 3, onTimeRate: 0.5, overrunRate: 0.1 };
  assert.equal(parseBaseline({ ...b, income: 1234.5 }).income, 1234.5);
  assert.equal(parseBaseline(b).income, undefined);
  assert.equal(parseBaseline({ ...b, income: -5 }).income, undefined);
  assert.equal(parseBaseline({ ...b, income: 'x' }).income, undefined);
});

test('遠端設定 pay 區塊：預設、覆寫、不合法回預設', () => {
  assert.deepEqual(DEFAULT_CONFIG.pay, { ratePerMinute: 245 / 60, minFare: 45, assumeStarredLate: true });
  const ok = validateConfig({ version: 'p1', pay: { ratePerMinute: 4.2, minFare: 50, assumeStarredLate: false } });
  assert.deepEqual(ok.config.pay, { ratePerMinute: 4.2, minFare: 50, assumeStarredLate: false });
  const bad = validateConfig({ version: 'p2', pay: { ratePerMinute: 0, minFare: -1, assumeStarredLate: 'no' } });
  assert.deepEqual(bad.config.pay, DEFAULT_CONFIG.pay);
  for (const k of ['ratePerMinute', 'minFare', 'assumeStarredLate']) assert.ok(bad.problems.some((p) => p.startsWith(`pay.${k}`)), k);
  assert.ok(validateConfig({ version: 'p3' }).problems.some((p) => p.startsWith('pay.ratePerMinute 缺漏')));
});

test('server 的 config.json／config.default.json 都有 pay 區塊且＝預設', () => {
  for (const f of ['../server/config.json', '../server/config.default.json']) {
    const j = JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
    assert.deepEqual(j.pay, DEFAULT_CONFIG.pay, f);
  }
});

// ── 對帳：使用者三期報酬單（1,109 單）。檔案不在就 skip；不進 repo。 ──
const ORDERS_JSON = '/tmp/claude-1000/-home-minyue-IOS/b3dd0835-74b1-456e-9c83-896250f87a7e/scratchpad/fp/orders.json';
test('三期報酬單對帳：單件費用＋金額調整 合計 vs fin 合計，誤差 < 1 元', { skip: !fs.existsSync(ORDERS_JSON) && '無 orders.json' }, () => {
  const rows = JSON.parse(fs.readFileSync(ORDERS_JSON, 'utf8'));
  const periods = [...new Set(rows.map((r) => r.p))].sort();
  assert.equal(periods.length, 3);
  let total = 0;
  for (const p of periods) {
    const rs = rows.filter((r) => r.p === p);
    let fin = 0;
    let calc = 0;
    for (const r of rs) {
      fin += r.fin;
      const o = orderPay({ est: r.est, act: r.act });
      calc += o.estPay + (r.star ? 0 : o.adjustment); // 被打星的單不補
    }
    console.log(`  期別 ${p}：${rs.length} 單，fin=${fin.toFixed(2)}，公式=${calc.toFixed(2)}，差=${(calc - fin).toFixed(2)}`);
    assert.ok(Math.abs(calc - fin) < 1, `${p} 誤差 ${calc - fin}`);
    total += rs.length;
  }
  assert.equal(total, rows.length);
});

test('money 格式', () => {
  assert.equal(money(1234.4), '$1,234.40');
  assert.equal(money(0), '$0.00');
  assert.equal(money(49.01), '$49.01');
  assert.equal(money(1234567.5), '$1,234,567.50');
});
