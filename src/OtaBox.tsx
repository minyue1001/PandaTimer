import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { Btn } from './ui/common';
import { C, pressed, S } from './ui/theme';

const APP_VERSION = '1.1'; // 與 app.json runtimeVersion 一致

function fmt(d: Date | null | undefined): string {
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type OtaState = {
  /** __DEV__ 或 expo-updates 未啟用：不檢查 */
  hidden: boolean;
  /** 新版已下載，等使用者按「套用」 */
  ready: boolean;
  checking: boolean;
  /** 最近一次手動/自動檢查的結果文字 */
  note: string | null;
  err: string | null;
  check: () => void;
  apply: () => void;
};

/**
 * OTA 狀態（掛在 App 最上層，不管在哪個分頁都會檢查）：啟動與回前景自動檢查＋下載，**不自動 reload**；
 * 下載好 ready=true，由使用者按「有新版，點此套用」才 reloadAsync()。
 */
export function useOtaUpdate(): OtaState {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const busy = useRef(false);
  const hidden = __DEV__ || !Updates.isEnabled;

  const check = useCallback(() => {
    if (hidden || busy.current) return;
    busy.current = true;
    setChecking(true);
    void (async () => {
      try {
        const r = await Updates.checkForUpdateAsync();
        if (r.isAvailable) {
          await Updates.fetchUpdateAsync();
          setReady(true);
          setNote('新版已下載');
        } else {
          setNote(`已是最新（${fmt(new Date())} 檢查）`);
        }
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
        setChecking(false);
      }
    })();
  }, [hidden]);

  useEffect(() => {
    if (hidden) return;
    check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') check();
    });
    return () => sub.remove();
  }, [hidden, check]);

  const apply = useCallback(() => {
    void Updates.reloadAsync().catch((e) => setErr(String(e)));
  }, []);

  return { hidden, ready, checking, note, err, check, apply };
}

/** 首頁最上方：有新版才出現的一條粉色按鈕 */
export function OtaBanner({ ota }: { ota: OtaState }) {
  if (ota.hidden || !ota.ready) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={ota.apply}
      style={(st) => [S.btnSmall, S.btnPink, { flexDirection: 'row', gap: 8 }, pressed(st)]}
    >
      <Text style={[S.btnTextSmall, { color: C.onPink }]}>⬇️ 有新版，點此套用</Text>
    </Pressable>
  );
}

/** 設定頁：版本／更新 id／時間＋檢查/套用按鈕 */
export function OtaBox({ ota }: { ota: OtaState }) {
  const id = Updates.updateId ? Updates.updateId.slice(0, 8) : '內建';
  return (
    <View style={{ gap: 10 }}>
      <Text style={S.text}>
        版本 {APP_VERSION} · 更新 {id} · {fmt(Updates.createdAt)}
      </Text>
      {ota.hidden ? (
        <Text style={S.small}>開發模式或未啟用 OTA：不檢查更新</Text>
      ) : (
        <>
          {ota.ready ? (
            <>
              <Btn title="有新版，點此套用" onPress={ota.apply} />
              <Text style={S.small}>套用時 App 會重開，進行中的倒數不受影響</Text>
            </>
          ) : (
            <Btn kind="ghost" small title={ota.checking ? '檢查中…' : '檢查更新'} disabled={ota.checking} onPress={ota.check} />
          )}
          {!!ota.note && <Text style={S.small}>{ota.note}</Text>}
          {!!ota.err && <Text style={[S.small, { color: C.red }]}>檢查更新失敗：{ota.err.slice(0, 80)}</Text>}
        </>
      )}
    </View>
  );
}
