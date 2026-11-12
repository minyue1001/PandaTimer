// 訂單雲端同步（有副作用：AsyncStorage、fetch、AppState）。純邏輯在 src/sync.ts，伺服器在 server/orders.mjs。
// 時機：App 啟動、回前景、本機紀錄/補登變動後 5 秒（debounce）、前景每 2 分鐘；離線就留著（待上傳由版本差推得），下次再送。
// 同步碼只存在這台手機的 AsyncStorage（pandatimer.sync.code.v1），不進 repo、不寫 log。
import Constants from 'expo-constants';
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { cleanupEnded } from './controller';
import type { Order } from './orders';
import { periodOf } from './stats';
import { loadBaselineSlot, saveBaselineSlot } from './statsConfig';
import {
  getOrders,
  loadSyncCode,
  loadSyncState,
  loadTombstones,
  mutate,
  onLocalChange,
  saveSyncCode,
  saveSyncState,
  updateTombstones,
} from './store';
import {
  compactPushed,
  expireTombstones,
  markPushed,
  mergeServerBaselines,
  mergeServerOrders,
  needsFullResync,
  normalizeSyncCode,
  parseSyncResponse,
  pendingBaselines,
  pendingOrders,
  PERIODIC_MS,
  PUSH_BATCH,
  SyncScheduler,
  syncErrorText,
  syncUrlFrom,
  type OrderMerge,
  type SyncResponse,
  type SyncState,
} from './sync';

export type CloudSyncStatus = {
  paired: boolean;
  /** 同步碼末 4 碼（顯示用） */
  codeTail: string | null;
  running: boolean;
  lastAttemptAt?: number;
  lastOkAt?: number;
  lastResult?: string;
  lastOk?: boolean;
  /** 待上傳筆數（null＝還沒算） */
  pending: number | null;
  /** 伺服器改了本期補登 → +1（App 重新讀補登） */
  baselineRev: number;
};

const SYNC_URL = syncUrlFrom((Constants.expoConfig?.extra as { configUrl?: unknown } | undefined)?.configUrl);
const TIMEOUT_MS = 15_000;
const MAX_ROUNDS = 40;

let status: CloudSyncStatus = { paired: false, codeTail: null, running: false, pending: null, baselineRev: 0 };
const statusListeners = new Set<(s: CloudSyncStatus) => void>();
function setStatus(patch: Partial<CloudSyncStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l(status));
}
const tailOf = (code: string | null) => (code ? normalizeSyncCode(code).slice(-4) || null : null);

class SyncHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(syncErrorText(status));
    this.status = status;
  }
}

async function postSync(url: string, code: string, body: unknown): Promise<SyncResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-pt-sync': code },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new SyncHttpError(res.status);
    const parsed = parseSyncResponse(await res.json());
    if (!parsed) throw new Error('伺服器回應格式不對');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

type RunResult = { ok: boolean; message: string };

async function refreshPending(state?: SyncState) {
  try {
    const s = state ?? (await loadSyncState());
    const n = pendingOrders(await getOrders(), await loadTombstones(), s).length + pendingBaselines(await loadBaselineSlot(), s).length;
    setStatus({ pending: n });
  } catch {
    /* 顯示用，算不出來就算了 */
  }
}

/** 跑一次完整同步（上傳全部待上傳的、分批；拉完伺服器的變更）。codeOverride＝配對中的新碼（成功才存） */
async function runSyncOnce(codeOverride?: string): Promise<RunResult> {
  if (!SYNC_URL) return { ok: false, message: '這個版本沒有同步伺服器網址' };
  const code = codeOverride ?? (await loadSyncCode());
  if (!code) return { ok: false, message: '尚未配對' };
  let state = await loadSyncState();
  const startedAt = Date.now();
  let uploaded = 0;
  let downloaded = 0;
  let invalid = 0;
  let codeSaved = !codeOverride;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const orders = await getOrders();
      const tombs = await loadTombstones();
      const slot = await loadBaselineSlot();
      const pendO = pendingOrders(orders, tombs, state);
      const pendB = pendingBaselines(slot, state);
      const sendO = pendO.slice(0, PUSH_BATCH);
      const resp = await postSync(SYNC_URL, code, { since: state.since, changes: { orders: sendO, baselines: pendB } });
      if (!codeSaved) {
        await saveSyncCode(code);
        codeSaved = true;
        setStatus({ paired: true, codeTail: tailOf(code) });
      }
      if (needsFullResync(state, resp)) {
        // 伺服器資料庫換過 → 忘掉已知版本，從頭全部重傳＋重拉
        state = { ...state, dbId: resp.dbId, since: 0, pushedOrders: {}, pushedBaselines: {} };
        await saveSyncState(state);
        continue;
      }
      state = markPushed({ ...state, dbId: resp.dbId }, sendO, pendB);
      uploaded += sendO.length + pendB.length;
      invalid += resp.invalid;

      if (resp.orders.length) {
        let ended: Order[] = [];
        await updateTombstones(async (t) => {
          let merged: OrderMerge | null = null;
          await mutate(
            (list) => {
              merged = mergeServerOrders(list, t, state.pushedOrders, resp.orders);
              return { orders: merged.orders };
            },
            { fromSync: true },
          );
          const m = merged as OrderMerge | null;
          if (!m) return { tombs: t };
          state = { ...state, pushedOrders: m.pushedOrders };
          ended = m.ended;
          downloaded += m.applied;
          return { tombs: m.tombs };
        });
        // 伺服器把進行中的單改成已送達/取消/刪除 → 收動態島、取消提醒（同刪除流程）
        if (ended.length) await cleanupEnded(ended).catch(() => undefined);
      }
      if (resp.baselines.length) {
        const mb = mergeServerBaselines(await loadBaselineSlot(), state.pushedBaselines, resp.baselines, periodOf(Date.now()).id);
        state = { ...state, pushedBaselines: mb.pushedBaselines };
        if (mb.slot) {
          await saveBaselineSlot(mb.slot);
          downloaded += 1;
          setStatus({ baselineRev: status.baselineRev + 1 });
        }
      }
      state = { ...state, since: resp.now };
      await saveSyncState(state);
      if (!resp.more && pendO.length <= sendO.length) break;
    }
    const orders = await getOrders();
    await updateTombstones((t) => ({ tombs: expireTombstones(t, state, true, Date.now()) }));
    state = { ...state, pushedOrders: compactPushed(state.pushedOrders, orders, await loadTombstones()) };
    const message = `上傳 ${uploaded}・下載 ${downloaded}${invalid ? `・${invalid} 筆格式不符略過` : ''}`;
    state = { ...state, lastAttemptAt: startedAt, lastOkAt: Date.now(), lastResult: message, lastOk: true };
    await saveSyncState(state);
    await refreshPending(state);
    return { ok: true, message };
  } catch (e) {
    const message =
      e instanceof SyncHttpError
        ? e.message
        : e instanceof Error && e.name === 'AbortError'
          ? '連線逾時，稍後自動再試'
          : e instanceof Error && e.message === '伺服器回應格式不對'
            ? e.message
            : '連不上伺服器（離線？），稍後自動再試';
    if (codeSaved) {
      state = { ...state, lastAttemptAt: startedAt, lastResult: message, lastOk: false };
      await saveSyncState(state).catch(() => undefined);
    }
    await refreshPending(state);
    return { ok: false, message };
  }
}

