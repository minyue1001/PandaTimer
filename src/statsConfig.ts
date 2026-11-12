// v0.7（需求 F）：App（JS）端讀遠端設定的 stats 區塊、目標存取（AsyncStorage）。純邏輯在 src/stats.ts。
// 遠端設定網址＝app.json extra.configUrl（原生也用同一個）；逾時 3 秒，失敗用上次快取或預設。
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { validateConfig } from './remoteConfig';
import { waitSecFor } from './unconfirmedOffers';
import { DEFAULT_PAY, type PayParams } from './earnings';
import {
  BASELINE_STORAGE_KEY,
  DEFAULT_GOALS,
  DEFAULT_STATS,
  GOALS_STORAGE_KEY,
  parseBaseline,
  parseGoals,
  type Baseline,
  type Goals,
  type StatsParams,
} from './stats';

const STATS_CACHE_KEY = 'pandatimer.statsParams.v1';
const PAY_CACHE_KEY = 'pandatimer.payParams.v1';
const OFFER_WINDOW_CACHE_KEY = 'pandatimer.offerWindowSec.v1';

/** v0.10 未確認邀請的等待秒數（decideWindowSec+10）；讀不到快取 → 35 */
export async function loadCachedOfferWaitSec(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(OFFER_WINDOW_CACHE_KEY);
    return waitSecFor(raw == null ? undefined : Number(raw));
  } catch {
    return waitSecFor(undefined);
  }
}

/** 遠端設定 JSON（不可信）→ stats 參數（缺漏/不合法 → 預設） */
export function statsFromConfig(raw: unknown): StatsParams {
  return validateConfig(raw).config.stats;
}

export async function loadCachedStatsParams(): Promise<StatsParams> {
  try {
    const raw = await AsyncStorage.getItem(STATS_CACHE_KEY);
    return raw ? statsFromConfig({ stats: JSON.parse(raw) }) : { ...DEFAULT_STATS };
  } catch {
    return { ...DEFAULT_STATS };
  }
}

/** 遠端設定 JSON（不可信）→ pay 參數（缺漏/不合法 → 預設） */
export function payFromConfig(raw: unknown): PayParams {
  return validateConfig(raw).config.pay;
}

export async function loadCachedPayParams(): Promise<PayParams> {
  try {
    const raw = await AsyncStorage.getItem(PAY_CACHE_KEY);
    return raw ? payFromConfig({ pay: JSON.parse(raw) }) : { ...DEFAULT_PAY };
  } catch {
    return { ...DEFAULT_PAY };
  }
}

/** 抓 /api/config（3 秒逾時）→ stats／pay 參數並快取；失敗回 null（呼叫端沿用快取） */
export async function fetchRemoteParams(): Promise<{ stats: StatsParams; pay: PayParams; offerWaitSec: number } | null> {
  const url = (Constants.expoConfig?.extra as { configUrl?: unknown } | undefined)?.configUrl;
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const stats = statsFromConfig(body);
    const pay = payFromConfig(body);
    await AsyncStorage.setItem(STATS_CACHE_KEY, JSON.stringify(stats)).catch(() => undefined);
    await AsyncStorage.setItem(PAY_CACHE_KEY, JSON.stringify(pay)).catch(() => undefined);
    const window = validateConfig(body).config.offer.decideWindowSec;
    await AsyncStorage.setItem(OFFER_WINDOW_CACHE_KEY, String(window)).catch(() => undefined);
    return { stats, pay, offerWaitSec: waitSecFor(window) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadGoals(): Promise<Goals> {
  try {
    return parseGoals(await AsyncStorage.getItem(GOALS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_GOALS };
  }
}

export async function saveGoals(goals: Goals): Promise<void> {
  await AsyncStorage.setItem(GOALS_STORAGE_KEY, JSON.stringify(parseGoals(goals)));
}

/** 本期補登（綁期別；不同期 → null） */
export async function loadBaseline(periodId: string): Promise<Baseline | null> {
  try {
    return parseBaseline(await AsyncStorage.getItem(BASELINE_STORAGE_KEY), periodId);
  } catch {
    return null;
  }
}

export async function saveBaseline(b: Baseline | null): Promise<void> {
  if (!b) await AsyncStorage.removeItem(BASELINE_STORAGE_KEY);
  else await AsyncStorage.setItem(BASELINE_STORAGE_KEY, JSON.stringify(b));
}
