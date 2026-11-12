// 首頁成績卡：本期大卡（準時率/超時率大字＋行動提示）、今日小卡
import { Text, View } from 'react-native';
import { money, type EarningsSummary } from '../earnings';
import type { GoalProgress, Goals, Period, Summary } from '../stats';
import { actionHint, onTimeTone, overrunTone, pctText } from './logic';
import { C, F, S, TONE } from './theme';

export function PeriodCard({
  period,
  current,
  ownCount,
  noStacked,
  gp,
  goals,
}: {
  period: Period;
  current: Summary & { baselineCount: number };
  ownCount: number;
  noStacked: { period: Summary; stackedCount: number };
  gp: GoalProgress;
  goals: Goals;
}) {
  const hint = actionHint(gp, goals);
  const otColor = TONE[onTimeTone(gp)].fg;
  const orColor = TONE[overrunTone(gp)].fg;
  return (
    <View style={S.card}>
      <View style={S.rowBetween}>
        <Text style={S.h2}>本期成績</Text>
        <Text style={S.label}>{period.label}</Text>
      </View>
      <View style={S.row}>
        <View style={{ flex: 1 }}>
          <Text style={S.label}>準時率</Text>
          <Text style={[S.bigNum, { color: otColor }]} adjustsFontSizeToFit numberOfLines={1}>
            {pctText(current.onTimeRate)}
          </Text>
          <Text style={S.small}>
            目標 {pctText(goals.onTimeRate)}・底線 {pctText(Math.min(goals.onTimeFloor, goals.onTimeRate))}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={S.label}>超時率</Text>
          <Text style={[S.bigNum, { color: orColor }]} adjustsFontSizeToFit numberOfLines={1}>
            {pctText(current.overrunRate)}
          </Text>
          <Text style={S.small}>上限 {pctText(goals.overrunRate)}</Text>
        </View>
      </View>
      <Text style={[S.textBold, { fontSize: F.label, color: TONE[hint.tone].fg }]}>{hint.main}</Text>
      {!!hint.overrun && <Text style={[S.textBold, { color: C.red }]}>{hint.overrun}</Text>}
      <Text style={S.text}>
        本期 {current.count} 單
        {current.baselineCount > 0 ? `（含補登 ${current.baselineCount}・App ${ownCount}）` : ''}
      </Text>
      {noStacked.stackedCount > 0 && (
        <Text style={S.small}>
          不含夾單 {noStacked.stackedCount} 單：準時 {pctText(noStacked.period.onTimeRate)}・超時 {pctText(noStacked.period.overrunRate)}（App 紀錄）
        </Text>
      )}
    </View>
  );
}

export function TodayCard({ today, earn }: { today: Summary; earn: EarningsSummary }) {
  return (
    <View style={[S.card, { flexDirection: 'row', gap: 8 }]}>
      <Cell label="今日單數" value={String(today.count)} />
      <Cell label="今日準時" value={pctText(today.onTimeRate)} />
      <Cell label="預計收入" value={money(earn.payout)} color={C.green} />
    </View>
  );
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[S.midNum, { fontSize: 40 }, color ? { color } : null]} adjustsFontSizeToFit numberOfLines={1}>
        {value}
      </Text>
      <Text style={S.small}>{label}</Text>
    </View>
  );
}