// ── 排程（單例） ──
let pairCode: string | null = null;
let lastRun: RunResult | null = null;
const scheduler = new SyncScheduler(async () => {
  setStatus({ running: true });
  try {
    lastRun = await runSyncOnce(pairCode ?? undefined);
    if (!pairCode || lastRun.ok) {
      const s = await loadSyncState();
      setStatus({ lastAttemptAt: s.lastAttemptAt, lastOkAt: s.lastOkAt, lastResult: s.lastResult, lastOk: s.lastOk });
    }
  } finally {
    setStatus({ running: false });
  }
});

let started = 0;
let stopAll: (() => void) | null = null;
function start(): () => void {
  started += 1;
  if (started === 1) {
    let alive = true;
    void (async () => {
      const [code, s] = await Promise.all([loadSyncCode(), loadSyncState()]);
      if (!alive) return;
      setStatus({ paired: !!code, codeTail: tailOf(code), lastAttemptAt: s.lastAttemptAt, lastOkAt: s.lastOkAt, lastResult: s.lastResult, lastOk: s.lastOk });
      void refreshPending(s);
      if (code) void scheduler.now(); // App 啟動
    })();
    const offLocal = onLocalChange(() => {
      if (!status.paired) return;
      scheduler.poke(); // 訂單變動後 5 秒
      void refreshPending();
    });
    const appSub = AppState.addEventListener('change', (st) => {
      if (st === 'active' && status.paired) void scheduler.now(); // 回前景
    });
    const timer = setInterval(() => {
      if (status.paired && AppState.currentState === 'active') void scheduler.now(); // 前景每 2 分鐘
    }, PERIODIC_MS);
    stopAll = () => {
      alive = false;
      offLocal();
      appSub.remove();
      clearInterval(timer);
      scheduler.dispose();
    };
  }
  return () => {
    started -= 1;
    if (started === 0) stopAll?.();
  };
}

/** 立即同步（設定頁按鈕） */
export async function syncNow(): Promise<RunResult> {
  await scheduler.now();
  return lastRun ?? { ok: false, message: '尚未配對' };
}

/** 配對：碼正確（伺服器 200）才存；首次配對會把本機全部紀錄上傳 */
export async function pairWithCode(text: string): Promise<RunResult> {
  const code = normalizeSyncCode(text);
  if (!code) return { ok: false, message: '同步碼格式不對（管理頁上的 12 碼，例如 ABCD-EFGH-JKLM）' };
  pairCode = code;
  try {
    await scheduler.now();
    return lastRun ?? { ok: false, message: '同步沒有執行' };
  } finally {
    pairCode = null;
  }
}

/** 解除配對：刪掉本機同步碼（紀錄與伺服器資料都不動） */
export async function unpair(): Promise<void> {
  await saveSyncCode(null);
  setStatus({ paired: false, codeTail: null });
}

export function useCloudSync() {
  const [st, setSt] = useState<CloudSyncStatus>(status);
  useEffect(() => {
    statusListeners.add(setSt);
    setSt(status);
    const stop = start();
    return () => {
      statusListeners.delete(setSt);
      stop();
    };
  }, []);
  const now = useCallback(() => syncNow(), []);
  const pair = useCallback((code: string) => pairWithCode(code), []);
  const off = useCallback(() => unpair(), []);
  return { status: st, syncNow: now, pair, unpair: off };
}
export type CloudSync = ReturnType<typeof useCloudSync>;
