// 進行中訂單卡：超大倒數、預估、金額、夾單標籤、大「送達」；卡片上半部長按＝刪除這筆、右上「取消」
import { Pressable, Text, View } from 'react-native';
import type { PayParams } from '../earnings';
import { money } from '../earnings';
import { formatClock, type Order } from '../orders';
import { Btn, Tags } from './common';
import { orderAmount, orderCountdown, orderTags } from './logic';
import { C, F, S } from './theme';

export function OrderCard({
  order,
  now,
  pay,
  first,
  onDone,
  onCancel,
  onDelete,
}: {
  order: Order;
  now: number;
  pay: PayParams;
  /** 最早截止的那張（多單時標「先送」） */
  first: boolean;
  onDone: (id: string) => void;
  onCancel: (id: string) => void;
  onDelete: (o: Order) => void;
}) {
  const cd = orderCountdown(order, now);
  const amt = orderAmount(order, pay);
  const color = cd.late ? C.red : cd.urgent ? C.orange : C.text;
  const tags = [...(first ? ['先送'] : []), ...orderTags(order)];
  return (
    <View style={[S.card, { borderWidth: 2, borderColor: cd.late ? C.red : cd.urgent ? C.orange : C.border }]}>
      <Pressable onLongPress={() => onDelete(order)} delayLongPress={600} accessibilityHint="長按刪除這筆紀錄">
        <View style={S.rowBetween}>
          <Text style={S.label}>
            接單 {formatClock(order.acceptedAt)}・截止 {formatClock(order.deadline)}
          </Text>
          <Pressable
            onPress={() => onCancel(order.id)}
            hitSlop={8}
            style={{ minHeight: 48, minWidth: 64, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Text style={[S.textBold, { color: C.dim, textDecorationLine: 'underline' }]}>取消</Text>
          </Pressable>
        </View>
        <Text style={[S.textBold, { fontSize: F.title, color }]}>{cd.late ? `已超時 ${cd.lateMin} 分` : '剩餘'}</Text>
        <Text style={[S.bigNum, { fontSize: 72, lineHeight: 80, color }]}>
          {cd.late ? '+' : ''}
          {cd.timeText}
        </Text>
        <View style={[S.rowBetween, { marginTop: 4 }]}>
          <Text style={[S.textBold, { fontSize: F.label }]}>預估 {order.estimateMin} 分</Text>
          <Text style={[S.textBold, { fontSize: F.label, color: C.green }]}>
            {amt.estimated ? '約 ' : ''}
            {money(amt.value)}
          </Text>
        </View>
        {tags.length > 0 && (
          <View style={{ marginTop: 8 }}>
            <Tags tags={tags} />
          </View>
        )}
      </Pressable>
      <Btn kind="green" title="送達" onPress={() => onDone(order.id)} style={{ height: 76 }} />
    </View>
  );
}
