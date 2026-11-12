// v0.9 UI 改版：暗色主題（貼近 pandarider 暗色，夜騎不刺眼）。所有顏色/字級/按鈕高度集中在這裡。
// 規則：最小字級 16；主要數字 40~64；按鈕高 ≥56；可點區 ≥48。
import { StyleSheet } from 'react-native';
import type { Tone } from './logic';

export const C = {
  bg: '#121212',
  card: '#1E1E1E',
  card2: '#2A2A2A',
  tabBar: '#181818',
  border: '#3A3A3A',
  text: '#FFFFFF',
  sub: '#C7C7CC',
  dim: '#A0A0A6',
  pink: '#FF2B85',
  pinkBg: '#3A1428',
  // iOS 暗色系統色：在 #1E1E1E 上對比 ≥ 4.5（紅 #FF453A 約 4.9、綠 #30D158 約 8.6、黃 #FFD60A 約 12）
  green: '#30D158',
  yellow: '#FFD60A',
  red: '#FF453A',
  orange: '#FF9F0A',
  gray: '#A0A0A6',
  greenBg: '#0E2A18',
  yellowBg: '#2E2600',
  redBg: '#3A1311',
  grayBg: '#262626',
  /** 亮色按鈕（綠/黃）上的字 */
  onBright: '#0A0A0A',
  onPink: '#FFFFFF',
} as const;

export const TONE: Record<Tone, { fg: string; bg: string }> = {
  green: { fg: C.green, bg: C.greenBg },
  yellow: { fg: C.yellow, bg: C.yellowBg },
  red: { fg: C.red, bg: C.redBg },
  gray: { fg: C.gray, bg: C.grayBg },
};

export const F = { min: 16, body: 18, label: 20, title: 24, big: 44, huge: 56, giant: 64 } as const;
export const H = { btn: 64, btnSmall: 56, touch: 48 } as const;

export const S = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  screen: { flex: 1, backgroundColor: C.bg },
  scroll: { padding: 16, paddingBottom: 40, gap: 14 },
  card: { backgroundColor: C.card, borderRadius: 20, padding: 18, gap: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  h1: { fontSize: 28, fontWeight: '800', color: C.text },
  h2: { fontSize: F.title, fontWeight: '800', color: C.text },
  label: { fontSize: F.label, fontWeight: '700', color: C.sub },
  text: { fontSize: F.body, color: C.text },
  textBold: { fontSize: F.body, color: C.text, fontWeight: '700' },
  small: { fontSize: F.min, color: C.dim, lineHeight: 22 },
  warn: { fontSize: F.min, color: C.orange, lineHeight: 22 },
  bigNum: { fontSize: F.giant, fontWeight: '800', color: C.text, fontVariant: ['tabular-nums'] },
  midNum: { fontSize: F.big, fontWeight: '800', color: C.text, fontVariant: ['tabular-nums'] },
  btn: { height: H.btn, borderRadius: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnSmall: { height: H.btnSmall, borderRadius: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  btnText: { fontSize: F.title, fontWeight: '800', color: C.onPink },
  btnTextSmall: { fontSize: F.label, fontWeight: '800', color: C.text },
  btnPink: { backgroundColor: C.pink },
  btnGreen: { backgroundColor: C.green },
  btnGhost: { backgroundColor: C.card2, borderWidth: 1, borderColor: C.border },
  btnDanger: { backgroundColor: C.redBg, borderWidth: 1, borderColor: C.red },
  linkBtn: { minHeight: H.touch, justifyContent: 'center', paddingHorizontal: 8 },
  linkText: { fontSize: F.body, fontWeight: '700', color: C.pink },
  input: {
    minHeight: H.btnSmall,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: C.border,
    backgroundColor: C.card2,
    color: C.text,
    fontSize: F.label,
    paddingHorizontal: 12,
    textAlign: 'center',
  },
  tag: { fontSize: F.min, fontWeight: '700', color: C.sub, backgroundColor: C.card2, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: C.border },
});

/** Pressable 按下時淡一點 */
export const pressed = ({ pressed: p }: { pressed: boolean }) => ({ opacity: p ? 0.65 : 1 });
