// 首頁最上方：偵測狀態膠囊（判定在 logic.detectPill）。BroadcastPicker 永遠掛在這裡（ref.show() 叫出系統廣播視窗要它在畫面上）。
import type { RefObject } from 'react';
import { Text, View } from 'react-native';
import { BroadcastPicker, type BroadcastPickerHandle } from '../../modules/live-activity';
import { Btn } from './common';
import type { Pill } from './logic';
import { C, S, TONE } from './theme';

const ICON: Record<Pill['tone'], string> = { green: '🟢', yellow: '🟡', red: '🔴', gray: '⚪' };

export function StatusPill({
  pill,
  message,
  pickerRef,
  onStart,
  onStop,
  onShowPicker,
}: {
  pill: Pill;
  message: string | null;
  pickerRef: RefObject<BroadcastPickerHandle | null>;
  onStart: () => void;
  onStop: () => void;
  onShowPicker: () => void;
}) {
  const tone = TONE[pill.tone];
  return (
    <View style={[S.card, { backgroundColor: tone.bg, borderWidth: 2, borderColor: tone.fg }]}>
      <Text style={[S.h1, { color: tone.fg }]} accessibilityRole="header">
        {ICON[pill.tone]} {pill.title}
      </Text>
      <Text style={[S.text, { color: C.text }]}>{pill.detail}</Text>
      <View style={S.row}>
        {pill.action === 'start' || pill.action === 'restart' ? (
          <Btn style={{ flex: 1 }} title={pill.action === 'start' ? '開始偵測' : '重新開始偵測'} onPress={onStart} />
        ) : pill.action === 'picker' ? (
          <Btn style={{ flex: 1 }} title="叫出直播視窗" onPress={onShowPicker} />
        ) : (
          <Btn style={{ flex: 1 }} small kind="ghost" title="停止偵測" onPress={onStop} />
        )}
        {/* 系統的螢幕廣播按鈕本體：程式點不到時使用者直接點這顆 */}
        <BroadcastPicker
          ref={pickerRef}
          style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.card2, borderWidth: 1, borderColor: C.border }}
        />
      </View>
      {pill.canStop && pill.action != null && (
        <Btn small kind="ghost" title="停止偵測" onPress={onStop} />
      )}
      {!!message && <Text style={S.small}>{message}</Text>}
    </View>
  );
}
