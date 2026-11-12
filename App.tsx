// v0.9 UI 改版：App.tsx 只管狀態、原生/通知/deep link 接線與分頁切換；畫面在 src/ui/（首頁/紀錄/設定＋底部分頁列）。
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as LiveActivity from './modules/live-activity';
import { type BroadcastPickerHandle } from './modules/live-activity';
import {
  completeOrder,
  importOrders,
  initNativeBridge,
  listenDeepLinks,
  previewImport,
  startOrder,
} from './src/controller';
import * as Updates from 'expo-updates';
import * as Notifications from 'expo-notifications';
import { isRedetectData, locationAuthPending } from './src/detector';
import { describeImport, parseImportLink } from './src/importLink';
import { ensurePermission } from './src/notify';
import { OtaBanner, useOtaUpdate } from './src/OtaBox';
import { clampEstimate, DEFAULT_ESTIMATE, type Order } from './src/orders';
import { DEFAULT_GOALS, DEFAULT_STATS, goalProgress, periodAndToday, periodOf, type Baseline, type Goals, type StatsParams } from './src/stats';
import { DEFAULT_PAY, periodAndTodayEarnings, type PayParams } from './src/earnings';
import { fetchRemoteParams, loadBaseline, loadCachedPayParams, loadCachedStatsParams, loadGoals } from './src/statsConfig';
import { subscribe } from './src/store';
import { confirmCancel, confirmDeleteOne } from './src/ui/actions';
import { HistoryScreen } from './src/ui/HistoryScreen';
import { HomeScreen } from './src/ui/HomeScreen';
import {
  detectPill,
  parseTab,
  shouldJumpHome,
  sortActive,
  TAB_STORAGE_KEY,
  type Attention,
  type Tab,
} from './src/ui/logic';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { TabBar } from './src/ui/TabBar';
import { C, F, S } from './src/ui/theme';

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
  /** 這個程序內最後一次按「開始偵測」的時間（膠囊判「等待開始直播」用） */
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ota = useOtaUpdate();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => subscribe(setOrders), []);

  // ── 分頁：記住上次所在分頁（AsyncStorage）；讀回來之前若已自動/手動切過就不覆蓋 ──
  const [tab, setTabState] = useState<Tab>('home');
  const tabTouched = useRef(false);
  const setTab = useCallback((t: Tab) => {
    tabTouched.current = true;
    setTabState(t);
    void AsyncStorage.setItem(TAB_STORAGE_KEY, t).catch(() => undefined);
  }, []);
  useEffect(() => {
    void AsyncStorage.getItem(TAB_STORAGE_KEY)
      .then((raw) => {
        const t = parseTab(raw);
        if (t && !tabTouched.current) setTabState(t);
      })
      .catch(() => undefined);
  }, []);

  // v0.7 統計參數（遠端設定 stats）＋目標（AsyncStorage）
  const [statsParams, setStatsParams] = useState<StatsParams>(DEFAULT_STATS);
  const [payParams, setPayParams] = useState<PayParams>(DEFAULT_PAY);
  const [goals, setGoals] = useState<Goals>(DEFAULT_GOALS);
  useEffect(() => {
    let alive = true;
    void loadCachedStatsParams().then((p) => alive && setStatsParams(p));
    void loadCachedPayParams().then((p) => alive && setPayParams(p));
    void fetchRemoteParams().then((p) => {
      if (!alive || !p) return;
      setStatsParams(p.stats);
      setPayParams(p.pay);
    });
    void loadGoals().then((g) => alive && setGoals(g));
    return () => {
      alive = false;
    };
  }, []);
  // v0.7 本期補登（App 上線前本期已跑的單）：綁期別，換期自動失效
  const periodId = periodOf(now).id;
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  useEffect(() => {
    let alive = true;
    void loadBaseline(periodId).then((b) => alive && setBaseline(b));
    return () => {
      alive = false;
    };
  }, [periodId]);

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
    // v0.8 pandatimer://import?d=…：解析 → 確認視窗（筆數/日期/重複）→ 確認才寫入
    const onImport = (url: string) => {
      const parsed = parseImportLink(url);
      if (!parsed) return;
      if (!parsed.ok) {
        Alert.alert('匯入連結有問題', parsed.error);
        return;
      }
      void previewImport(parsed.rows).then((plan) => {
        if (!plan.add.length) {
          Alert.alert('沒有要匯入的單', describeImport(plan, parsed.skippedActive));
          return;
        }
        Alert.alert('匯入訂單？', describeImport(plan, parsed.skippedActive), [
          { text: '不要', style: 'cancel' },
          {
            text: `匯入 ${plan.add.length} 筆`,
            onPress: () =>
              void importOrders(parsed.rows).then((p) =>
                showToast(`已匯入 ${p.add.length} 筆${p.duplicates.length ? `（略過重複 ${p.duplicates.length} 筆）` : ''}`),
              ),
          },
        ]);
      });
    };
    const stopLinks = listenDeepLinks(() => estimateRef.current, showToast, onImport);
    return () => {
      stopBridge();
      stopLinks();
    };
  }, [showToast]);

  const onEstimateChange = useCallback((t: string) => {
    const digits = t.replace(/[^0-9]/g, '').slice(0, 3);
    setEstimateText(digits);
    if (digits) estimateRef.current = clampEstimate(parseInt(digits, 10));
  }, []);

  const bump = useCallback((d: number) => {
    setEstimateText((cur) => {
      const v = clampEstimate((parseInt(cur, 10) || DEFAULT_ESTIMATE) + d);
      estimateRef.current = v;
      return String(v);
    });
  }, []);

  const onStart = () => {
    const v = clampEstimate(parseInt(estimateText, 10) || DEFAULT_ESTIMATE);
    void startOrder(v, showToast).then(() => showToast(`已開始：預估 ${v} 分`));
  };

  // 自動偵測：前景開「偵測中」動態島（App 之後在背景更新它）＋開始保活（v0.5：背景定位優先、音訊備援），
  // 等定位授權視窗有結果後（避免和廣播視窗搶畫面）再叫出系統的螢幕廣播視窗。
  // BroadcastPicker 掛在首頁膠囊裡 → 一律先切回首頁。
  const onStartDetect = async () => {
    setTab('home');
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
      setArmedAt(Date.now());
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

  const onShowPicker = () => {
    void (async () => {
      const shown = (await pickerRef.current?.show()) ?? false;
      setDetectMsg(shown ? '請在跳出的視窗按「開始直播」。' : '沒跳出視窗的話，請點右邊的圓形按鈕。');
    })();
  };

  // v0.8：點「偵測停止了，點我重新開始」通知（userInfo pandatimer=redetect）→ 回前景後自動走「開始偵測」叫出廣播視窗
  const startDetectRef = useRef(onStartDetect);
  startDetectRef.current = onStartDetect;
  useEffect(() => {
    let lastId: string | null = null;
    const run = (resp: Notifications.NotificationResponse | null) => {
      if (!resp || !isRedetectData(resp.notification.request.content.data)) return;
      const id = resp.notification.request.identifier;
      if (id === lastId) return;
      lastId = id;
      setTab('home');
      const go = () => setTimeout(() => void startDetectRef.current(), 600); // 等畫面與 BroadcastPicker 掛好
      if (AppState.currentState === 'active') go();
      else {
        const sub = AppState.addEventListener('change', (s) => {
          if (s === 'active') {
            sub.remove();
            go();
          }
        });
      }
    };
    const sub = Notifications.addNotificationResponseReceivedListener(run);
    // 冷啟動：App 是被這則通知打開的
    void Notifications.getLastNotificationResponseAsync().then(run).catch(() => undefined);
    return () => sub.remove();
  }, [setTab]);

  const stopDetectNow = () => {
    setArmedAt(null);
    void LiveActivity.stopDetection()
      .catch(() => undefined)
      .then(() => setDetectMsg('已停止保活（定位/音訊）、收掉偵測卡。螢幕廣播請點左上角紅色時間 → 停止。'));
  };
  // 騎車時誤觸代價高 → 停止前確認一次
  const onStopDetect = () => {
    Alert.alert('停止偵測？', '會停止保活、收掉偵測卡（卡上還有單就保留倒數）。', [
      { text: '不要', style: 'cancel' },
      { text: '停止偵測', style: 'destructive', onPress: stopDetectNow },
    ]);
  };

  const onDone = useCallback(
    (id: string) => {
      void completeOrder(id).then((o) => {
        if (o) showToast(`已送達：實際 ${o.actualMin} 分／預估 ${o.estimateMin} 分`);
      });
    },
    [showToast],
  );
  const onDeleteOne = useCallback((o: Order) => confirmDeleteOne(o, showToast), [showToast]);

  const active = useMemo(() => sortActive(orders), [orders]);
  // 本期（14 天報酬週期，台北時區）＋今日；分鐘級即可，不必每秒重算
  const minuteTick = Math.floor(now / 60_000);
  const st = useMemo(
    () => periodAndToday(orders, minuteTick * 60_000, statsParams, baseline),
    [orders, minuteTick, statsParams, baseline],
  );
  const earn = useMemo(
    () => periodAndTodayEarnings(orders, minuteTick * 60_000, payParams, baseline),
    [orders, minuteTick, payParams, baseline],
  );
  const gp = useMemo(() => goalProgress(st.current, goals), [st, goals]);
  const laSupported = useMemo(() => LiveActivity.isSupported(), []);
  // 原生偵測狀態每秒讀一次（同步、很便宜）
  const det = useMemo(() => LiveActivity.detectorStatus(), [now]);
  const pill = detectPill(det, now, armedAt);

  // 偵測停止／有邀請（膠囊變紅/黃）或多了進行中單 → 自動切回首頁
  const lastAttention = useRef<Attention | null>(null);
  useEffect(() => {
    const next: Attention = { kind: pill.kind, activeCount: active.length };
    const prev = lastAttention.current;
    lastAttention.current = next;
    if (shouldJumpHome(prev, next) && tab !== 'home') setTab('home');
  }, [pill.kind, active.length, tab, setTab]);

  const minuteNow = minuteTick * 60_000;
  const noStacked = st.noStacked;

  return (
    <SafeAreaView style={S.safe} edges={['top', 'left', 'right']}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>
        {/* 三頁都掛著（切頁保留捲動位置/輸入中的草稿；BroadcastPicker 在首頁），只顯示目前那頁 */}
        <View style={[S.screen, tab !== 'home' && hidden]}>
          <HomeScreen
            now={now}
            pill={pill}
            detectMsg={detectMsg}
            pickerRef={pickerRef}
            onStartDetect={() => void onStartDetect()}
            onStopDetect={onStopDetect}
            onShowPicker={onShowPicker}
            laSupported={laSupported}
            active={active}
            pay={payParams}
            onDone={onDone}
            onCancel={confirmCancel}
            onDelete={onDeleteOne}
            stats={st}
            gp={gp}
            goals={goals}
            todayEarn={earn.today}
            estimateText={estimateText}
            onEstimateChange={onEstimateChange}
            onBump={bump}
            onManualStart={onStart}
            otaBanner={<OtaBanner ota={ota} />}
          />
        </View>
        <View style={[S.screen, tab !== 'history' && hidden]}>
          <HistoryScreen
            orders={orders}
            now={minuteNow}
            stats={statsParams}
            pay={payParams}
            earn={earn}
            periodLabel={st.period.label}
            noStacked={noStacked}
            toast={showToast}
          />
        </View>
        <View style={[S.screen, tab !== 'settings' && hidden]}>
          <SettingsScreen
            goals={goals}
            onGoals={setGoals}
            baseline={baseline}
            onBaseline={setBaseline}
            periodId={periodId}
            periodLabel={st.period.label}
            statsParams={statsParams}
            det={det}
            now={now}
            orders={orders}
            laSupported={laSupported}
            ota={ota}
            onStopDetect={onStopDetect}
          />
        </View>
        {toast && (
          <View pointerEvents="none" style={toastWrap}>
            <Text style={toastText}>{toast}</Text>
          </View>
        )}
      </View>
      <TabBar tab={tab} onChange={setTab} homeBadge={active.length} />
    </SafeAreaView>
  );
}

const hidden = { display: 'none' } as const;
const toastWrap = {
  position: 'absolute',
  left: 16,
  right: 16,
  bottom: 12,
  backgroundColor: '#333333',
  borderRadius: 16,
  paddingVertical: 14,
  paddingHorizontal: 16,
  borderWidth: 1,
  borderColor: C.border,
} as const;
const toastText = { fontSize: F.body, fontWeight: '700', color: C.text, textAlign: 'center' } as const;
