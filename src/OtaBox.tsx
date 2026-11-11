import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';

const APP_VERSION = '0.5'; // 與 app.json runtimeVersion 一致

function fmt(d: Date | null | undefined): string {
  if (!d) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 底部小字：版本／更新 id／時間；回前景檢查 OTA，下載完只顯示按鈕，不自動 reload。 */
export function OtaBox() {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const busy = useRef(false);
  const hidden = __DEV__ || !Updates.isEnabled;

  useEffect(() => {
    if (hidden) return;
    const check = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await Updates.checkForUpdateAsync();
        if (r.isAvailable) {
          await Updates.fetchUpdateAsync();
          setReady(true);
        }
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
      }
    };
    void check();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void check();
    });
    return () => sub.remove();
  }, [hidden]);

  if (hidden) return null;
  const id = Updates.updateId ? Updates.updateId.slice(0, 8) : '內建';
  return (
    <View style={styles.box}>
      {ready && (
        <>
          <Pressable
            style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.7 : 1 }]}
            onPress={() => void Updates.reloadAsync().catch((e) => setErr(String(e)))}
          >
            <Text style={styles.btnText}>有新版，點此套用</Text>
          </Pressable>
          <Text style={styles.small}>套用時 App 會重開，進行中的倒數不受影響</Text>
        </>
      )}
      <Text style={styles.small}>
        版本 {APP_VERSION} · 更新 {id} · {fmt(Updates.createdAt)}
      </Text>
      {!!err && <Text style={styles.small}>檢查更新失敗：{err.slice(0, 80)}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: 6, marginTop: 8 },
  btn: { backgroundColor: '#D70F64', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 20 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  small: { fontSize: 12, color: '#999', textAlign: 'center' },
});
