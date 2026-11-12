// 首頁（騎車用）：偵測膠囊 → 進行中訂單卡（最早截止在上）→ 本期成績大卡 → 今日小卡 → 手動開始（折疊）
import { memo, type ReactNode, type RefObject } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import type { BroadcastPickerHandle } from '../../modules/live-activity';
import type { EarningsSummary, PayParams } from '../earnings';
import type { Order } from '../orders';
import type { GoalProgress, Goals, Period, Summary } from '../stats';
import { Btn, Collapsible } from './common';
import type { Pill } from './logic';
import { OrderCard } from './OrderCard';
import { PeriodCard, TodayCard } from './StatCard';
import { StatusPill } from './StatusPill';
import { C, F, pressed, S } from './theme';

export type HomeProps = {
  now: number;
  pill: Pill;
  detectMsg: string | null;
  pickerRef: RefObject<BroadcastPickerHandle | null>;
  onStartDetect: () => void;
  onStopDetect: () => void;
  onShowPicker: () => void;
  laSupported: boolean;
  active: Order[];
  pay: PayParams;
  onDone: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (o: Order) => void;
  stats: {
    period: Period;
    current: Summary & { baselineCount: number };
    own: Summary;
    today: Summary;
    noStacked: { period: Summary; stackedCount: number };
  };
  gp: GoalProgress;
  goals: Goals;
  todayEarn: EarningsSummary;
  estimateText: string;
  onEstimateChange: (t: string) => void;
  onBump: (d: number) => void;
  onManualStart: () => void;
  otaBanner: ReactNode;
};

export const HomeScreen = memo(function HomeScreen(p: HomeProps) {
  return (
    <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      {p.otaBanner}
      <StatusPill
        pill={p.pill}
        message={p.detectMsg}
        pickerRef={p.pickerRef}
        onStart={p.onStartDetect}
        onStop={p.onStopDetect}
        onShowPicker={p.onShowPicker}
      />
      {!p.laSupported && (
        <Text style={S.warn}>動態島不可用（需原生版本，且 設定 › 熊貓倒數 › 即時動態 要開啟）</Text>
      )}

      {p.active.length === 0 ? (
        <View style={[S.card, { alignItems: 'center' }]}>
          <Text style={[S.text, { color: C.dim }]}>沒有進行中的單</Text>
        </View>
      ) : (
        p.active.map((o, i) => (
          <OrderCard
            key={o.id}
            order={o}
            now={p.now}
            pay={p.pay}
            first={i === 0 && p.active.length > 1}
            onDone={p.onDone}
            onCancel={p.onCancel}
            onDelete={p.onDelete}
          />
        ))
      )}

      <PeriodCard
        period={p.stats.period}
        current={p.stats.current}
        ownCount={p.stats.own.count}
        noStacked={p.stats.noStacked}
        gp={p.gp}
        goals={p.goals}
      />
      <TodayCard today={p.stats.today} earn={p.todayEarn} />

      <Collapsible title="✋ 手動開始倒數">
        <Text style={S.label}>預估分鐘</Text>
        <View style={S.row}>
          <Pressable style={(st) => [stepStyle, pressed(st)]} onPress={() => p.onBump(-1)} accessibilityLabel="減一分">
            <Text style={stepText}>−</Text>
          </Pressable>
          <TextInput
            style={[S.input, { flex: 1, height: 72, fontSize: F.big, fontWeight: '800' }]}
            value={p.estimateText}
            onChangeText={p.onEstimateChange}
            keyboardType="number-pad"
            keyboardAppearance="dark"
            returnKeyType="done"
            selectTextOnFocus
            maxLength={3}
          />
          <Pressable style={(st) => [stepStyle, pressed(st)]} onPress={() => p.onBump(1)} accessibilityLabel="加一分">
            <Text style={stepText}>＋</Text>
          </Pressable>
        </View>
        <Btn title="開始倒數" onPress={p.onManualStart} style={{ height: 72 }} />
        <Text style={S.small}>捷徑：熊貓接單＝擷取螢幕畫面＋從截圖開始；熊貓送達＝送達（或按動態島上的「送達」）</Text>
      </Collapsible>
    </ScrollView>
  );
});

const stepStyle = {
  width: 72,
  height: 72,
  borderRadius: 18,
  backgroundColor: C.card2,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
const stepText = { fontSize: 36, fontWeight: '800', color: C.text } as const;
