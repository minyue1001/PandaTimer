// 首頁膠囊下方：未確認邀請卡（偵測到邀請但沒記錄到接單；使用者其實可能有接）
import { Text, View } from 'react-native';
import { formatClock } from '../orders';
import type { OfferEntry } from '../unconfirmedOffers';
import { Btn } from './common';
import { C, S } from './theme';

export function UnconfirmedCards({
  offers,
  onYes,
  onNo,
}: {
  offers: readonly OfferEntry[];
  onYes: (e: OfferEntry) => void;
  onNo: (e: OfferEntry) => void;
}) {
  if (!offers.length) return null;
  return (
    <>
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
