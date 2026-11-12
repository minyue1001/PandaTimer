import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Order } from './orders';
import { parseTombstones, type Tombstones } from './prune';
import { parseSyncState, stampChanges, type SyncState } from './sync';

const KEY = 'pandatimer.orders.v1';
const MAX_KEEP = 1000;

let cache: Order[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<(orders: Order[]) => void>();
/** 本機修改（非雲端同步合併）→ 雲端同步排程（5 秒 debounce） */
const localChangeListeners = new Set<() => void>();

async function load(): Promise<Order[]> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as Order[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function subscribe(fn: (orders: Order[]) => void): () => void {
  listeners.add(fn);
  if (cache) fn(cache);
  else void load().then((o) => fn(o));
  return () => {
    listeners.delete(fn);
  };
}

export function getOrders(): Promise<Order[]> {
  return load();
}

/** 本機紀錄或補登被使用者/原生改動（雲端同步合併進來的不算） */
export function onLocalChange(fn: () => void): () => void {
  localChangeListeners.add(fn);
  return () => {
    localChangeListeners.delete(fn);
  };
}
export function notifyLocalChange(): void {
  localChangeListeners.forEach((l) => l());
}

/**
 * 序列化的修改：deep link 與按鈕同時觸發也不會互相覆蓋。
 * 本機修改：新單/同步欄位有變的單自動蓋 updatedAt（雲端同步 LWW 用），並通知同步排程；
 * opts.fromSync＝雲端同步合併伺服器版本（updatedAt 照伺服器、不觸發同步）。
 */
export function mutate<T = void>(
  fn: (orders: Order[]) => { orders: Order[]; result?: T },
  opts?: { fromSync?: boolean },
): Promise<T | undefined> {
  const run = chain.then(async () => {
    const current = await load();
    const { orders, result } = fn(current);
    let next = orders;
    let changed = false;
    if (!opts?.fromSync) ({ orders: next, changed } = stampChanges(current, orders, Date.now()));
    cache = next.slice(0, MAX_KEEP);
    listeners.forEach((l) => l(cache as Order[]));
    await AsyncStorage.setItem(KEY, JSON.stringify(cache));
    if (changed) notifyLocalChange();
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}

const TOMB_KEY = 'pandatimer.tombstones.v1';

/** 已刪訂單的墓碑（防止原生事件佇列把它復活，保留 7 天；過期清理在 prune.addTombstones；雲端同步也靠它送刪除） */
export async function loadTombstones(): Promise<Tombstones> {
  try {
    const raw = await AsyncStorage.getItem(TOMB_KEY);
    return raw ? parseTombstones(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export async function saveTombstones(t: Tombstones): Promise<void> {
  await AsyncStorage.setItem(TOMB_KEY, JSON.stringify(t));
}

let tombChain: Promise<unknown> = Promise.resolve();
/** 墓碑的讀改寫序列化（刪除紀錄與雲端同步合併可能同時發生） */
export function updateTombstones<T = void>(fn: (t: Tombstones) => Promise<{ tombs: Tombstones; result?: T }> | { tombs: Tombstones; result?: T }): Promise<T | undefined> {
  const run = tombChain.then(async () => {
    const { tombs, result } = await fn(await loadTombstones());
    await saveTombstones(tombs);
    return result;
  });
  tombChain = run.catch(() => undefined);
  return run;
}

// ── 雲端同步狀態（同步碼另存；狀態＝游標＋伺服器已知版本） ──
const SYNC_STATE_KEY = 'pandatimer.sync.state.v1';
const SYNC_CODE_KEY = 'pandatimer.sync.code.v1';

export async function loadSyncState(): Promise<SyncState> {
  try {
    return parseSyncState(await AsyncStorage.getItem(SYNC_STATE_KEY));
  } catch {
    return parseSyncState(null);
  }
}
export async function saveSyncState(s: SyncState): Promise<void> {
  await AsyncStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
}
export async function loadSyncCode(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SYNC_CODE_KEY);
  } catch {
    return null;
  }
}
export async function saveSyncCode(code: string | null): Promise<void> {
  if (code) await AsyncStorage.setItem(SYNC_CODE_KEY, code);
  else await AsyncStorage.removeItem(SYNC_CODE_KEY);
}
