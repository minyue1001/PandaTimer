// v1.4 拒單紀錄（App 端純邏輯；抓取在 src/syncClient.ts，伺服器演算法在 server/reconcile.mjs declinedOffers）。
// 拒單＝extension 判定未接的邀請（去掉誤讀重複、其實有接/之後按「有接」的）。資料只在伺服器 telemetry（留 14 天），
// App 不存檔：啟動/回前景抓本期，失敗就不顯示。
import { normalizeStore, type Order } from './orders.ts';
import { taipeiDate } from './stats.ts';

export type DeclinedOffer = {
  /** 邀請出現時間（ms） */
  t: number;
  min: number;
  amt: number | null;
  km: number | null;
  store: string | null;
  /** rejected | timeout | superseded | stopped | replaced */
  reason: string;
};

export const DECLINED_REASON_TEXT: Readonly<Record<string, string>> = {
  rejected: '拒絕',
  timeout: '逾時',
  superseded: '未接',
  stopped: '偵測停止',
  replaced: '換單',
};

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** /api/sync → /api/declined（同一台伺服器） */
export function declinedUrlFrom(syncUrl: string | null): string | null {
  return syncUrl && /\/api\/sync$/.test(syncUrl) ? syncUrl.replace(/\/api\/sync$/, '/api/declined') : null;
}

/** 伺服器回應（不可信）→ 清單（新→舊）；格式不對 → null */
export function parseDeclinedResponse(raw: unknown): DeclinedOffer[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const list = (raw as { declined?: unknown }).declined;
  if (!Array.isArray(list)) return null;
  const out: DeclinedOffer[] = [];
  for (const x of list.slice(0, 2000)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (!isNum(r.t) || !isNum(r.min) || r.min < 1 || r.min > 180) continue;
    out.push({
      t: r.t,
      min: r.min,
      amt: isNum(r.amt) ? r.amt : null,
      km: isNum(r.km) ? r.km : null,
      store: normalizeStore(r.store) ?? null,
      reason: typeof r.reason === 'string' ? r.reason.slice(0, 16) : 'rejected',
    });
  }
  return out.sort((a, b) => b.t - a.t);
}

/** 台北日 YYYY-MM-DD → 那天的拒單（新→舊） */
export function declinedByDay(list: readonly DeclinedOffer[]): Map<string, DeclinedOffer[]> {
  const m = new Map<string, DeclinedOffer[]>();
  for (const d of [...list].sort((a, b) => b.t - a.t)) {
    const k = taipeiDate(d.t);
    const cur = m.get(k);
    if (cur) cur.push(d);
    else m.set(k, [d]);
  }
  return m;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function clock(ms: number): string {
  const t = new Date(ms + 8 * 3_600_000);
  return `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}`;
}
const moneyText = (x: number) => `$${Math.round(x * 100) / 100}`;

/** 一列：「19:17・7 分・$45・0.9 公里・麥當勞 (德中店)・未接」 */
export function declinedRowText(d: DeclinedOffer): string {
  const parts = [clock(d.t), `${d.min} 分`];
  if (d.amt != null) parts.push(moneyText(d.amt));
  if (d.km != null) parts.push(`${d.km} 公里`);
  if (d.store) parts.push(d.store);
  parts.push(DECLINED_REASON_TEXT[d.reason] ?? '未接');
  return parts.join('・');
}

export type Participation = { accepted: number; declined: number; rate: number };

/**
 * 參與率（估計）：接 A／派 A+D。A＝範圍內接單時間的 App 紀錄（未取消；含進行中、不計時效），D＝範圍內拒單。
 * 拒單只在開偵測時才有（手動開的單沒有對應的邀請紀錄）→ 只是「約」。A+D＝0 → null。
 */
export function participation(
  orders: readonly Pick<Order, 'acceptedAt' | 'status'>[],
  declined: readonly Pick<DeclinedOffer, 't'>[],
  range: { start: number; end: number },
): Participation | null {
  const inR = (ms: number) => ms >= range.start && ms < range.end;
  const a = orders.filter((o) => o.status !== 'canceled' && inR(o.acceptedAt)).length;
  const d = declined.filter((x) => inR(x.t)).length;
  if (a + d === 0) return null;
  return { accepted: a, declined: d, rate: a / (a + d) };
}

/** 首頁一行：「參與率約 69%（接 9／派 13）」 */
export function participationText(p: Participation): string {
  return `參與率約 ${Math.round(p.rate * 100)}%（接 ${p.accepted}／派 ${p.accepted + p.declined}）`;
}
