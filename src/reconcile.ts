// 今日對帳（App 端純邏輯；伺服器演算法在 server/reconcile.mjs，測試 test/reconcile.test.mjs）。
// 流程：使用者輸入平台當日單數/金額/小費 → syncClient.requestReconcile（先同步再 POST /api/reconcile）
//       → 這裡解析回應、讓使用者勾選/修改 → buildOps 產生操作 → applyOps 在本機紀錄套用（controller.applyReconcile）→ 雲端同步。
import { clampEstimate, normalizeTip, type Order } from './orders.ts';

export type ProposalType = 'add' | 'restore' | 'tip' | 'review';
export type ProposalFields = {
  acceptedAt?: number | null;
  deliveredAt?: number | null;
  estimateMin?: number | null;
  amount?: number | null;
  tip?: number | null;
  note?: string;
  status?: string;
};
export type Proposal = {
  id: string;
  type: ProposalType;
  confidence: 'high' | 'low';
  text: string;
  orderId?: string | null;
  fields: ProposalFields;
  needs: string[];
  options?: { label: string; fields: ProposalFields }[];
  actions?: ('delete' | 'cancel' | 'edit')[];
  alternativeTo?: string | null;
};
export type ReconcileResult = {
  date: string;
  until: number;
  app: { count: number; amount: number; tips: number };
  platform: { count: number; amount: number; tips: number | null };
  diff: { count: number; amount: number; tips: number | null };
  proposals: Proposal[];
  info: string[];
};

const TAIPEI = 8 * 3_600_000;
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const numOrNull = (x: unknown) => (isNum(x) ? x : null);

/** /api/sync 網址 → /api/reconcile */
export function reconcileUrlFrom(syncUrl: string | null): string | null {
  return syncUrl && /\/api\/sync$/.test(syncUrl) ? syncUrl.replace(/\/api\/sync$/, '/api/reconcile') : null;
}

/** 台北日期 YYYY-MM-DD（offsetDays＝-1 → 昨天） */
export function taipeiDate(now: number, offsetDays = 0): string {
  return new Date(now + TAIPEI + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** 台北 HH:mm:ss */
export function clockText(ms: number | null | undefined): string {
  if (!isNum(ms)) return '';
  return new Date(ms + TAIPEI).toISOString().slice(11, 19);
}

/** 使用者輸入的時間（HH:mm 或 HH:mm:ss，台北）→ 該日的 ms；不合法 → null */
export function parseClock(text: string, date: string): number | null {
  const m = /^\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?\s*$/.exec(text);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3] ?? 0);
  if (h > 23 || mi > 59 || s > 59) return null;
  return Date.parse(`${date}T00:00:00Z`) - TAIPEI + ((h * 60 + mi) * 60 + s) * 1000;
}

/** 金額輸入（可帶 $、逗號）→ 數字；空字串 → null；不合法 → NaN */
export function parseMoney(text: string): number | null {
  const t = String(text ?? '').trim().replace(/^\$/, '').replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return NaN;
  return Number(t);
}

const pickFields = (x: unknown): ProposalFields => {
  const f = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  return {
    acceptedAt: numOrNull(f.acceptedAt),
    deliveredAt: numOrNull(f.deliveredAt),
    estimateMin: numOrNull(f.estimateMin),
    amount: numOrNull(f.amount),
    tip: numOrNull(f.tip),
    ...(typeof f.note === 'string' ? { note: f.note.slice(0, 100) } : {}),
    ...(typeof f.status === 'string' ? { status: f.status } : {}),
  };
};

/** 伺服器回應（不可信）→ ReconcileResult；格式不對 → null */
export function parseReconcileResponse(x: unknown): ReconcileResult | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const app = r.app as Record<string, unknown> | undefined;
  const plat = r.platform as Record<string, unknown> | undefined;
  const diff = r.diff as Record<string, unknown> | undefined;
  if (typeof r.date !== 'string' || !app || !plat || !diff || !Array.isArray(r.proposals)) return null;
  if (!isNum(app.count) || !isNum(app.amount) || !isNum(diff.count) || !isNum(diff.amount)) return null;
  const types: ProposalType[] = ['add', 'restore', 'tip', 'review'];
  const proposals: Proposal[] = [];
  for (const p of r.proposals as unknown[]) {
    if (!p || typeof p !== 'object') continue;
    const q = p as Record<string, unknown>;
    if (typeof q.id !== 'string' || !types.includes(q.type as ProposalType) || typeof q.text !== 'string') continue;
    proposals.push({
      id: q.id,
      type: q.type as ProposalType,
      confidence: q.confidence === 'high' ? 'high' : 'low',
      text: q.text,
      orderId: typeof q.orderId === 'string' ? q.orderId : null,
      fields: pickFields(q.fields),
      needs: Array.isArray(q.needs) ? q.needs.filter((n): n is string => typeof n === 'string') : [],
      ...(Array.isArray(q.options)
        ? {
            options: (q.options as unknown[])
              .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string')
              .map((o) => ({ label: o.label as string, fields: pickFields(o.fields) })),
          }
        : {}),
      ...(Array.isArray(q.actions)
        ? { actions: (q.actions as unknown[]).filter((a): a is 'delete' | 'cancel' | 'edit' => a === 'delete' || a === 'cancel' || a === 'edit') }
        : {}),
      alternativeTo: typeof q.alternativeTo === 'string' ? q.alternativeTo : null,
    });
  }
  return {
    date: r.date,
    until: isNum(r.until) ? r.until : 0,
    app: { count: app.count, amount: app.amount, tips: isNum(app.tips) ? app.tips : 0 },
    platform: { count: isNum(plat.count) ? plat.count : 0, amount: isNum(plat.amount) ? plat.amount : 0, tips: numOrNull(plat.tips) },
    diff: { count: diff.count, amount: diff.amount, tips: numOrNull(diff.tips) },
    proposals,
    info: Array.isArray(r.info) ? r.info.filter((s): s is string => typeof s === 'string') : [],
  };
}

