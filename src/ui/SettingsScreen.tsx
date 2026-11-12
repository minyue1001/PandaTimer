// 設定頁：目標三門檻 → 補登本期 → 雲端同步 → 偵測診斷 → App 版本/OTA → 使用說明與捷徑（折疊）
import { useState } from 'react';
import { Alert, ScrollView, Text, TextInput, View } from 'react-native';
import { beatAgeSec, countAutoToday, offerLine, telemetryLine, type DetectorStatus } from '../detector';
import { OtaBox, type OtaState } from '../OtaBox';
import { formatClock, type Order } from '../orders';
import { formatTaipeiDateTime } from '../prune';
import type { CloudSync } from '../syncClient';
import { parsePercentInput, type Baseline, type Goals, type StatsParams } from '../stats';
import { saveBaseline, saveGoals } from '../statsConfig';
import { Btn, Collapsible, KV } from './common';
import { BEAT_STALE_SEC, pctText, powerLine } from './logic';
import { C, F, S } from './theme';

const r1 = (x: number) => String(Math.round(x * 1000) / 10);

export type SettingsProps = {
  goals: Goals;
  onGoals: (g: Goals) => void;
  baseline: Baseline | null;
  onBaseline: (b: Baseline | null) => void;
  periodId: string;
  periodLabel: string;
  statsParams: StatsParams;
  det: DetectorStatus | null;
  now: number;
  orders: Order[];
  laSupported: boolean;
  ota: OtaState;
  onStopDetect: () => void;
  cloud: CloudSync;
};

export function SettingsScreen(p: SettingsProps) {
  return (
    <ScrollView contentContainerStyle={S.scroll} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Text style={S.h1}>設定</Text>
      <GoalsCard goals={p.goals} onGoals={p.onGoals} statsParams={p.statsParams} />
      <BaselineCard baseline={p.baseline} onBaseline={p.onBaseline} periodId={p.periodId} periodLabel={p.periodLabel} />
      <CloudSyncCard cloud={p.cloud} />
      <DiagCard det={p.det} now={p.now} orders={p.orders} laSupported={p.laSupported} onStopDetect={p.onStopDetect} />
      <View style={S.card}>
        <Text style={S.h2}>App 版本與更新</Text>
        <OtaBox ota={p.ota} />
      </View>
      <Collapsible title="📖 使用說明與捷徑">
        <Text style={S.text}>自動偵測</Text>
        <Text style={S.small}>
          1. 首頁按「開始偵測」（定位權限選「使用 App 期間」）→ 2. 在跳出的視窗按「開始直播」。停止廣播：點左上角紅色時間 → 停止。
          {'\n'}看到新單邀請先不倒數，等你按「接受」後才開始倒數並記錄；拒絕或逾時不記。
          {'\n'}看到「完成訂單」畫面會自動記錄送達（接單 2 分鐘內的單不會被自動結；手動送達照樣可用）。
          {'\n'}多單：動態島倒數最早截止那單，其他單列在下面；按「送達」自動切到下一單。
          {'\n'}動態島沒變時：點「偵測到新單」通知打開 App，或長按動態島按「開始倒數」。
          {'\n'}偵測停止時會通知「偵測停止了，點我重新開始」，點通知會自動叫出直播視窗。
        </Text>
        <Text style={S.text}>捷徑</Text>
        <Text style={S.small}>
          熊貓接單＝擷取螢幕畫面＋熊貓倒數：從截圖開始（背面輕點兩下）；熊貓送達＝熊貓倒數：送達（輕點三下，或按動態島上的「送達」）。
          {'\n'}連結：pandatimer://start?min=18、pandatimer://done、pandatimer://import?d=…（會先跳確認）。
        </Text>
        <Text style={S.text}>操作</Text>
        <Text style={S.small}>
          進行中卡片上半部長按＝刪除那筆；紀錄頁任一列長按＝單筆刪除；批次刪除在紀錄頁「管理紀錄」。
          {'\n'}改時間/金額/補登：電腦或手機瀏覽器開 {ADMIN_URL} 直接編輯，App 會自動同步回來。
        </Text>
      </Collapsible>
    </ScrollView>
  );
}

