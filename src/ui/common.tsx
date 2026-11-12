// 共用小元件：大按鈕、折疊區、標籤列
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { C, pressed, S } from './theme';

type BtnKind = 'pink' | 'green' | 'ghost' | 'danger';

export function Btn({
  title,
  onPress,
  kind = 'pink',
  small = false,
  disabled = false,
  style,
}: {
  title: string;
  onPress: () => void;
  kind?: BtnKind;
  small?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = kind === 'pink' ? S.btnPink : kind === 'green' ? S.btnGreen : kind === 'danger' ? S.btnDanger : S.btnGhost;
  const color = kind === 'green' ? C.onBright : kind === 'danger' ? C.red : kind === 'ghost' ? C.text : C.onPink;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={(st) => [small ? S.btnSmall : S.btn, bg, pressed(st), disabled && { opacity: 0.4 }, style]}
    >
      <Text style={[small ? S.btnTextSmall : S.btnText, { color }]}>{title}</Text>
    </Pressable>
  );
}

/** 標題列可點的折疊區；open/onToggle 不給就自己管 */
export function Collapsible({
  title,
  children,
  initiallyOpen = false,
  open: openProp,
  onToggle,
  style,
}: {
  title: string;
  children: ReactNode;
  initiallyOpen?: boolean;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const [own, setOwn] = useState(initiallyOpen);
  const open = openProp ?? own;
  const toggle = () => {
    setOwn(!open);
    onToggle?.(!open);
  };
  return (
    <View style={[S.card, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        style={(st) => [S.rowBetween, { minHeight: 48 }, pressed(st)]}
      >
        <Text style={[S.h2, { flex: 1 }]}>{title}</Text>
        <Text style={[S.label, { color: C.pink }]}>{open ? '收起 ▲' : '展開 ▼'}</Text>
      </Pressable>
      {open && children}
    </View>
  );
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags.length) return null;
  return (
    <View style={S.wrap}>
      {tags.map((t) => (
        <Text key={t} style={[S.tag, t === '夾單' ? { color: C.yellow } : null]}>
          {t}
        </Text>
      ))}
    </View>
  );
}

/** 標籤：值 的一行（設定頁診斷用） */
export function KV({ k, v, color }: { k: string; v: string; color?: string }) {
  return (
    <View style={[S.row, { alignItems: 'flex-start' }]}>
      <Text style={[S.small, { width: 92, color: C.dim }]}>{k}</Text>
      <Text style={[S.text, { flex: 1, fontSize: 16, lineHeight: 22 }, color ? { color } : null]}>{v}</Text>
    </View>
  );
}