/** 使用者在畫面上改的值（文字）；沒改＝用提議值 */
export type ProposalEdit = {
  accepted?: string;
  delivered?: string;
  minutes?: string;
  amount?: string;
  tip?: string;
  /** options 的第幾個（tip 拆法） */
  option?: number;
  /** review：要做的動作 */
  action?: 'delete' | 'cancel' | 'edit';
};

/** 畫面初始值（文字） */
export function initialEdit(p: Proposal): ProposalEdit {
  const f = p.options?.length ? { ...p.fields, ...p.options[0].fields } : p.fields;
  return {
    accepted: clockText(f.acceptedAt),
    delivered: clockText(f.deliveredAt),
    minutes: isNum(f.estimateMin) ? String(f.estimateMin) : '',
    amount: isNum(f.amount) ? String(f.amount) : '',
    tip: isNum(f.tip) ? String(f.tip) : '',
    ...(p.options?.length ? { option: 0 } : {}),
    ...(p.actions?.length ? { action: p.actions[0] } : {}),
  };
}

export type ReconcileOp =
  | { kind: 'add'; acceptedAt: number; deliveredAt: number; estimateMin: number; amount: number; tip?: number; note: string }
  | { kind: 'restore'; id: string; deliveredAt: number }
  | { kind: 'tip'; id: string; tip: number }
  | { kind: 'edit'; id: string; estimateMin?: number; amount?: number }
  | { kind: 'cancel'; id: string }
  | { kind: 'delete'; id: string };

/** 勾選的提議＋使用者修改 → 操作；任何一條不合法 → errors（不套用任何東西） */
export function buildOps(
  date: string,
  selected: readonly Proposal[],
  edits: Readonly<Record<string, ProposalEdit>>,
): { ops: ReconcileOp[]; errors: string[] } {
  const ops: ReconcileOp[] = [];
  const errors: string[] = [];
  for (const p of selected) {
    const e = { ...initialEdit(p), ...(edits[p.id] ?? {}) };
    const label = p.text.slice(0, 18);
    if (p.type === 'add') {
      const acc = parseClock(e.accepted ?? '', date);
      let del = parseClock(e.delivered ?? '', date);
      if (acc != null && del != null && del < acc) del += 86_400_000; // 跨午夜送達
      const min = Number(e.minutes);
      const amt = parseMoney(e.amount ?? '');
      const tip = parseMoney(e.tip ?? '');
      if (acc == null || del == null) errors.push(`${label}…：接單/送達時間要填 HH:mm`);
      else if (del - acc > 3 * 3_600_000) errors.push(`${label}…：送達比接單晚超過 3 小時`);
      else if (!Number.isFinite(min) || min < 1 || min > 180) errors.push(`${label}…：分鐘要填 1~180`);
      else if (amt == null || !Number.isFinite(amt)) errors.push(`${label}…：金額要填`);
      else if (tip != null && !Number.isFinite(tip)) errors.push(`${label}…：小費格式不對`);
      else {
        const t = normalizeTip(tip ?? undefined);
        ops.push({
          kind: 'add',
          acceptedAt: acc,
          deliveredAt: del,
          estimateMin: clampEstimate(min),
          amount: Math.round(amt * 100) / 100,
          ...(t != null ? { tip: t } : {}),
          note: p.fields.note ?? '對帳補登',
        });
      }
    } else if (p.type === 'restore') {
      const del = parseClock(e.delivered ?? '', date);
      if (!p.orderId || del == null) errors.push(`${label}…：送達時間要填 HH:mm`);
      else ops.push({ kind: 'restore', id: p.orderId, deliveredAt: del });
    } else if (p.type === 'tip') {
      const tip = parseMoney(e.tip ?? '');
      const t = tip != null && Number.isFinite(tip) ? normalizeTip(tip) : undefined;
      if (!p.orderId) errors.push(`${label}…：沒有指定哪一張，請到紀錄頁點那一張加小費`);
      else if (t == null) errors.push(`${label}…：小費要填`);
      else ops.push({ kind: 'tip', id: p.orderId, tip: t });
    } else if (p.type === 'review') {
      if (!p.orderId) continue; // 純提醒
      const act = e.action ?? p.actions?.[0];
      if (act === 'delete') ops.push({ kind: 'delete', id: p.orderId });
      else if (act === 'cancel') ops.push({ kind: 'cancel', id: p.orderId });
      else if (act === 'edit') {
        const min = Number(e.minutes);
        const amt = parseMoney(e.amount ?? '');
        if (!Number.isFinite(min) || min < 1 || min > 180 || amt == null || !Number.isFinite(amt)) errors.push(`${label}…：分鐘/金額格式不對`);
        else ops.push({ kind: 'edit', id: p.orderId, estimateMin: clampEstimate(min), amount: Math.round(amt * 100) / 100 });
      }
    }
  }
  // 同一組二選一（還原 vs 新增）不能都勾
  const ids = new Set(selected.map((p) => p.id));
  for (const p of selected) if (p.alternativeTo && ids.has(p.alternativeTo)) errors.push('「還原」與「改成新增」二選一，不能都勾');
  return { ops, errors: [...new Set(errors)] };
}