function GoalsCard({ goals, onGoals, statsParams }: { goals: Goals; onGoals: (g: Goals) => void; statsParams: StatsParams }) {
  const [draft, setDraft] = useState<{ onTime: string; floor: string; overrun: string } | null>(null);
  const onSave = () => {
    if (!draft) return;
    const onTime = parsePercentInput(draft.onTime);
    const floor = parsePercentInput(draft.floor);
    const overrun = parsePercentInput(draft.overrun);
    if (onTime == null || floor == null || overrun == null) {
      Alert.alert('目標格式不對', '請輸入 0~100 的百分比，例如 50、40、20');
      return;
    }
    if (floor > onTime) {
      Alert.alert('底線不能高於目標', '例如 準時率目標 50、底線 40');
      return;
    }
    const next = { onTimeRate: onTime, onTimeFloor: floor, overrunRate: overrun };
    onGoals(next);
    setDraft(null);
    void saveGoals(next);
  };
  return (
    <View style={S.card}>
      <Text style={S.h2}>目標</Text>
      {draft ? (
        <>
          <Field label="準時率目標 %" value={draft.onTime} onChange={(t) => setDraft({ ...draft, onTime: t })} />
          <Field label="準時率底線 %" value={draft.floor} onChange={(t) => setDraft({ ...draft, floor: t })} />
          <Field label="超時率上限 %" value={draft.overrun} onChange={(t) => setDraft({ ...draft, overrun: t })} />
          <View style={S.row}>
            <Btn style={{ flex: 1 }} small title="儲存" onPress={onSave} />
            <Btn style={{ flex: 1 }} small kind="ghost" title="取消" onPress={() => setDraft(null)} />
          </View>
        </>
      ) : (
        <>
          <KV k="準時目標" v={pctText(goals.onTimeRate)} color={C.green} />
          <KV k="準時底線" v={pctText(Math.min(goals.onTimeFloor, goals.onTimeRate))} color={C.yellow} />
          <KV k="超時上限" v={pctText(goals.overrunRate)} color={C.red} />
          <Btn
            small
            kind="ghost"
            title="改目標"
            onPress={() => setDraft({ onTime: r1(goals.onTimeRate), floor: r1(goals.onTimeFloor), overrun: r1(goals.overrunRate) })}
          />
        </>
      )}
      <Text style={S.small}>
        算法（依三期報酬單反推的近似）：彈性線＝預估 × {statsParams.graceFactor}；實際 ≤ 彈性線算準時；每單超時比例＝(實際−彈性線)/彈性線（0~
        {Math.round(statsParams.overrunCap * 100)}%）的平均＝超時率。取消單不計。每 14 天一期（台北時間週一 00:00 起）。
      </Text>
    </View>
  );
}

