// 首頁膠囊下方：未確認邀請卡（偵測到邀請但沒記錄到接單；使用者其實可能有接）
import { Text, View } from 'react-native';
import { formatClock } from '../orders';
import type { OfferEntry, ScreenHint } from '../unconfirmedOffers';
import { Btn } from './common';
import { C, S } from './theme';

export function UnconfirmedCards({
  offers,
  onYes,
  onNo,
  hint,
  onHintAdd,
  onHintNo,
}: {
  offers: readonly OfferEntry[];
  onYes: (e: OfferEntry) => void;
  onNo: (e: OfferEntry) => void;
  /** v1.2 送單畫面顯示的訂單數比 App 進行中多（疊單第二張沒有邀請畫面） */
  hint?: ScreenHint | null;
  onHintAdd?: (h: ScreenHint) => void;
  onHintNo?: (h: ScreenHint) => void;
}) {
  if (!offers.length && !hint) return null;
  return (
    <>
      {hint && (
        <View style={[S.card, { borderWidth: 2, borderColor: C.pink }]}>
          <Text style={S.textBold}>
            {formatClock(hint.at)} 畫面顯示 {hint.n} 筆訂單，App 只有 {hint.active} 張。要補記一張嗎？
          </Text>
          <View style={S.row}>
            <Btn style={{ flex: 1 }} title="補記一張" onPress={() => onHintAdd?.(hint)} />
            <Btn style={{ flex: 1 }} kind="ghost" title="不用" onPress={() => onHintNo?.(hint)} />
          </View>
        </View>
      )}
      {offers.map((e) => (
        <View key={e.id} style={[S.card, { borderWidth: 2, borderColor: C.pink }]}>
          <Text style={S.textBold}>
            {formatClock(e.at)} 偵測到 {e.min} 分邀請，沒有記錄到接單。你有接嗎？
          </Text>
          <View style={S.row}>
            <Btn style={{ flex: 1 }} title="有接" onPress={() => onYes(e)} />
            <Btn style={{ flex: 1 }} kind="ghost" title="沒接" onPress={() => onNo(e)} />
          </View>
        </View>
      ))}
    </>
  );
}
