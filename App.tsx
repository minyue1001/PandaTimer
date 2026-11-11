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
import * as Updates from 'expo-updates';
import { beatAgeSec, countAutoToday, locationAuthPending, offerLine, telemetryLine } from './src/detector';
import { ensurePermission } from './src/notify';
import { OtaBox } from './src/OtaBox';
import {
  activeOrders,
  clampEstimate,
  DEFAULT_ESTIMATE,
  formatClock,
  formatDuration,
  history,
  type Order,
} from './src/orders';
import {
  DEFAULT_GOALS,
  DEFAULT_STATS,
  goalProgress,
  goalText,
  isOnTime,
  parsePercentInput,
  periodAndToday,
  periodOf,
  type Baseline,
  type Goals,
  type StatsParams,
} from './src/stats';
import {
  fetchStatsParams,
  loadBaseline,
  loadCachedStatsParams,
  loadGoals,
  saveBaseline,
  saveGoals,
} from './src/statsConfig';
import { subscribe } from './src/store';

const PINK = '#D70F64';
const RED = '#E53935';
const GREEN = '#2E7D32';
const YELLOW = '#F9A825';
/** v0.7 準時率三層顏色：≥目標 綠、底線～目標 黃、<底線 紅 */
const LEVEL_COLOR = { met: GREEN, between: YELLOW, below: RED } as const;

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

  // v0.7 統計參數（遠端設定 stats）＋目標（AsyncStorage）
  const [statsParams, setStatsParams] = useState<StatsParams>(DEFAULT_STATS);
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  const [goalDraft, setGoalDraft] = useState<{ onTime: string; floor: string; overrun: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadCachedStatsParams().then((p) => alive && setStatsParams(p));
    void fetchStatsParams().then((p) => alive && p && setStatsParams(p));
    void loadGoals().then((g) => alive && setGoals(g));
    return () => {
      alive = false;
    };
  }, []);
  // v0.7 本期補登（App 上線前本期已跑的單）：綁期別，換期自動失效
  const periodId = periodOf(now).id;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [baseDraft, setBaseDraft] = useState<{ count: string; onTime: string; overrun: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadBaseline(periodId).then((b) => alive && setBaseline(b));
    return () => {
      alive = false;
    };
  }, [periodId]);
  const onSaveBaseline = () => {
    if (!baseDraft) return;
    const count = /^\s*\d{1,4}\s*$/.test(baseDraft.count) ? parseInt(baseDraft.count, 10) : NaN;
    const onTime = parsePercentInput(baseDraft.onTime);
    const overrun = parsePercentInput(baseDraft.overrun);
    if (!(count >= 0 && count <= 2000) || onTime == null || overrun == null) {
      Alert.alert('補登格式不對', '單數 0~2000；準時率、超時率輸入 0~100 的百分比（照報酬單上的數字）');
      return;
    }
    const next: Baseline | null = count > 0 ? { periodId, count, onTimeRate: onTime, overrunRate: overrun } : null;
    setBaseline(next);
    setBaseDraft(null);
    void saveBaseline(next);
  };
  const onClearBaseline = () => {
    setBaseline(null);
    setBaseDraft(null);
    void saveBaseline(null);
  };

  const onSaveGoals = () => {
    if (!goalDraft) return;
    const onTime = parsePercentInput(goalDraft.onTime);
    const floor = parsePercentInput(goalDraft.floor);
    const overrun = parsePercentInput(goalDraft.overrun);
    if (onTime == null || floor == null || overrun == null) {
      Alert.alert('目標格式不對', '請輸入 0~100 的百分比，例如 50、40、20');
      return;
    }
    if (floor > onTime) {
      Alert.alert('底線不能高於目標', '例如 準時率目標 50、底線 40');
      return;
    }
    const next = { onTimeRate: onTime, onTimeFloor: floor, overrunRate: overrun };
    setGoals(next);
    setGoalDraft(null);
    void saveGoals(next);
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // v0.6：原生遠端回報帶上 OTA 更新 id（回報由原生送，JS 只顯示「回報：最後成功」）
    LiveActivity.setTelemetryContext({ upd: Updates.updateId ? Updates.updateId.slice(0, 8) : 'embedded' });
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

  // 自動偵測：前景開「偵測中」動態島（App 之後在背景更新它）＋開始保活（v0.5：背景定位優先、音訊備援），
  // 等定位授權視窗有結果後（避免和廣播視窗搶畫面）再叫出系統的螢幕廣播視窗
  const onStartDetect = async () => {
    let msg: string;
    try {
      await ensurePermission(); // 偵測到新單／心跳中斷都靠本地通知回報
      await LiveActivity.startStandby();
      msg = '已建立「偵測中」動態島。';
    } catch (e) {
      msg = `動態島待命卡建立失敗：${e instanceof Error ? e.message : String(e)}（仍可廣播，結果改看通知）。`;
    }
    let st = LiveActivity.armDetection();
    if (st) {
      setDetectMsg(`${msg}等待定位授權（請選「使用 App 期間」）…`);
      const until = Date.now() + 30_000;
      await new Promise((r) => setTimeout(r, 400));
      st = LiveActivity.detectorStatus() ?? st;
      while (locationAuthPending(st) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 400));
        st = LiveActivity.detectorStatus() ?? st;
      }
    }
    msg += st ? `保活：${st.keepAlive}${st.keepAliveError ? `（${st.keepAliveError}）` : ''}。` : '（原生版本太舊，沒有保活）';
    const shown = (await pickerRef.current?.show()) ?? false;
    setDetectMsg(shown ? `${msg}請在跳出的視窗按「開始直播」。` : `${msg}沒跳出視窗的話，請點右邊的圓形按鈕。`);
  };

  const onStopDetect = () => {
    void LiveActivity.stopDetection()
      .catch(() => undefined)
      .then(() => setDetectMsg('已停止保活（定位/音訊）、收掉偵測卡。螢幕廣播請點左上角紅色時間 → 停止。'));
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
  // 本期（14 天報酬週期，台北時區）＋今日；分鐘級即可，不必每秒重算
  const minuteTick = Math.floor(now / 60_000);
  const st = useMemo(
    () => periodAndToday(orders, minuteTick * 60_000, statsParams, baseline),
    [orders, minuteTick, statsParams, baseline],
  );
  const gp = useMemo(() => goalProgress(st.current, goals), [st, goals]);
  const gt = goalText(gp, goals);
  const onTimeColor = gp.onTimeLevel ? LEVEL_COLOR[gp.onTimeLevel] : undefined;
  const recent = useMemo(() => history(orders, 50), [orders]);
  const laSupported = useMemo(() => LiveActivity.isSupported(), []);
  // 原生偵測狀態每秒讀一次（同步、很便宜）
  const det = useMemo(() => LiveActivity.detectorStatus(), [now]);
  const autoToday = useMemo(() => countAutoToday(orders, now), [orders, now]);
  const beatAge = beatAgeSec(det, now);
  const offerText = offerLine(det, now);

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
          <Text style={styles.note}>
            1. 按「開始偵測」（定位權限選「使用 App 期間」）→ 2. 在跳出的視窗按「開始直播」。停止：點左上角紅色時間 → 停止。
            v0.7：看到新單邀請先不倒數，等你按「接受」後（偵測到接單後的畫面）才開始倒數並記錄；拒絕或逾時不記。
            看到「完成訂單」畫面會自動記錄送達（接單 2 分鐘內的單不會被自動結；手動送達照樣可用）。
            多單：動態島倒數最早截止那單，其他單列在下面；按「送達」自動切到下一單。
            動態島沒變時：點「偵測到新單」通知打開 App，或長按動態島按「開始倒數」。
          </Text>
          {det && (
            <View style={styles.detBox}>
              <Text style={styles.detLine}>
                保活：{det.armed ? det.keepAlive : '無'}
                {det.armed && det.keepAliveMode === 'location' && det.lastFixAt
                  ? `（上次定位 ${formatClock(det.lastFixAt)}）`
                  : ''}
                {det.keepAliveError ? `（${det.keepAliveError}）` : ''}
              </Text>
              {!!det.islandCheck && (
                <Text style={[styles.detLine, det.islandCheck.includes('✗') ? { color: RED } : { color: GREEN }]}>
                  {det.islandCheck}
                </Text>
              )}
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
              {!!offerText && (
                <Text style={[styles.detLine, det.offerPendingAt != null && offerText.startsWith('偵測到邀請') ? { color: GREEN } : null]}>
                  {offerText}
                </Text>
              )}
              {!!det.lastOrderHow && <Text style={styles.note}>{det.lastOrderHow}</Text>}
              <Text style={[styles.note, det.telemetryError ? { color: RED } : null]}>{telemetryLine(det)}</Text>
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

        {/* 3. 本期統計（v0.7：對齊 foodpanda 報酬單的近似算法＋目標） */}
        <View style={styles.card}>
          <Text style={styles.section}>本期（{st.period.label}）</Text>
          {st.current.baselineCount > 0 && (
            <Text style={styles.note}>
              含補登 {st.current.baselineCount} 單（App 紀錄 {st.own.count} 單）
            </Text>
          )}
          <View style={styles.statsGrid}>
            <Stat label="單數" value={String(st.current.count)} />
            <Stat label="今日單數" value={String(st.today.count)} />
            <Stat
              label={`準時率（目標 ${pct(goals.onTimeRate)}／底線 ${pct(goals.onTimeFloor)}）`}
              value={pct(st.current.onTimeRate)}
              color={onTimeColor}
            />
            <Stat
              label={`超時率（目標 ≤${pct(goals.overrunRate)}）`}
              value={pct(st.current.overrunRate)}
              color={gp.overrunMet == null ? undefined : gp.overrunMet ? GREEN : RED}
            />
            <Stat label="今日準時率" value={pct(st.today.onTimeRate)} />
            <Stat label="今日超時率" value={pct(st.today.overrunRate)} />
          </View>
          <Text style={[styles.detLine, { color: onTimeColor ?? '#333' }]}>{gt.onTime}</Text>
          <Text style={[styles.detLine, { color: gp.overrunMet === false ? RED : gp.overrunMet ? GREEN : '#333' }]}>{gt.overrun}</Text>
          {goalDraft ? (
            <View style={styles.row}>
              <TextInput
                style={styles.goalInput}
                keyboardType="decimal-pad"
                value={goalDraft.onTime}
                onChangeText={(t) => setGoalDraft({ ...goalDraft, onTime: t })}
                placeholder="準時目標%"
              />
              <TextInput
                style={styles.goalInput}
                keyboardType="decimal-pad"
                value={goalDraft.floor}
                onChangeText={(t) => setGoalDraft({ ...goalDraft, floor: t })}
                placeholder="準時底線%"
              />
              <TextInput
                style={styles.goalInput}
                keyboardType="decimal-pad"
                value={goalDraft.overrun}
                onChangeText={(t) => setGoalDraft({ ...goalDraft, overrun: t })}
                placeholder="超時率%"
              />
              <Pressable onPress={onSaveGoals}>
                <Text style={styles.goalBtn}>儲存</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() =>
                setGoalDraft({
                  onTime: String(Math.round(goals.onTimeRate * 1000) / 10),
                  floor: String(Math.round(goals.onTimeFloor * 1000) / 10),
                  overrun: String(Math.round(goals.overrunRate * 1000) / 10),
                })
              }
            >
              <Text style={styles.cancel}>改目標（準時目標／準時底線／超時上限）</Text>
            </Pressable>
          )}
          {baseDraft ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.note}>補登本期在 App 之前跑的成績（照報酬單／foodpanda App 上的數字）：</Text>
              <View style={styles.row}>
                <TextInput
                  style={styles.goalInput}
                  keyboardType="number-pad"
                  value={baseDraft.count}
                  onChangeText={(t) => setBaseDraft({ ...baseDraft, count: t })}
                  placeholder="已完成單數"
                />
                <TextInput
                  style={styles.goalInput}
                  keyboardType="decimal-pad"
                  value={baseDraft.onTime}
                  onChangeText={(t) => setBaseDraft({ ...baseDraft, onTime: t })}
                  placeholder="準時率%"
                />
                <TextInput
                  style={styles.goalInput}
                  keyboardType="decimal-pad"
                  value={baseDraft.overrun}
                  onChangeText={(t) => setBaseDraft({ ...baseDraft, overrun: t })}
                  placeholder="超時率%"
                />
              </View>
              <View style={styles.row}>
                <Pressable onPress={onSaveBaseline}>
                  <Text style={styles.goalBtn}>儲存補登</Text>
                </Pressable>
                <Pressable onPress={onClearBaseline}>
                  <Text style={styles.cancel}>清除補登</Text>
                </Pressable>
                <Pressable onPress={() => setBaseDraft(null)}>
                  <Text style={styles.cancel}>取消</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              onPress={() =>
                setBaseDraft(
                  baseline
                    ? {
                        count: String(baseline.count),
                        onTime: String(Math.round(baseline.onTimeRate * 1000) / 10),
                        overrun: String(Math.round(baseline.overrunRate * 1000) / 10),
                      }
                    : { count: '', onTime: '', overrun: '' },
                )
              }
            >
              <Text style={styles.cancel}>
                {baseline ? `修改補登（本期之前 ${baseline.count} 單）` : '補登本期之前的成績'}
              </Text>
            </Pressable>
          )}
          <Text style={styles.note}>
            算法（依三期報酬單反推的近似）：彈性線＝預估 × {statsParams.graceFactor}；實際 ≤ 彈性線算準時；
            每單超時比例＝(實際−彈性線)/彈性線（0~{Math.round(statsParams.overrunCap * 100)}%）的平均＝超時率。取消單不計。每 14 天一期（台北時間週一 00:00 起）。
          </Text>
        </View>

        {/* 4. 歷史 */}
        <View style={styles.card}>
          <Text style={styles.section}>最近 {recent.length} 筆</Text>
          {recent.length === 0 && <Text style={styles.meta}>還沒有紀錄</Text>}
          {recent.map((o) => {
            // v0.7：與本期統計同一條彈性線（預估 × graceFactor）
            const late = o.actualMin != null && !isOnTime({ est: o.estimateMin, act: o.actualMin }, statsParams);
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

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, color ? { color } : null]}>{value}</Text>
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
  goalInput: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#DDD',
    fontSize: 22,
    textAlign: 'center',
    color: '#111',
  },
  goalBtn: { fontSize: 20, fontWeight: '800', color: PINK, paddingHorizontal: 8 },
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
