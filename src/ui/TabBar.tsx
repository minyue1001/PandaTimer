// 底部分頁列（自製，不用 react-navigation）：三顆大按鈕，選中為熊貓粉；首頁有進行中單數徽章
import { Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Tab } from './logic';
import { C, F } from './theme';

const ITEMS: { key: Tab; icon: string; label: string }[] = [
  { key: 'home', icon: '🛵', label: '首頁' },
  { key: 'history', icon: '📋', label: '紀錄' },
  { key: 'settings', icon: '⚙️', label: '設定' },
];

export function TabBar({ tab, onChange, homeBadge }: { tab: Tab; onChange: (t: Tab) => void; homeBadge: number }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        backgroundColor: C.tabBar,
        borderTopWidth: 1,
        borderTopColor: C.border,
        paddingBottom: Math.max(insets.bottom, 8),
        paddingTop: 6,
        paddingHorizontal: 8,
        gap: 8,
      }}
    >
      {ITEMS.map((it) => {
        const on = it.key === tab;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.label}
            onPress={() => onChange(it.key)}
            style={({ pressed }) => ({
              flex: 1,
              height: 64,
              borderRadius: 16,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: on ? C.pinkBg : 'transparent',
              opacity: pressed ? 0.65 : 1,
            })}
          >
            <Text style={{ fontSize: 24 }}>{it.icon}</Text>
            <Text style={{ fontSize: F.min, fontWeight: '800', color: on ? C.pink : C.dim }}>
              {it.label}
              {it.key === 'home' && homeBadge > 0 ? `（${homeBadge}）` : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
