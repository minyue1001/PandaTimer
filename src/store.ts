import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Order } from './orders';
import { parseTombstones, type Tombstones } from './prune';

const KEY = 'pandatimer.orders.v1';
const MAX_KEEP = 1000;

let cache: Order[] | null = null;
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<(orders: Order[]) => void>();

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

/** 序列化的修改：deep link 與按鈕同時觸發也不會互相覆蓋 */
export function mutate<T = void>(fn: (orders: Order[]) => { orders: Order[]; result?: T }): Promise<T | undefined> {
  const run = chain.then(async () => {
    const current = await load();
    const { orders, result } = fn(current);
    cache = orders.slice(0, MAX_KEEP);
    listeners.forEach((l) => l(cache as Order[]));
    await AsyncStorage.setItem(KEY, JSON.stringify(cache));
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}

const TOMB_KEY = 'pandatimer.tombstones.v1';

/** 已刪訂單的墓碑（防止原生事件佇列把它復活，保留 7 天；過期清理在 prune.addTombstones） */
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
