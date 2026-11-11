// v0.8：收入（含補錢）統計——foodpanda 報酬規則（三期 1,109 單驗證，583/583 吻合）。純函式，node --test 直接載入。
//   預估報酬 ＝ max(minFare, 預估分鐘 × ratePerMinute)；實際報酬 ＝ max(minFare, 實際分鐘 × ratePerMinute)（實際分鐘四捨五入到整數）
//   補錢（金額調整）＝ max(0, 實際報酬 − 預估報酬)；最終發放 ＝ max(預估, 實際)
//   被打星的單不補：發放 ＝ 預估報酬。App 無法得知哪張會被打星 → 兩種情境：
//     樂觀＝都沒被打星（預估＋全部補錢）；保守＝晚到單全被打星（補錢 0，只領預估）。
//   assumeStarredLate（預設 true）決定「預計發放」採哪一個，另一個當對照顯示。
//   參數可由遠端設定 /api/config 的 pay 區塊覆寫（src/remoteConfig.ts 驗證）。
import type { Order } from './orders';
import { periodOf, taipeiDayStart, type Baseline } from './stats.ts';

export type PayParams = { ratePerMinute: number; minFare: number; assumeStarredLate: boolean };
export const DEFAULT_PAY: Readonly<PayParams> = Object.freeze({ ratePerMinute: 4.08355, minFare: 45, assumeStarredLate: true });

const DAY_MS = 86_400_000;

/** 分鐘 → 報酬（含最低車資） */
export function fareFor(minutes: number, p: PayParams = DEFAULT_PAY): number {
  return Math.max(p.minFare, minutes * p.ratePerMinute);
}

export type PaySample = {
  est: number;
  act: number;
  /** 邀請畫面 OCR 抓到的金額（有就當預估報酬；目前 Order 沒存這欄，保留給之後） */
  estAmount?: number | null;
};

export type OrderPay = { estPay: number; actPay: number; adjustment: number; late: boolean };

export function orderPay(s: PaySample, p: PayParams = DEFAULT_PAY): OrderPay {
  const act = Math.round(s.act);
  const estPay = s.estAmount != null && Number.isFinite(s.estAmount) && s.estAmount > 0 ? s.estAmount : fareFor(s.est, p);
  const actPay = fareFor(act, p);
  return { estPay, actPay, adjustment: Math.max(0, actPay - estPay), late: act > s.est };
}

export type EarningsSummary = {
  count: number;
  /** 晚到單數（實際分鐘 > 預估分鐘；被打星的候選） */
  lateCount: number;
  /** 預估報酬合計（＋補登收入） */
  estTotal: number;
  /** 補錢合計（假設都沒被打星） */
  adjustment: number;
  /** 樂觀總額＝預估＋補錢 */
  optimisticTotal: number;
  /** 保守總額＝晚到單全被打星（補錢 0）＝預估 */
  conservativeTotal: number;
  /** 預計發放（依 assumeStarredLate 取保守或樂觀） */
  payout: number;
  /** 另一個情境的數字（對照） */
  payoutOther: number;
  /** payout 採哪個情境 */
  scenario: 'conservative' | 'optimistic';
  /** 補登的前幾天收入（已含在 estTotal） */
  baselineIncome: number;
};

export function summarizeEarnings(
  samples: readonly PaySample[],
  p: PayParams = DEFAULT_PAY,
  baselineIncome = 0,
): EarningsSummary {
  let estTotal = 0;
  let adjustment = 0;
  let lateCount = 0;
  for (const s of samples) {
    const o = orderPay(s, p);
    estTotal += o.estPay;
    adjustment += o.adjustment;
    if (o.late) lateCount += 1;
  }
  const extra = Number.isFinite(baselineIncome) && baselineIncome > 0 ? baselineIncome : 0;
  estTotal += extra;
  const optimisticTotal = estTotal + adjustment;
  const conservativeTotal = estTotal;
  const conservative = p.assumeStarredLate;
  return {
    count: samples.length,
    lateCount,
    estTotal,
    adjustment,
    optimisticTotal,
    conservativeTotal,
    payout: conservative ? conservativeTotal : optimisticTotal,
    payoutOther: conservative ? optimisticTotal : conservativeTotal,
    scenario: conservative ? 'conservative' : 'optimistic',
    baselineIncome: extra,
  };
}

/** 已送達、有實際分鐘、接單時間在 [since, until) 的單 */
export function paySamplesBetween(orders: readonly Order[], since: number, until: number): PaySample[] {
  return orders
    .filter((o) => o.status === 'delivered' && o.actualMin != null && o.acceptedAt >= since && o.acceptedAt < until)
    .map((o) => ({ est: o.estimateMin, act: o.actualMin as number }));
}

/** 本期（含同期補登收入）與今日（台北日，不含補登）的收入 */
export function periodAndTodayEarnings(
  orders: readonly Order[],
  now: number,
  p: PayParams = DEFAULT_PAY,
  baseline: Baseline | null = null,
) {
  const period = periodOf(now);
  const day = taipeiDayStart(now);
  const b = baseline && baseline.periodId === period.id ? baseline : null;
  return {
    period: summarizeEarnings(paySamplesBetween(orders, period.start, period.end), p, b?.income ?? 0),
    today: summarizeEarnings(paySamplesBetween(orders, day, day + DAY_MS), p),
  };
}

/** 金額顯示：整數元，千分位 */
export function money(x: number): string {
  return `$${Math.round(x).toLocaleString('en-US')}`;
}
