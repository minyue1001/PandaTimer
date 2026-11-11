import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Order } from './orders';

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
