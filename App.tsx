import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as LiveActivity from './modules/live-activity';
import { BroadcastPicker, type BroadcastPickerHandle } from './modules/live-activity';
import {
  cancelOrder,
  completeOrder,
  initNativeBridge,
  listenDeepLinks,
  startOrder,
} from './src/controller';
import { beatAgeSec, countAutoToday } from './src/detector';
import { ensurePermission } from './src/notify';
import { OtaBox } from './src/OtaBox';
import {
  activeOrders,
  clampEstimate,
  DEFAULT_ESTIMATE,
  formatClock,
  formatDuration,
  history,
  isLate,
  SHORT_ORDER_MAX_MIN,
  todayStats,
  type Order,
} from './src/orders';
import { subscribe } from './src/store';

const PINK = '#D70F64';
const RED = '#E53935';
const GREEN = '#2E7D32';

function pct(x: number | null): string {
  return x == null ? '—' : `${Math.round(x * 1000) / 10}%`;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Main />
    </SafeAreaProvider>
  );
}

function Main() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [now, setNow] = useState(Date.now());
  const [estimateText, setEstimateText] = useState(String(DEFAULT_ESTIMATE));
  const [toast, setToast] = useState<string | null>(null);
  const estimateRef = useRef(DEFAULT_ESTIMATE);
  const pickerRef = useRef<BroadcastPickerHandle>(null);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => subscribe(setOrders), []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    void ensurePermission();
    // 先 drain 原生事件再 reconcile（initNativeBridge 內保證順序）
    const stopBridge = initNativeBridge(showToast);
    const stopLinks = listenDeepLinks(() => estimateRef.current, showToast);
    return () => {
      stopBridge();
      stopLinks();
    };
  }, [showToast]);

  const onEstimateChange = (t: string) => {
    const digits = t.replace(/[^0-9]/g, '').slice(0, 3);
    setEstimateText(digits);
    if (digits) estimateRef.current = clampEstimate(parseInt(digits, 10));
  };

  const bump = (d: number) => {
    const v = clampEstimate((parseInt(estimateText, 10) || DEFAULT_ESTIMATE) + d);
    setEstimateText(String(v));
    estimateRef.current = v;
  };

  const onStart = () => {
    const v = clampEstimate(parseInt(estimateText, 10) || DEFAULT_ESTIMATE);
    void startOrder(v, showToast).then(() => showToast(`已開始：預估 ${v} 分`));
  };

  // v0.4 自動偵測：前景開「偵測中」動態島（App 之後在背景更新它）＋開始靜音保活，再叫出系統的螢幕廣播視窗
  const onStartDetect = async () => {
    let msg: string;
    try {
      await ensurePermission(); // 偵測到新單／心跳中斷都靠本地通知回報
      await LiveActivity.startStandby();
      msg = '已建立「偵測中」動態島。';
    } catch (e) {
      msg = `動態島待命卡建立失敗：${e instanceof Error ? e.message : String(e)}（仍可廣播，結果改看通知）。`;
    }
    const st = LiveActivity.armDetection();
    msg += st ? `保活：${st.keepAlive}${st.keepAliveError ? `（${st.keepAliveError}）` : ''}。` : '（原生版本太舊，沒有保活）';
    const shown = (await pickerRef.current?.show()) ?? false;
    setDetectMsg(shown ? `${msg}請在跳出的視窗按「開始直播」。` : `${msg}沒跳出視窗的話，請點右邊的圓形按鈕。`);
  };

  const onStopDetect = () => {
    void LiveActivity.stopDetection()
      .catch(() => undefined)
      .then(() => setDetectMsg('已停止保活、收掉偵測卡。螢幕廣播請點左上角紅色時間 → 停止。'));
  };

  const onDone = (id: string) => {
    void completeOrder(id).then((o) => {
      if (o) showToast(`已送達：實際 ${o.actualMin} 分／預估 ${o.estimateMin} 分`);
    });
  };

  const onCancel = (id: string) => {
    Alert.alert('取消這張單？', '不會算進統計', [
      { text: '不要', style: 'cancel' },
      { text: '取消這單', style: 'destructive', onPress: () => void cancelOrder(id) },
    ]);
  };

  const active = useMemo(() => activeOrders(orders), [orders]);
  const stats = useMemo(() => todayStats(orders, now), [orders, now]);
  const recent = useMemo(() => history(orders, 50), [orders]);
  const laSupported = useMemo(() => LiveActivity.isSupported(), []);
  // 原生偵測狀態每秒讀一次（同步、很便宜）
  const det = useMemo(() => LiveActivity.detectorStatus(), [now]);
  const autoToday = useMemo(() => countAutoToday(orders, now), [orders, now]);
  const beatAge = beatAgeSec(det, now);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>🐼 熊貓倒數</Text>
        {!laSupported && (
          <Text style={styles.warn}>動態島不可用（需原生版本，且 設定 › 熊貓倒數 › 即時動態 要開啟）</Text>
        )}

        {/* 0. 自動偵測（v0.4 測試） */}
        <View style={styles.card}>
          <Text style={styles.section}>自動偵測（測試）</Text>
          <Text style={styles.note}>1. 按「開始偵測」 → 2. 在跳出的視窗按「開始直播」。停止：點左上角紅色時間 → 停止。</Text>
          {det && (
            <View style={styles.detBox}>
              <Text style={styles.detLine}>
                保活：{det.armed ? det.keepAlive : '未保活'}
                {det.keepAliveError ? `（${det.keepAliveError}）` : ''}
              </Text>
              <Text style={[styles.detLine, beatAge != null && beatAge > 150 ? { color: RED } : null]}>
                最後心跳：
                {det.lastBeatAt ? `${formatClock(det.lastBeatAt)}（${beatAge} 秒前）` : '尚未收到'}
              </Text>
              <Text style={styles.detLine}>
                今日自動偵測：{autoToday} 單
                {det.lastOrderMinutes != null && det.lastOrderAt
                  ? `・最近 ${det.lastOrderMinutes} 分 ${formatClock(det.lastOrderAt)}`
                  : ''}
              </Text>
              {!!det.lastOrderHow && <Text style={styles.note}>{det.lastOrderHow}</Text>}
            </View>
          )}
          <View style={styles.row}>
            <Pressable
              style={({ pressed }) => [styles.bigBtn, styles.detectBtn, { opacity: pressed ? 0.7 : 1 }]}
              onPress={() => void onStartDetect()}
            >
              <Text style={styles.bigBtnText}>開始偵測</Text>
            </Pressable>
            <BroadcastPicker ref={pickerRef} style={styles.picker} />
          </View>
          {det?.armed && (
            <Pressable
              style={({ pressed }) => [styles.stopBtn, { opacity: pressed ? 0.7 : 1 }]}
              onPress={onStopDetect}
            >
              <Text style={styles.stopBtnText}>停止偵測</Text>
            </Pressable>
          )}
          {detectMsg && <Text style={styles.note}>{detectMsg}</Text>}
        </View>

        {/* 1. 開始倒數 */}
        <View style={styles.card}>
          <Text style={styles.label}>預估分鐘</Text>
          <View style={styles.row}>
            <Pressable style={styles.stepBtn} onPress={() => bump(-1)}>
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <TextInput
              style={styles.input}
              value={estimateText}
              onChangeText={onEstimateChange}
              keyboardType="number-pad"
              returnKeyType="done"
              selectTextOnFocus
              maxLength={3}
            />
            <Pressable style={styles.stepBtn} onPress={() => bump(1)}>
              <Text style={styles.stepText}>＋</Text>
            </Pressable>
          </View>
          <Pressable
            style={({ pressed }) => [styles.bigBtn, { backgroundColor: PINK, opacity: pressed ? 0.7 : 1 }]}
            onPress={onStart}
          >
            <Text style={styles.bigBtnText}>開始倒數</Text>
          </Pressable>
        </View>

        {toast && <Text style={styles.toast}>{toast}</Text>}

        {active.length === 0 && (
          <Text style={styles.hint}>
            捷徑設定：熊貓接單＝擷取螢幕畫面＋熊貓倒數：從截圖開始；熊貓送達＝熊貓倒數：送達（或按動態島上的「送達」）
          </Text>
        )}

        {/* 2. 進行中 */}
        {active.map((o) => {
          const left = o.deadline - now;
          const late = left < 0;
          return (
            <View key={o.id} style={[styles.card, late && styles.cardLate]}>
              <View style={styles.rowBetween}>
                <Text style={styles.meta}>
                  接單 {formatClock(o.acceptedAt)}・預估 {o.estimateMin} 分
                </Text>
                <Pressable onPress={() => onCancel(o.id)} hitSlop={12}>
                  <Text style={styles.cancel}>取消</Text>
                </Pressable>
              </View>
              <Text style={[styles.countLabel, { color: late ? RED : '#333' }]}>
                {late ? '已超時' : '剩餘'}
              </Text>
              <Text style={[styles.countdown, { color: late ? RED : left < 3 * 60_000 ? '#EF6C00' : '#111' }]}>
                {formatDuration(left)}
              </Text>
              <Pressable
                style={({ pressed }) => [styles.bigBtn, { backgroundColor: GREEN, opacity: pressed ? 0.7 : 1 }]}
                onPress={() => onDone(o.id)}
              >
                <Text style={styles.bigBtnText}>送達</Text>
              </Pressable>
            </View>
          );
        })}

        {/* 3. 今日統計 */}
        <View style={styles.card}>
          <Text style={styles.section}>今日統計</Text>
          <View style={styles.statsGrid}>
            <Stat label="單數" value={String(stats.count)} />
            <Stat label="準時率" value={pct(stats.onTimeRate)} />
            <Stat label="平均超出比例" value={pct(stats.avgOverRatio)} />
            <Stat
              label={`短單(≤${SHORT_ORDER_MAX_MIN}分)晚到`}
              value={`${stats.shortLate}/${stats.shortCount}`}
            />
          </View>
          <Text style={styles.note}>
            平均超出比例＝每單 max(0,(實際−預估)/預估) 的平均，近似 foodpanda 超時率（不含平台未公開的彈性時間）。
          </Text>
        </View>

        {/* 4. 歷史 */}
        <View style={styles.card}>
          <Text style={styles.section}>最近 {recent.length} 筆</Text>
          {recent.length === 0 && <Text style={styles.meta}>還沒有紀錄</Text>}
          {recent.map((o) => {
            const late = isLate(o);
            const over = (o.actualMin ?? 0) - o.estimateMin;
            return (
              <View key={o.id} style={styles.histRow}>
                <Text style={styles.histTime}>
                  {new Date(o.acceptedAt).getMonth() + 1}/{new Date(o.acceptedAt).getDate()}{' '}
                  {formatClock(o.acceptedAt)}
                </Text>
                <Text style={styles.histText}>
                  預估 {o.estimateMin}・實際 {o.actualMin}
                </Text>
                <Text style={[styles.histBadge, { color: late ? RED : GREEN }]}>
                  {late ? `超 ${Math.round(over * 10) / 10}` : '準時'}
                </Text>
              </View>
            );
          })}
        </View>
        <OtaBox />
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F6F1F3' },
  container: { padding: 16, paddingBottom: 48, gap: 14 },
  title: { fontSize: 30, fontWeight: '800', color: PINK, textAlign: 'center', marginTop: 8 },
  warn: { fontSize: 15, color: '#8D6E63', textAlign: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 18,
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  cardLate: { borderWidth: 3, borderColor: RED },
  label: { fontSize: 20, fontWeight: '600', color: '#333' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stepBtn: {
    width: 72,
    height: 72,
    borderRadius: 16,
    backgroundColor: '#EEE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: { fontSize: 36, fontWeight: '700', color: '#333' },
  input: {
    flex: 1,
    height: 72,
    borderRadius: 16,
    backgroundColor: '#FAFAFA',
    borderWidth: 2,
    borderColor: '#DDD',
    fontSize: 40,
    fontWeight: '800',
    textAlign: 'center',
    color: '#111',
  },
  bigBtn: { height: 76, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  bigBtnText: { color: '#fff', fontSize: 30, fontWeight: '800' },
  detectBtn: { flex: 1, backgroundColor: '#5E35B1' },
  picker: { width: 76, height: 76, borderRadius: 18, backgroundColor: '#EDE7F6' },
  stopBtn: { height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#ECEFF1' },
  stopBtnText: { fontSize: 20, fontWeight: '700', color: '#455A64' },
  detBox: { gap: 4, padding: 10, borderRadius: 12, backgroundColor: '#F3EFFA' },
  detLine: { fontSize: 16, color: '#333', fontWeight: '600' },
  toast: { fontSize: 18, color: '#333', textAlign: 'center', fontWeight: '600' },
  hint: { fontSize: 14, color: '#888', textAlign: 'center', lineHeight: 20 },
  meta: { fontSize: 18, color: '#555' },
  cancel: { fontSize: 18, color: '#999', textDecorationLine: 'underline' },
  countLabel: { fontSize: 22, fontWeight: '700' },
  countdown: { fontSize: 64, fontWeight: '800', fontVariant: ['tabular-nums'] },
  section: { fontSize: 22, fontWeight: '800', color: '#222' },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 12 },
  stat: { width: '50%', alignItems: 'center' },
  statValue: { fontSize: 32, fontWeight: '800', color: '#111' },
  statLabel: { fontSize: 16, color: '#666', marginTop: 2 },
  note: { fontSize: 13, color: '#888', lineHeight: 18 },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#DDD',
    gap: 8,
  },
  histTime: { fontSize: 16, color: '#666', width: 96 },
  histText: { fontSize: 17, color: '#222', flex: 1 },
  histBadge: { fontSize: 17, fontWeight: '700' },
});