function BaselineCard({
  baseline,
  onBaseline,
  periodId,
  periodLabel,
}: {
  baseline: Baseline | null;
  onBaseline: (b: Baseline | null) => void;
  periodId: string;
  periodLabel: string;
}) {
  const [draft, setDraft] = useState<{ count: string; onTime: string; overrun: string; income: string } | null>(null);
  const onSave = () => {
    if (!draft) return;
    const count = /^\s*\d{1,4}\s*$/.test(draft.count) ? parseInt(draft.count, 10) : NaN;
    // 只補收入（單數留 0）時，準時率／超時率可以不填
    const onTime = draft.onTime.trim() === '' && count === 0 ? 0 : parsePercentInput(draft.onTime);
    const overrun = draft.overrun.trim() === '' && count === 0 ? 0 : parsePercentInput(draft.overrun);
    if (!(count >= 0 && count <= 2000) || onTime == null || overrun == null) {
      Alert.alert('補登格式不對', '單數 0~2000；準時率、超時率輸入 0~100 的百分比（照報酬單上的數字）');
      return;
    }
    const incomeText = draft.income.trim();
    const income = incomeText === '' ? 0 : /^\d{1,8}(?:\.\d+)?$/.test(incomeText) ? parseFloat(incomeText) : NaN;
    if (!Number.isFinite(income)) {
      Alert.alert('前幾天收入格式不對', '請輸入數字（元），或留空');
      return;
    }
    const next: Baseline | null =
      count > 0 || income > 0
        ? { periodId, count, onTimeRate: onTime, overrunRate: overrun, ...(income > 0 ? { income } : {}) }
        : null;
    onBaseline(next);
    setDraft(null);
    void saveBaseline(next, periodId);
  };
  const onClear = () => {
    onBaseline(null);
    setDraft(null);
    void saveBaseline(null, periodId);
  };
  return (
    <View style={S.card}>
      <View style={S.rowBetween}>
        <Text style={S.h2}>補登本期</Text>
        <Text style={S.label}>{periodLabel}</Text>
      </View>
      {draft ? (
        <>
          <Text style={S.small}>補登本期在 App 之前跑的成績（照報酬單／foodpanda App 上的數字）：</Text>
          <Field label="已完成單數" value={draft.count} onChange={(t) => setDraft({ ...draft, count: t })} pad="number-pad" />
          <Field label="準時率 %" value={draft.onTime} onChange={(t) => setDraft({ ...draft, onTime: t })} />
          <Field label="超時率 %" value={draft.overrun} onChange={(t) => setDraft({ ...draft, overrun: t })} />
          <Field label="前幾天收入 $" value={draft.income} onChange={(t) => setDraft({ ...draft, income: t })} placeholder="可空" />
          <View style={S.row}>
            <Btn style={{ flex: 1 }} small title="儲存補登" onPress={onSave} />
            <Btn style={{ flex: 1 }} small kind="ghost" title="取消" onPress={() => setDraft(null)} />
          </View>
          <Btn small kind="danger" title="清除補登" onPress={onClear} />
        </>
      ) : (
        <>
          {baseline ? (
            <>
              <KV k="單數" v={`${baseline.count} 單`} />
              <KV k="準時／超時" v={`${pctText(baseline.onTimeRate)}／${pctText(baseline.overrunRate)}`} />
              {baseline.income != null && <KV k="前幾天收入" v={`$${baseline.income}`} />}
            </>
          ) : (
            <Text style={S.small}>本期還沒補登。App 上線前本期已跑的單可以補進來，統計會加權合併；換期自動失效。</Text>
          )}
          <Btn
            small
            kind="ghost"
            title={baseline ? '修改補登' : '補登本期之前的成績'}
            onPress={() =>
              setDraft(
                baseline
                  ? {
                      count: String(baseline.count),
                      onTime: r1(baseline.onTimeRate),
                      overrun: r1(baseline.overrunRate),
                      income: baseline.income != null ? String(baseline.income) : '',
                    }
                  : { count: '', onTime: '', overrun: '', income: '' },
              )
            }
          />
        </>
      )}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  pad = 'decimal-pad',
}: {
  label: string;
  value: string;
  onChange: (t: string) => void;
  placeholder?: string;
  pad?: 'decimal-pad' | 'number-pad';
}) {
  return (
    <View style={S.row}>
      <Text style={[S.text, { flex: 1 }]}>{label}</Text>
      <TextInput
        style={[S.input, { width: 140 }]}
        keyboardType={pad}
        keyboardAppearance="dark"
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.dim}
        selectTextOnFocus
      />
    </View>
  );
}

const ADMIN_URL = 'wheat.yueshengift.xyz/pandatimer/admin';

function CloudSyncCard({ cloud }: { cloud: CloudSync }) {
  const st = cloud.status;
  const [code, setCode] = useState<string | null>(null); // null＝不在輸入中
  const [busy, setBusy] = useState(false);
  const editing = !st.paired || code != null;
  const onPair = () => {
    if (busy) return;
    setBusy(true);
    void cloud
      .pair(code ?? '')
      .then((r) => {
        if (r.ok) {
          setCode(null);
          Alert.alert('配對成功', `已同步：${r.message}`);
        } else Alert.alert('配對失敗', r.message);
      })
      .finally(() => setBusy(false));
  };
  const onUnpair = () => {
    Alert.alert('解除配對？', '這台手機不再自動同步（紀錄、伺服器資料都不會刪）。', [
      { text: '不要', style: 'cancel' },
      { text: '解除', style: 'destructive', onPress: () => void cloud.unpair() },
    ]);
  };
  const stateText = st.running ? '同步中…' : st.lastOk === true ? '正常' : st.lastOk === false ? '上次失敗' : '尚未同步';
  return (
    <View style={S.card}>
      <Text style={S.h2}>雲端同步</Text>
      {st.paired && (
        <>
          <KV k="狀態" v={stateText} color={st.lastOk === false && !st.running ? C.red : st.lastOk ? C.green : undefined} />
          <KV k="最後成功" v={st.lastOkAt ? formatTaipeiDateTime(st.lastOkAt) : '還沒有'} />
          {!!st.lastResult && <KV k="上次結果" v={st.lastResult} color={st.lastOk === false ? C.red : undefined} />}
          <KV k="待上傳" v={st.pending == null ? '—' : `${st.pending} 筆`} color={st.pending ? C.yellow : undefined} />
          <KV k="同步碼" v={`••••-••••-${st.codeTail ?? '????'}`} />
          <Btn title={st.running ? '同步中…' : '立即同步'} disabled={st.running} onPress={() => void cloud.syncNow()} />
        </>
      )}
      {editing ? (
        <>
          <Text style={S.small}>
            {st.paired ? '輸入新的同步碼（管理頁重設過的話）：' : `到管理頁 ${ADMIN_URL} 登入，看「App 同步碼」，輸入到這裡。配對後本機紀錄會全部上傳，之後自動同步（開 App、回到 App、改了紀錄 5 秒後、每 2 分鐘）。`}
          </Text>
          <TextInput
            style={S.input}
            value={code ?? ''}
            onChangeText={setCode}
            placeholder="XXXX-XXXX-XXXX"
            placeholderTextColor={C.dim}
            autoCapitalize="characters"
            autoCorrect={false}
            keyboardAppearance="dark"
          />
          <View style={S.row}>
            <Btn style={{ flex: 1 }} small title={busy ? '配對中…' : '配對並同步'} disabled={busy} onPress={onPair} />
            {st.paired && <Btn style={{ flex: 1 }} small kind="ghost" title="取消" onPress={() => setCode(null)} />}
          </View>
        </>
      ) : (
        <View style={S.row}>
          <Btn style={{ flex: 1 }} small kind="ghost" title="更換同步碼" onPress={() => setCode('')} />
          <Btn style={{ flex: 1 }} small kind="danger" title="解除配對" onPress={onUnpair} />
        </View>
      )}
    </View>
  );
}

