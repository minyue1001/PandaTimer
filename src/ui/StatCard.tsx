// 首頁成績卡：本期大卡（件數進度＋星號風險為主，準時/超時一行次要）、今日小卡
import { Text, View } from 'react-native';
import { money, type EarningsSummary } from '../earnings';
import { countProgress, type GoalProgress, type Goals, type Period, type Summary } from '../stats';
import { countHint, countPaceText, onTimeTone, overrunTone, pctText } from './logic';
import { C, F, S, TONE } from './theme';

export function PeriodCard({
  period,
  current,
  ownCount,
  noStacked,
  gp,
  goals,
  now,
  todayCount,
  periodStar,
  todayStar,
  participationLine,
}: {
  period: Period;
  current: Summary & { baselineCount: number };
  ownCount: number;
  noStacked: { period: Summary; stackedCount: number };
  gp: GoalProgress;
  goals: Goals;
  now: number;
  todayCount: number;
  periodStar: number;
  todayStar: number;
  /** v1.4「參與率約 X%（接 A／派 A+D）」；沒抓到拒單 → 不顯示 */
  participationLine?: string | null;
}) {
  const prog = countProgress(current.count, goals.periodOrders, now, todayCount);
  const hint = countHint(prog, todayStar, gp, goals);
  const otColor = TONE[onTimeTone(gp)].fg;
  const orColor = TONE[overrunTone(gp)].fg;
  return (
    <View style={S.card}>
      <View style={S.rowBetween}>
        <Text style={S.h2}>本期件數</Text>
        <Text style={S.label}>{period.label}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <Text style={[S.bigNum, { color: prog.done ? C.green : C.text, flexShrink: 1 }]} adjustsFontSizeToFit minimumFontScale={0.5} numberOfLines={1}>
          {current.count}
        </Text>
        <Text style={[S.textBold, { fontSize: F.label, color: C.sub, flex: 1 }]} adjustsFontSizeToFit minimumFontScale={0.6} numberOfLines={1}>
          / 目標 {prog.target} 單
        </Text>
      </View>
      <Text style={[S.textBold, { color: prog.done ? C.green : C.text }]} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}>
        {countPaceText(prog)}
      </Text>
      <Text style={[S.textBold, { fontSize: F.label, color: periodStar > 0 ? C.yellow : C.sub }]} adjustsFontSizeToFit minimumFontScale={0.7} numberOfLines={1}>
        ⭐ 本期預估星號 {periodStar} 張（單接又超過預估）・今日 {todayStar} 張
      </Text>
      <Text style={[S.textBold, { fontSize: F.label, color: TONE[hint.tone].fg }]}>{hint.main}</Text>
      {!!hint.star && <Text style={[S.textBold, { color: C.yellow }]}>{hint.star}</Text>}
      {!!hint.overrun && <Text style={[S.textBold, { color: C.red }]}>{hint.overrun}</Text>}
      <Text style={S.small} adjustsFontSizeToFit minimumFontScale={0.8} numberOfLines={1}>
        <Text style={{ color: otColor }}>準時 {pctText(current.onTimeRate)}（底線 {pctText(Math.min(goals.onTimeFloor, goals.onTimeRate))}）</Text>
        {'　'}
        <Text style={{ color: orColor }}>超時 {pctText(current.overrunRate)}（上限 {pctText(goals.overrunRate)}）</Text>
      </Text>
      {!!participationLine && (
        <Text style={[S.small, { color: C.sub }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
          {participationLine}
        </Text>
      )}
      <Text style={S.small}>
        {current.baselineCount > 0 ? `含補登 ${current.baselineCount}・App ${ownCount}・` : ''}不含不計時效單
        {noStacked.stackedCount > 0 ? `・夾單 ${noStacked.stackedCount} 單（不含夾單準時 ${pctText(noStacked.period.onTimeRate)}）` : ''}
      </Text>
    </View>
  );
}

export function TodayCard({ today, earn, todayStar }: { today: Summary; earn: EarningsSummary; todayStar: number }) {
  return (
    <View style={[S.card, { flexDirection: 'row', gap: 8 }]}>
      <Cell label="今日單數" value={String(today.count)} />
      <Cell label="今日星號風險" value={`⭐${todayStar}`} color={todayStar > 0 ? C.yellow : undefined} />
      <Cell label={earn.tipTotal > 0 ? `預計收入（含小費 ${money(earn.tipTotal)}）` : '預計收入'} value={money(earn.payout)} color={C.green} />
    </View>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text
        style={[S.midNum, { fontSize: 30, alignSelf: 'stretch', textAlign: 'center' }, color ? { color } : null]}
        adjustsFontSizeToFit
        minimumFontScale={0.4}
        numberOfLines={1}
      >
        {value}
      </Text>
      <Text style={S.small}>{label}</Text>
    </View>
  );
}
