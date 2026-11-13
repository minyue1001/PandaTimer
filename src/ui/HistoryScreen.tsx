// 紀錄頁：收入摘要 → 管理紀錄（批次刪除，折疊）→ 依日期分組的歷史（日小計）；列長按＝單筆刪除
import { memo, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { money, type EarningsSummary, type PayParams } from '../earnings';
import type { Order } from '../orders';
import { formatTaipeiDateTime, parseTaipeiDateTime } from '../prune';
import type { StatsParams, Summary } from '../stats';
import { confirmDeleteOne, confirmPrune, promptTip, runPrune, type Toast } from './actions';
import { Btn, Collapsible } from './common';
import { dayTitle, daySubText, daySummaryText, groupHistory, pctText, type DayGroup } from './logic';
import { C, F, pressed, S } from './theme';

const PAGE = 60;

export type HistoryProps = {
  orders: Order[];
  /** 分鐘級時間（今天/昨天標籤用；不必每秒重畫） */
  now: number;
  stats: StatsParams;
  pay: PayParams;
  earn: { period: EarningsSummary; today: EarningsSummary };
  periodLabel: string;
  noStacked: { period: Summary; today: Summary; stackedCount: number; stackedToday: number };
  toast: Toast;
};

export const HistoryScreen = memo(function HistoryScreen(p: HistoryProps) {
  const [limit, setLimit] = useState(PAGE);
  const hist = useMemo(
    () => groupHistory(p.orders, { now: p.now, limit, stats: p.stats, pay: p.pay }),
    [p.orders, p.now, limit, p.stats, p.pay],
  );
  return (
    <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={S.h1}>紀錄</Text>
      <IncomeCard earn={p.earn} periodLabel={p.periodLabel} noStacked={p.noStacked} />
      <ManageCard toast={p.toast} />
      {hist.groups.length === 0 && (
        <View style={[S.card, { alignItems: 'center' }]}>
          <Text style={[S.text, { color: C.dim }]}>還沒有紀錄</Text>
        </View>
      )}
      {hist.groups.map((g) => (
        <DayCard key={g.key} g={g} toast={p.toast} />
      ))}
      {hist.shown < hist.total && (
        <Btn kind="ghost" small title={`顯示更多（還有 ${hist.total - hist.shown} 筆）`} onPress={() => setLimit(limit + PAGE)} />
      )}
      <Text style={S.small}>點任一筆可編輯小費，長按可單筆刪除。金額「約」＝依預估分鐘估算的報酬。</Text>
    </ScrollView>
  );
});

function IncomeCard({
  earn,
  periodLabel,
  noStacked,
}: {
  earn: { period: EarningsSummary; today: EarningsSummary };
  periodLabel: string;
  noStacked: HistoryProps['noStacked'];
}) {
  return (
    <View style={S.card}>
      <View style={S.rowBetween}>
        <Text style={S.h2}>收入</Text>
        <Text style={S.label}>本期 {periodLabel}</Text>
      </View>
      <EarnBlock title="本期" e={earn.period} />
      <View style={S.divider} />
      <EarnBlock title="今日" e={earn.today} />
      {noStacked.stackedCount > 0 && (
        <>
          <View style={S.divider} />
          <Text style={S.small}>
            不含夾單（本期夾單 {noStacked.stackedCount} 單）：本期準時 {pctText(noStacked.period.onTimeRate)}・超時{' '}
            {pctText(noStacked.period.overrunRate)}；今日準時 {pctText(noStacked.today.onTimeRate)}・超時{' '}
            {pctText(noStacked.today.overrunRate)}（App 紀錄，不含補登）
          </Text>
        </>
      )}
    </View>
  );
}

function EarnBlock({ title, e }: { title: string; e: EarningsSummary }) {
  const cons = e.scenario === 'conservative';
  return (
    <View style={{ gap: 4 }}>
      <View style={S.rowBetween}>
        <Text style={[S.label, { flexShrink: 0, marginRight: 8 }]}>{title}預計發放</Text>
        <Text
          style={[S.midNum, { color: C.green, flex: 1, textAlign: 'right', fontSize: 26 }]}
          adjustsFontSizeToFit
          minimumFontScale={0.4}
          numberOfLines={1}
        >
          {money(e.payout)}
        </Text>
      </View>
      <Text style={S.small}>
        {cons ? '保守：晚到單全被打星' : '樂觀：都沒被打星'}；{cons ? '若未被打星' : '若晚到單全被打星'} {money(e.payoutOther)}
      </Text>
      <Text style={S.text}>
        預估收入 {money(e.estTotal)}（{e.count} 單{e.baselineIncome > 0 ? `，含補登 ${money(e.baselineIncome)}` : ''}）
      </Text>
      <Text style={S.text}>
        補錢 {money(e.adjustment)}（若未被打星；晚到 {e.lateCount} 單）
      </Text>
      <Text style={S.text}>
        小費 {money(e.tipTotal)}（{e.tipCount} 單有小費；已含在預計發放）
      </Text>
    </View>
  );
}

function ManageCard({ toast }: { toast: Toast }) {
  const [beforeText, setBeforeText] = useState('');
  const [allDraft, setAllDraft] = useState<string | null>(null);
  const onDeleteBefore = () => {
    const ts = parseTaipeiDateTime(beforeText);
    if (ts == null) {
      Alert.alert('時間格式不對', '請輸入台北時間 YYYY-MM-DD HH:mm，例如 2026-11-12 09:30');
      return;
    }
    void confirmPrune(`刪除 ${formatTaipeiDateTime(ts)} 以前的紀錄`, { kind: 'before', ts }, toast);
  };
  return (
    <Collapsible title="🗑 管理紀錄">
      <Text style={S.small}>批次刪除含進行中與已取消的單；補登不受影響。長按下面任一筆可單筆刪除。</Text>
      <Btn
        kind="ghost"
        small
        title="刪除今天的紀錄"
        onPress={() => void confirmPrune('刪除今天的紀錄', { kind: 'today', now: Date.now() }, toast)}
      />
      <View style={S.row}>
        <TextInput
          style={[S.input, { flex: 1, fontSize: F.body }]}
          value={beforeText}
          onChangeText={setBeforeText}
          placeholder="YYYY-MM-DD HH:mm"
          placeholderTextColor={C.dim}
          keyboardAppearance="dark"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Btn kind="ghost" small title="刪除以前的" onPress={onDeleteBefore} />
      </View>
      <Btn
        kind="danger"
        small
        title="刪除全部紀錄…"
        onPress={() => void confirmPrune('刪除全部紀錄', { kind: 'all' }, toast, () => setAllDraft(''))}
      />
      {allDraft != null && (
        <View style={{ gap: 10 }}>
          <TextInput
            style={[S.input, { fontSize: F.body }]}
            value={allDraft}
            onChangeText={setAllDraft}
            placeholder="輸入「刪除」兩字確認"
            placeholderTextColor={C.dim}
            keyboardAppearance="dark"
          />
          <View style={S.row}>
            <Btn
              style={{ flex: 1 }}
              kind="danger"
              small
              title="確定全刪"
              disabled={allDraft.trim() !== '刪除'}
              onPress={() => {
                setAllDraft(null);
                runPrune({ kind: 'all' }, toast);
              }}
            />
            <Btn style={{ flex: 1 }} kind="ghost" small title="取消" onPress={() => setAllDraft(null)} />
          </View>
        </View>
      )}
    </Collapsible>
  );
}

function DayCard({ g, toast }: { g: DayGroup; toast: Toast }) {
  const s = g.subtotal;
  return (
    <View style={[S.card, { gap: 0, paddingVertical: 12, paddingHorizontal: 14 }]}>
      <View style={S.rowBetween}>
        <Text style={{ fontSize: 17, fontWeight: '800', color: C.text }} numberOfLines={1}>
          {dayTitle(g)}
        </Text>
        <Text
          style={{ flex: 1, textAlign: 'right', fontSize: 16, fontWeight: '700', color: C.sub, fontVariant: ['tabular-nums'] }}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.7}
        >
          {daySummaryText(s)}
        </Text>
      </View>
      <Text style={[S.small, { paddingTop: 2, paddingBottom: 8 }]} numberOfLines={1}>
        {daySubText(s)}
      </Text>
      {g.rows.map((r) => (
        <Pressable
          key={r.order.id}
          onPress={() => promptTip(r.order, toast)}
          onLongPress={() => confirmDeleteOne(r.order, toast)}
          delayLongPress={500}
          accessibilityHint="點一下編輯小費，長按刪除"
          style={(st) => [rowStyle, pressed(st)]}
        >
          <Text style={timeStyle}>{r.time}</Text>
          <View style={[barStyle, { backgroundColor: r.onTime ? C.green : C.red }]} />
          <View style={{ flex: 1, gap: 3 }}>
            <View style={S.row}>
              <Text style={estStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                {r.estActText}
              </Text>
              <Text style={[statusStyle, { color: r.onTime ? C.green : C.red }]} numberOfLines={1}>
                {r.statusText}
              </Text>
              <Text style={amountStyle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                {r.amountEstimated ? '約' : ''}
                {money(r.amount)}
              </Text>
            </View>
            <View style={S.row}>
              <Text style={[S.small, { flex: 1 }]} numberOfLines={1}>
                {r.tags.join(' · ')}
              </Text>
              {r.tip > 0 && (
                <Text style={[S.small, { color: C.green, fontVariant: ['tabular-nums'] }]} numberOfLines={1}>
                  +{money(r.tip)} 小費
                </Text>
              )}
            </View>
          </View>
        </Pressable>
      ))}
      {g.hidden > 0 && <Text style={[S.small, { paddingTop: 6 }]}>這天還有 {g.hidden} 筆，按下面「顯示更多」</Text>}
    </View>
  );
}

const rowStyle = {
  flexDirection: 'row',
  alignItems: 'stretch',
  gap: 10,
  minHeight: 64,
  paddingVertical: 11,
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopColor: C.border,
} as const;
const timeStyle = { width: 52, fontSize: 16, fontWeight: '700', color: C.sub, fontVariant: ['tabular-nums'] } as const;
const barStyle = { width: 4, borderRadius: 2 } as const;
const estStyle = { width: 118, fontSize: 18, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] } as const;
const statusStyle = { width: 70, fontSize: 16, fontWeight: '800' } as const;
const amountStyle = { flex: 1, textAlign: 'right', fontSize: 18, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] } as const;