function DiagCard({
  det,
  now,
  orders,
  laSupported,
  onStopDetect,
}: {
  det: DetectorStatus | null;
  now: number;
  orders: Order[];
  laSupported: boolean;
  onStopDetect: () => void;
}) {
  const beatAge = beatAgeSec(det, now);
  const offer = offerLine(det, now);
  const pw = det?.power;
  const powerText = pw ? powerLine(pw) : '此原生版本沒有提供（看動態島偵測卡上的「省電中」）';
  return (
    <View style={S.card}>
      <Text style={S.h2}>偵測診斷</Text>
      {!laSupported && <Text style={S.warn}>動態島不可用（需原生版本，且 設定 › 熊貓倒數 › 即時動態 要開啟）</Text>}
      {!det ? (
        <Text style={S.small}>原生偵測模組不存在（Expo Go / web / 舊版原生）。</Text>
      ) : (
        <>
          <KV k="狀態" v={det.armed ? '偵測中' : det.stoppedUnexpectedAt != null ? `已停止（${formatClock(det.stoppedUnexpectedAt)}）` : '未開始'} />
          <KV
            k="保活"
            v={`${det.armed ? det.keepAlive : '無'}${
              det.armed && det.keepAliveMode === 'location' && det.lastFixAt ? `（上次定位 ${formatClock(det.lastFixAt)}）` : ''
            }${det.keepAliveError ? `（${det.keepAliveError}）` : ''}`}
          />
          <KV
            k="最後心跳"
            v={det.lastBeatAt ? `${formatClock(det.lastBeatAt)}（${beatAge} 秒前）` : '尚未收到'}
            color={beatAge != null && beatAge > BEAT_STALE_SEC ? C.red : undefined}
          />
          {!!det.islandCheck && (
            <KV k="動態島" v={det.islandCheck} color={det.islandCheck.includes('✗') ? C.red : C.green} />
          )}
          <KV
            k="今日自動"
            v={`${countAutoToday(orders, now)} 單${
              det.lastOrderMinutes != null && det.lastOrderAt ? `・最近 ${det.lastOrderMinutes} 分 ${formatClock(det.lastOrderAt)}` : ''
            }`}
          />
          {!!offer && <KV k="接單判定" v={offer} />}
          {!!det.lastOrderHow && <KV k="最近開單" v={det.lastOrderHow} />}
          <KV k="省電/記憶體" v={powerText} />
          <KV k="設定版本" v={det.configVersion} />
          <KV k="回報" v={(telemetryLine(det) ?? '').replace(/^回報：/, '')} color={det.telemetryError ? C.red : undefined} />
          {det.armed && <Btn small kind="ghost" title="停止偵測" onPress={onStopDetect} />}
        </>
      )}
      <Text style={[S.small, { fontSize: F.min }]}>停止螢幕廣播：點左上角紅色時間 → 停止。</Text>
    </View>
  );
}