/**
 * 在訂單清單上套用（不含 delete：刪除走 controller.pruneOrders 的墓碑流程）。純函式；
 * 回傳新清單與每項結果（找不到的單 → skipped）。新增的單：已送達、source 'admin'（＝補登，舊版 App/伺服器都認得）。
 */
export function applyOps(
  orders: readonly Order[],
  ops: readonly ReconcileOp[],
  makeId: (i: number) => string,
): { orders: Order[]; done: number; skipped: string[] } {
  let list = orders.slice();
  let done = 0;
  const skipped: string[] = [];
  const update = (id: string, fn: (o: Order) => Order | null) => {
    const cur = list.find((o) => o.id === id);
    const next = cur ? fn(cur) : null;
    if (!cur || !next) {
      skipped.push(id);
      return;
    }
    list = list.map((o) => (o.id === id ? next : o));
    done++;
  };
  ops.forEach((op, i) => {
    if (op.kind === 'add') {
      const o: Order = {
        id: makeId(i),
        acceptedAt: op.acceptedAt,
        estimateMin: op.estimateMin,
        deadline: op.acceptedAt + op.estimateMin * 60_000,
        status: 'delivered',
        deliveredAt: op.deliveredAt,
        actualMin: Math.round(((op.deliveredAt - op.acceptedAt) / 60_000) * 10) / 10,
        amount: op.amount,
        ...(op.tip ? { tip: op.tip } : {}),
        source: 'admin',
        note: op.note,
      };
      list = [o, ...list];
      done++;
    } else if (op.kind === 'restore') {
      update(op.id, (o) =>
        o.status === 'canceled'
          ? { ...o, status: 'delivered', deliveredAt: op.deliveredAt, actualMin: Math.round(((op.deliveredAt - o.acceptedAt) / 60_000) * 10) / 10 }
          : null,
      );
    } else if (op.kind === 'tip') {
      update(op.id, (o) => ({ ...o, tip: op.tip }));
    } else if (op.kind === 'edit') {
      update(op.id, (o) => ({
        ...o,
        ...(op.estimateMin != null ? { estimateMin: op.estimateMin, deadline: o.acceptedAt + op.estimateMin * 60_000 } : {}),
        ...(op.amount != null ? { amount: op.amount } : {}),
      }));
    } else if (op.kind === 'cancel') {
      update(op.id, (o) => {
        const { deliveredAt: _d, actualMin: _a, ...rest } = o;
        return { ...rest, status: 'canceled' };
      });
    }
  });
  return { orders: list, done, skipped };
}

/** 結果摘要一行 */
export function diffText(r: ReconcileResult): string {
  const m = (x: number) => `$${Math.round(x * 100) / 100}`;
  const sign = (x: number) => (x > 0 ? `少 ${x}` : x < 0 ? `多 ${-x}` : '一致');
  const parts = [
    `App ${r.app.count} 張 ${m(r.app.amount)}／平台 ${r.platform.count} 張 ${m(r.platform.amount)}`,
    `單數 App ${sign(r.diff.count)}${r.diff.count !== 0 ? ' 張' : ''}、金額 ${r.diff.amount === 0 ? '一致' : r.diff.amount > 0 ? `少 ${m(r.diff.amount)}` : `多 ${m(-r.diff.amount)}`}`,
  ];
  if (r.diff.tips != null) parts.push(`小費 ${r.diff.tips === 0 ? '一致' : r.diff.tips > 0 ? `少 ${m(r.diff.tips)}` : `多 ${m(-r.diff.tips)}`}`);
  return parts.join('；');
}
