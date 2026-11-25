// 熊貓倒數：今日對帳（純函式，零依賴；server/index.mjs 的 /api/reconcile、/api/admin/reconcile 用，test/reconcile.test.mjs 驗）。
//
// 輸入：當日（台北日，依 acceptedAt）訂單、telemetry 事件（只含白名單關鍵字，無個資）、使用者從平台看到的
//       完成單數 count、總金額 amount（＝各單報酬＋小費，不含補錢；問題訂單金額算在內但不算件數）、選填小費總額 tips。
// 輸出：App 端數字、差額、proposals（每條：type add|restore|tip|review、建議欄位 fields、信心 high|low、一行說明、需要使用者補的欄位）。
//
// 找漏記單的證據（規則見 CLAUDE.md「今日對帳」）：
//   送達訊號＝app `delivered`（任何 note）＋ext `delivered_seen note=signal`，時間扣 delay；60 秒內合併成一次送達。
//   「沒記到的送達」＝不在任何 App 已送達單 deliveredAt ±90 秒內的那次送達（含 noActive、或結到後來被改掉的單）。
//   取餐證據＝ext `screen`（非邀請畫面）的 kw 含 前往取餐/抵達店家/已取餐/確認已取餐…；
//   沒有被 App 已送達/進行中單（接單前 15 秒～送達）涵蓋的取餐證據＝「沒人認領的取餐」→ 一組（中間沒有送達才算同一組）
//   ＝一張候選漏單；送達＝之後第一個沒記到的送達（同一組只配一個）。沒有取餐證據的送達（剛送完的殘留、對話框切來切去）一律不算。
//   接單時間：上一次送達之後、第一個取餐證據之前有廣播中斷（app sig stopped）→ 中斷開始；
//            否則 第一個取餐證據−60 秒，但不早於上一次送達＋30 秒；兩者之間 OCR 都沒有字（空白）→ 上一次送達＋30 秒。
//   有取餐證據但沒有送達訊號 → 列為「送達時間待填」候選，預設＝之後第一個「收入總額」畫面（非整數、非任何單價的金額）−10 秒，
//            沒有就＝下一張單接單／下一個取餐證據的時間。
//   取消的單：取餐證據落在它接單～取消之間、之後又有沒記到的送達 → 提議「還原這張」（金額吻合差額時優先於新增）。

export const PICKUP_KEYWORDS = ['前往取餐', '抵達店家', '抵達餐廳', '已取餐', '確認已取餐', '是否已取餐', '確認取餐', '即將準備完成'];
export const TIP_KEYWORD = '小費';

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 86_400_000;
const TAIPEI = 8 * 3_600_000;
/** 同一次送達的訊號合併窗 */
export const SAME_DELIVERY_MS = 60 * SEC;
/** 送達訊號離 App 已送達單的 deliveredAt 多近算「有記到」 */
export const ACCOUNTED_MS = 90 * SEC;
/** 接單畫面比 App 記的接單時間早出現的寬限 */
const ACCEPT_GRACE_MS = 15 * SEC;
/** 一張單從取餐到送達最長 */
const MAX_LEG_MS = 120 * MIN;
/** 小費畫面離送達多近算同一張 */
const TIP_NEAR_MS = 3 * MIN;

const r2 = (x) => Math.round(x * 100) / 100;
const eq = (a, b) => Math.abs(a - b) < 0.005;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** 報酬公式（＝src/orders.ts exactFare）：max(45, floor(m×245/60×100+1)/100) */
export function exactFare(m) {
  const cents = Math.floor((m * 24500) / 60 + 1 + 1e-9);
  return Math.max(4500, cents) / 100;
}

/** 金額 → 分鐘：45 → { min:null, upTo:11 }（≤11 分都是 45）；是某個 fare(m) → { min:m }；都不是 → null */
export function minutesForFare(amount) {
  if (!isNum(amount)) return null;
  if (eq(amount, 45)) return { min: null, upTo: 11 };
  for (let m = 12; m <= 180; m++) if (eq(exactFare(m), amount)) return { min: m };
  return null;
}

/** 不是單價的金額 → 拆成「報酬＋整數小費」的選項（小費小的在前，最多 n 個） */
export function tipSplits(amount, n = 2) {
  const out = [];
  for (let m = 180; m >= 11 && out.length < n; m--) {
    const fare = m === 11 ? 45 : exactFare(m);
    const tip = r2(amount - fare);
    if (tip >= 1 - 1e-9 && eq(tip, Math.round(tip))) out.push({ min: m === 11 ? null : m, upTo: m === 11 ? 11 : undefined, fare, tip: Math.round(tip) });
  }
  return out;
}

/** 合計 total 拆成 n 張單的報酬組合（不排序的多重集合；45 代表 ≤11 分）。回傳 { count, solutions（最多 limit 組，每組遞增的分鐘陣列，11＝≤11 分） } */
export function splitFares(total, n, limit = 50) {
  const mins = [11];
  for (let m = 12; m <= 90; m++) mins.push(m);
  const fare = (m) => (m <= 11 ? 45 : exactFare(m));
  const target = Math.round(total * 100);
  const sols = [];
  let count = 0;
  if (n < 1 || n > 5 || target < 4500 * n) return { count: 0, solutions: [] };
  const rec = (start, left, rest, acc) => {
    if (left === 0) {
      if (Math.abs(rest) <= 0) {
        count++;
        if (sols.length < limit) sols.push(acc.slice());
      }
      return;
    }
    for (let i = start; i < mins.length; i++) {
      const c = Math.round(fare(mins[i]) * 100);
      if (c * left > rest) break; // 遞增：之後都更大
      if (Math.round(fare(90) * 100) * left < rest) continue; // 剩下的就算全用最大也不夠
      acc.push(mins[i]);
      rec(i, left - 1, rest - c, acc);
      acc.pop();
    }
  };
  rec(0, n, target, []);
  return { count, solutions: sols };
}

const pad = (x) => String(x).padStart(2, '0');
/** 台北 HH:mm:ss */
export function hms(ms) {
  const d = new Date(ms + TAIPEI);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
const hm = (ms) => hms(ms).slice(0, 5);
const money = (x) => `$${r2(x)}`;
const minText = (m) => (m == null ? '≤11 分' : `${m} 分`);
/** v1.4 訂單有店名 → 「(店名)」，沒有＝空字串（對帳提議裡認得是哪一張） */
const storeTag = (o) => (o && typeof o.store === 'string' && o.store ? `(${o.store})` : '');

/** 台北日 YYYY-MM-DD → 00:00 的 ms；不合法 → NaN */
export function taipeiDayStart(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  return Date.parse(`${date}T00:00:00Z`) - TAIPEI;
}

const evTime = (r) => (isNum(r.t) ? r.t : Date.parse(r.ts));
const amountOf = (o) => (isNum(o.amount) && o.amount > 0 ? o.amount : exactFare(o.estimateMin));
const tipOf = (o) => (isNum(o.tip) && o.tip > 0 ? o.tip : 0);

/** 取消時間：App 取消時 updatedAt＝取消當下；被別處改過就退回接單＋1.5×預估（最多 3 小時） */
function cancelAt(o) {
  const fallback = o.acceptedAt + Math.min(180 * MIN, Math.max(10 * MIN, o.estimateMin * 1.5 * MIN));
  if (o.editedBy === 'app' && isNum(o.updatedAt) && o.updatedAt > o.acceptedAt && o.updatedAt - o.acceptedAt < 180 * MIN) return o.updatedAt;
  return fallback;
}

/** 送達訊號 → 合併成「一次送達」 */
export function deliveryClusters(events) {
  const sig = [];
  for (const r of events) {
    const isApp = r.src === 'app' && r.ev === 'delivered';
    const isExt = r.src === 'ext' && r.ev === 'delivered_seen' && r.note === 'signal';
    if (!isApp && !isExt) continue;
    const t = evTime(r);
    if (!isNum(t)) continue;
    const at = t - (isNum(r.delay) && r.delay > 0 && r.delay <= 120 ? r.delay * SEC : 0);
    sig.push({ at, noActive: isApp && r.note === 'skip' && r.reason === 'noActive' });
  }
  sig.sort((a, b) => a.at - b.at);
  const out = [];
  for (const s of sig) {
    const cur = out[out.length - 1];
    if (cur && s.at - cur.at <= SAME_DELIVERY_MS) {
      cur.last = Math.max(cur.last, s.at);
      cur.n++;
      cur.noActive ||= s.noActive;
    } else out.push({ at: s.at, last: s.at, n: 1, noActive: s.noActive });
  }
  return out;
}

/**
 * 對帳主函式。
 * @param {{ date:string, orders:object[], events:object[], platform:{count:number, amount:number, tips?:number|null}, until?:number|null, now?:number }} input
 *   orders＝伺服器 orderOut 形狀（含前後幾小時的單也可以：計數只看 acceptedAt 在當日 [00:00, until) 的）；
 *   events＝telemetry 紀錄（t＝事件時間 ms；沒有就用 ts）；until＝只看到這個時間（預設 min(現在, 當日結束)）。
 */
export function reconcile(input) {
  const { date, platform } = input;
  const dayStart = taipeiDayStart(date);
  if (!isNum(dayStart)) throw new Error('date 不合法');
  const now = isNum(input.now) ? input.now : Date.now();
  const end = Math.min(dayStart + DAY, isNum(input.until) ? input.until : now);
  const live = (input.orders || []).filter((o) => o && !o.deleted && isNum(o.acceptedAt));
  const today = live.filter((o) => o.acceptedAt >= dayStart && o.acceptedAt < end);
  const todayDone = today.filter((o) => o.status === 'delivered');
  const tipsApp = r2(todayDone.reduce((s, o) => s + tipOf(o), 0));
  const app = {
    count: todayDone.filter((o) => !o.noTiming).length,
    amount: r2(todayDone.reduce((s, o) => s + amountOf(o), 0) + tipsApp),
    tips: tipsApp,
  };
  const plat = { count: platform.count, amount: r2(platform.amount), tips: isNum(platform.tips) ? r2(platform.tips) : null };
  const k = plat.count - app.count;
  const dA = r2(plat.amount - app.amount);
  const tipD = plat.tips != null ? r2(plat.tips - app.tips) : null;
  const diff = { count: k, amount: dA, tips: tipD };
  /** 報酬（不含小費）還差多少 */
  const fareTotal = r2(dA - (tipD != null && tipD > 0 ? tipD : 0));

  const events = (input.events || [])
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({ ...r, at: evTime(r) }))
    .filter((r) => isNum(r.at) && r.at >= dayStart - 3 * 3_600_000 && r.at <= end + 10 * MIN)
    .sort((a, b) => a.at - b.at);

  // ── 送達 ──
  const doneAll = live.filter((o) => o.status === 'delivered' && isNum(o.deliveredAt));
  const clusters = deliveryClusters(events).filter((c) => c.at <= end);
  for (const c of clusters) {
    c.accounted = doneAll.some((o) => Math.abs(o.deliveredAt - c.at) <= ACCOUNTED_MS || Math.abs(o.deliveredAt - c.last) <= ACCOUNTED_MS);
  }

  // ── 取餐證據 ──
  const coverEnd = (o) => (o.status === 'delivered' ? o.deliveredAt : o.status === 'active' ? end + 3_600_000 : cancelAt(o));
  const working = live.filter((o) => o.status === 'delivered' || o.status === 'active');
  const canceled = live.filter((o) => o.status === 'canceled');
  const pickups = [];
  for (const r of events) {
    if (r.src !== 'ext' || r.ev !== 'screen' || r.accept === true || !Array.isArray(r.kw)) continue;
    if (!r.kw.some((w) => PICKUP_KEYWORDS.includes(w))) continue;
    if (r.at < dayStart || r.at > end) continue;
    if (working.some((o) => r.at >= o.acceptedAt - ACCEPT_GRACE_MS && r.at <= coverEnd(o))) continue;
    const by = canceled.filter((o) => r.at >= o.acceptedAt - ACCEPT_GRACE_MS && r.at <= coverEnd(o)).map((o) => o.id);
    pickups.push({ at: r.at, kw: r.kw.filter((w) => PICKUP_KEYWORDS.includes(w)), canceledBy: by });
  }

  // 邊界：送達（App 已送達單、送達訊號）、取消
  const boundaries = [
    ...doneAll.map((o) => o.deliveredAt),
    ...clusters.map((c) => c.at),
    ...canceled.map((o) => cancelAt(o)),
  ].sort((a, b) => a - b);
  const between = (a, b) => boundaries.some((x) => x > a && x < b);

  // 沒人認領的取餐 → 分組（中間有送達/取消＝不同組）
  // 取消單涵蓋的證據自成一組（key＝涵蓋它的取消單）；中間有任何接單也分開
  const acceptsLive = live.map((o) => o.acceptedAt);
  const groups = [];
  for (const p of pickups) {
    const g = groups[groups.length - 1];
    const key = p.canceledBy.join(',');
    if (g && g.key === key && !between(g.last, p.at) && !acceptsLive.some((t) => t > g.last && t < p.at) && p.at - g.last < 45 * MIN) {
      g.items.push(p);
      g.last = p.at;
    } else groups.push({ first: p.at, last: p.at, items: [p], key });
  }

  const stops = events.filter((r) => r.src === 'app' && r.ev === 'sig' && r.note === 'stopped').map((r) => r.at);
  const informative = events.filter((r) => r.src === 'ext' && r.ev === 'screen' && Array.isArray(r.kw) && r.kw.length > 0).map((r) => r.at);
  const acceptsAll = live.map((o) => o.acceptedAt).sort((a, b) => a - b);
  const pickupAll = events
    .filter((r) => r.src === 'ext' && r.ev === 'screen' && r.accept !== true && Array.isArray(r.kw) && r.kw.some((w) => PICKUP_KEYWORDS.includes(w)))
    .map((r) => r.at);
  const isFareValue = (a) => minutesForFare(a) != null;
  const incomeScreens = events
    .filter((r) => r.src === 'ext' && r.ev === 'screen' && r.accept !== true && isNum(r.amt) && r.amt >= 100 && !eq(r.amt, Math.round(r.amt)) && !isFareValue(r.amt))
    .map((r) => r.at);

  /** 接單時間推估 */
  const inferAccept = (first) => {
    const prev = boundaries.filter((b) => b < first).pop() ?? dayStart;
    const stop = stops.find((t) => t > prev && t < first);
    if (stop != null) return { at: stop, how: `${hms(stop)} 廣播中斷時接單` };
    const lower = Math.min(prev + 30 * SEC, first);
    const guess = first - 60 * SEC;
    if (guess <= lower) return { at: lower, how: `上一張 ${hms(prev)} 送完就接` };
    if (!informative.some((t) => t > lower && t < guess)) return { at: lower, how: `${hms(prev)} 送完後畫面空白、${hms(first)} 已在取餐` };
    return { at: guess, how: `${hms(first)} 取餐畫面前 1 分` };
  };

  // ── 候選 ──
  const used = new Set();
  const cands = [];
  groups.forEach((g, gi) => {
    const next = groups[gi + 1];
    const limit = Math.min(next ? next.first : Infinity, g.first + MAX_LEG_MS, end + 10 * MIN);
    const allCanceled = g.items.every((p) => p.canceledBy.length > 0);
    // 送達要嘛緊接著（中間 App 沒有接新單），要嘛當時 App 手上還有別張（疊單中，漏的那張晚點才送）
    const acceptedBetween = (a, b) => acceptsAll.some((t) => t > a && t < b);
    const activeAt = (t) => working.some((o) => o.acceptedAt < t && coverEnd(o) > t + ACCOUNTED_MS);
    const de = clusters.find(
      (c) => !c.accounted && !used.has(c) && c.at > g.last && c.at <= limit && (!acceptedBetween(g.last, c.at) || (!allCanceled && activeAt(c.at))),
    );
    if (!de && allCanceled) return; // 正常取消的單
    if (de) used.add(de);
    const evidence = g.items.map((p) => `${hms(p.at)} ${p.kw[0]}`);
    // 被取消的單：取餐證據落在它接單～取消之間，或取消後 10 分內又開始取餐；取消到送達之間 App 沒接新單；金額合得上
    const restoreOf = de
      ? canceled
          .filter((o) => g.items.some((p) => p.canceledBy.includes(o.id)) || (cancelAt(o) <= g.first && cancelAt(o) >= g.first - 10 * MIN))
          .filter((o) => !acceptedBetween(cancelAt(o), de.at))
          .filter((o) => (k === 1 ? eq(amountOf(o), fareTotal) : amountOf(o) <= fareTotal + 0.005))
          .pop()
      : null;
    if (de && restoreOf) cands.push({ kind: 'restore', strong: true, order: restoreOf, deliveredAt: de.at, de, group: g, evidence, alt: !allCanceled });
    if (allCanceled) return;
    const acc = inferAccept(g.first);
    let deliveredAt = de ? de.at : null;
    let deliveredHow = de ? `${hms(de.at)} 送達訊號${de.noActive ? '（App 當時沒有進行中單）' : '（結到的單後來被改掉）'}` : null;
    if (!de) {
      const nextAccept = acceptsAll.find((t) => t > g.last);
      const nextPick = pickupAll.find((t) => t > g.last + 5 * MIN && !g.items.some((p) => p.at === t));
      const lim = Math.min(nextAccept ?? Infinity, nextPick ?? Infinity, g.last + MAX_LEG_MS, end);
      const inc = incomeScreens.find((t) => t > g.last && t <= lim);
      if (inc != null) {
        deliveredAt = inc - 10 * SEC;
        deliveredHow = `${hms(inc)} 出現收入總額畫面（推估，請確認）`;
      } else if (Number.isFinite(lim)) {
        deliveredAt = lim;
        deliveredHow = '沒有送達訊號，暫填下一張接單／取餐時間（請改）';
      }
    }
    cands.push({ kind: 'add', strong: !!de, acceptedAt: acc.at, acceptHow: acc.how, deliveredAt, deliveredHow, de, group: g, evidence, altOf: restoreOf ? restoreOf.id : null });
  });
  const residual = clusters.filter((c) => !c.accounted && !used.has(c) && c.at >= dayStart);

  // ── proposals ──
  const proposals = [];
  const info = [];
  let seq = 0;
  const pid = (t) => `${t}-${++seq}`;
  if (residual.length) info.push(`忽略 ${residual.length} 個沒有取餐證據的送達訊號（剛送完的殘留/重複）：${residual.map((c) => hms(c.at)).join('、')}`);

  const addProposal = (c, f, extra = {}) => {
    const dur = c.deliveredAt != null ? r2((c.deliveredAt - c.acceptedAt) / MIN) : null;
    const needs = [...(extra.needs || [])];
    if (!c.strong) needs.unshift('deliveredAt');
    const note = `對帳補登：${c.acceptHow}；${c.deliveredHow ?? '送達時間待填'}`.slice(0, 100);
    return {
      id: pid('add'),
      type: 'add',
      confidence: extra.confidence ?? (c.strong ? 'high' : 'low'),
      text:
        extra.text ??
        `漏記一張：${hms(c.acceptedAt)} 接、${c.deliveredAt != null ? `${hms(c.deliveredAt)} 送達` : '送達時間待填'}${f.amount != null ? `，${minText(f.estimateMin ?? null)} ${money(f.amount)}` : ''}`,
      fields: {
        acceptedAt: c.acceptedAt,
        deliveredAt: c.deliveredAt,
        estimateMin: f.estimateMin ?? null,
        amount: f.amount ?? null,
        ...(f.tip ? { tip: f.tip } : {}),
        note,
      },
      needs: [...new Set(needs)],
      ...(extra.options ? { options: extra.options } : {}),
      evidence: { pickups: c.evidence, accept: c.acceptHow, delivery: c.deliveredHow, actualMin: dur },
    };
  };

  /** 只知道報酬總額 amount（單張）→ 欄位 */
  const fieldsForAmount = (amount, actualMin) => {
    const mm = minutesForFare(amount);
    if (mm && mm.min != null) return { f: { estimateMin: mm.min, amount }, needs: [] };
    if (mm) {
      const guess = Math.min(11, Math.max(1, Math.round(actualMin ?? 11)));
      return { f: { estimateMin: guess, amount: 45 }, needs: ['estimateMin'], note: '金額 $45＝≤11 分都可能，分鐘待確認' };
    }
    if (plat.tips == null) {
      const opts = tipSplits(amount);
      if (opts.length) {
        const options = opts.map((o) => ({
          label: `${minText(o.min)} ${money(o.fare)}＋小費 ${money(o.tip)}`,
          fields: { estimateMin: o.min ?? Math.min(11, Math.max(1, Math.round(actualMin ?? 11))), amount: o.fare, tip: o.tip },
        }));
        return { f: options[0].fields, needs: ['choice'], options, note: `${money(amount)} 不是任何單價，可能含小費` };
      }
    }
    return { f: { estimateMin: null, amount: null }, needs: ['estimateMin', 'amount'], note: `${money(amount)} 對不上單價，請填分鐘/金額` };
  };

  if (k > 0) {
    // 同一組證據「還原取消的單」與「新增一張」二選一：還原占名額，新增當備選
    const slots = cands.filter((c) => !c.altOf);
    const strong = slots.filter((c) => c.strong);
    const weak = slots.filter((c) => !c.strong);
    let chosen;
    let over = false;
    if (strong.length >= k) {
      chosen = strong;
      over = strong.length > k;
    } else chosen = [...strong, ...weak.slice(0, k - strong.length)];
    // 還原的金額先扣
    const restores = chosen.filter((c) => c.kind === 'restore');
    const adds = chosen.filter((c) => c.kind === 'add');
    let R = r2(fareTotal - restores.reduce((s, c) => s + amountOf(c.order), 0));
    for (const c of restores) {
      const o = c.order;
      const fits = over ? eq(amountOf(o), fareTotal) : true;
      proposals.push({
        id: pid('restore'),
        type: 'restore',
        confidence: !over && fits && (adds.length || eq(R, 0)) ? 'high' : 'low',
        text: `還原被取消的 ${hm(o.acceptedAt)}${storeTag(o)} ${o.estimateMin} 分 ${money(amountOf(o))}：之後有取餐與 ${hms(c.deliveredAt)} 送達`,
        orderId: o.id,
        fields: { status: 'delivered', deliveredAt: c.deliveredAt },
        needs: [],
        evidence: { pickups: c.evidence, delivery: `${hms(c.deliveredAt)} 送達訊號` },
      });
    }
    if (over) {
      // 候選比差額多：每張都當「就是它」算金額，讓使用者勾
      for (const c of adds) {
        const dur = c.deliveredAt != null ? (c.deliveredAt - c.acceptedAt) / MIN : null;
        const a = k === 1 ? fieldsForAmount(fareTotal, dur) : { f: { estimateMin: null, amount: null }, needs: ['estimateMin', 'amount'] };
        const p = addProposal(c, a.f, { needs: a.needs, options: a.options, confidence: 'low' });
        p.text += `（候選 ${strong.length} 張多於差額 ${k} 張，請只勾真的漏記的）`;
        proposals.push(p);
      }
    } else if (adds.length === 1) {
      const c = adds[0];
      const dur = c.deliveredAt != null ? (c.deliveredAt - c.acceptedAt) / MIN : null;
      const a = fieldsForAmount(R, dur);
      const p = addProposal(c, a.f, { needs: a.needs, options: a.options, confidence: c.strong && !a.needs.includes('amount') ? 'high' : 'low' });
      if (a.note) p.text += `（${a.note}）`;
      proposals.push(p);
    } else if (adds.length >= 2) {
      const sp = splitFares(R, adds.length);
      const durs = adds.map((c) => (c.deliveredAt != null ? (c.deliveredAt - c.acceptedAt) / MIN : null));
      let pick = null;
      if (sp.count >= 1 && durs.every((d) => d != null)) {
        // 預填：依實際時長比例最接近的一組（時長長的配報酬高的）
        const totalDur = durs.reduce((s, d) => s + d, 0);
        let best = Infinity;
        for (const sol of sp.solutions) {
          const order = durs.map((d, i) => i).sort((a, b) => durs[a] - durs[b]);
          const assign = new Array(adds.length);
          order.forEach((idx, rank) => (assign[idx] = sol[rank]));
          const dev = assign.reduce((s, m, i) => s + Math.abs((m <= 11 ? 45 : exactFare(m)) - (R * durs[i]) / totalDur), 0);
          if (dev < best) {
            best = dev;
            pick = assign;
          }
        }
      }
      const unique = sp.count === 1 && new Set(sp.solutions[0]).size === 1;
      adds.forEach((c, i) => {
        const m = pick ? pick[i] : null;
        const f = m != null ? { estimateMin: m <= 11 ? Math.min(11, Math.max(1, Math.round(durs[i] ?? 11))) : m, amount: m <= 11 ? 45 : exactFare(m) } : { estimateMin: null, amount: null };
        const needs = unique && c.strong ? [] : ['estimateMin', 'amount'];
        const p = addProposal(c, f, { needs, confidence: unique && c.strong ? 'high' : 'low' });
        p.text += sp.count === 0 ? `（${adds.length} 張合計 ${money(R)} 拆不成單價，請逐張填）` : unique ? '' : `（${adds.length} 張合計 ${money(R)}，有 ${sp.count} 種分鐘組合${pick ? '，已依實際時長預填' : ''}，請逐張確認）`;
        proposals.push(p);
      });
    }
    for (const r of restores) {
      const alt = cands.find((c) => c.altOf === r.order.id && c.group === r.group);
      if (!alt) continue;
      const p = addProposal(alt, { estimateMin: r.order.estimateMin, amount: amountOf(r.order) }, { confidence: 'low' });
      p.text = `（與上面還原二選一）若取消那張真的取消了：改成新增 ${hms(alt.acceptedAt)} 接、${hms(alt.deliveredAt)} 送達，${r.order.estimateMin} 分 ${money(amountOf(r.order))}`;
      p.alternativeTo = proposals.find((x) => x.type === 'restore' && x.orderId === r.order.id)?.id ?? null;
      proposals.push(p);
    }
    // 證據不夠：還差幾張就給空白新增
    for (let i = chosen.length; i < k; i++) {
      proposals.push({
        id: pid('add'),
        type: 'add',
        confidence: 'low',
        text: `還差 ${k - chosen.length} 張找不到證據，請自己填接單/送達時間與分鐘`,
        fields: { acceptedAt: null, deliveredAt: null, estimateMin: null, amount: null, note: '對帳補登：使用者手填' },
        needs: ['acceptedAt', 'deliveredAt', 'estimateMin', 'amount'],
      });
    }
  } else if (cands.length) {
    info.push(`單數沒有少，但有 ${cands.length} 組沒人認領的取餐證據（${cands.map((c) => hm(c.group.first)).join('、')}），沒有提議新增`);
  }

  // ── 小費 ──
  if (tipD != null && tipD > 0) {
    const tipScreens = events.filter(
      (r) => r.src === 'ext' && (r.ev === 'screen' || r.ev === 'delivered_seen') && Array.isArray(r.kw) && r.kw.includes(TIP_KEYWORD) && isNum(r.amt) && eq(r.amt, tipD) && r.at >= dayStart && r.at <= end,
    );
    let done = false;
    for (const s of tipScreens) {
      const near = todayDone
        .filter((o) => Math.abs(o.deliveredAt - s.at) <= TIP_NEAR_MS && !tipOf(o))
        .sort((a, b) => Math.abs(a.deliveredAt - s.at) - Math.abs(b.deliveredAt - s.at))[0];
      if (near) {
        proposals.push({
          id: pid('tip'),
          type: 'tip',
          confidence: 'high',
          text: `小費 ${money(tipD)} 記在 ${hm(near.acceptedAt)}→${hm(near.deliveredAt)}${storeTag(near)} 那張（${hms(s.at)} 送達畫面有「小費 ${money(tipD)}」）`,
          orderId: near.id,
          fields: { tip: tipD },
          needs: [],
        });
        done = true;
        break;
      }
      const add = proposals.find((p) => p.type === 'add' && p.fields.deliveredAt != null && Math.abs(p.fields.deliveredAt - s.at) <= TIP_NEAR_MS);
      if (add) {
        add.fields.tip = tipD;
        add.text += `，含小費 ${money(tipD)}`;
        done = true;
        break;
      }
    }
    if (!done) {
      proposals.push({
        id: pid('tip'),
        type: 'tip',
        confidence: 'low',
        text: `小費還差 ${money(tipD)}，找不到「小費 ${money(tipD)}」的送達畫面：請到紀錄頁點那一張加小費`,
        orderId: null,
        fields: { tip: tipD },
        needs: ['orderId'],
      });
    }
  } else if (tipD != null && tipD < 0) {
    const withTip = todayDone.filter((o) => tipOf(o) > 0);
    proposals.push({
      id: pid('review'),
      type: 'review',
      confidence: 'low',
      text: `App 小費比平台多 ${money(-tipD)}：有小費的單 ${withTip.map((o) => `${hm(o.acceptedAt)}${storeTag(o)} ${money(tipOf(o))}`).join('、') || '（無）'}，請檢查`,
      orderId: null,
      fields: {},
      needs: [],
    });
  }

  // ── App 多記／金額對不上 ──
  if (k < 0 || (k === 0 && !eq(fareTotal, 0)) || (k > 0 && fareTotal < 0)) {
    const counted = todayDone.filter((o) => !o.noTiming);
    if (k === 0) {
      // 件數對、金額差：哪張的金額改成「原金額＋差額」剛好是單價
      for (const o of counted) {
        const want = r2(amountOf(o) + fareTotal);
        const mm = want > 0 ? minutesForFare(want) : null;
        if (!mm) continue;
        const m = mm.min ?? Math.min(11, o.estimateMin);
        proposals.push({
          id: pid('review'),
          type: 'review',
          confidence: 'low',
          text: `${hm(o.acceptedAt)}${storeTag(o)} 那張 ${o.estimateMin} 分 ${money(amountOf(o))} → 改成 ${minText(mm.min)} ${money(want)} 金額就對上（分鐘可能讀錯）`,
          orderId: o.id,
          fields: { estimateMin: m, amount: want },
          actions: ['edit'],
          needs: [],
        });
        if (proposals.filter((p) => p.type === 'review').length >= 5) break;
      }
    }
    if (k < 0) {
      const scored = counted.map((o) => {
        const why = [];
        let score = 0;
        const hasSignal = clusters.some((c) => Math.abs(o.deliveredAt - c.at) <= ACCOUNTED_MS || Math.abs(o.deliveredAt - c.last) <= ACCOUNTED_MS);
        if (!hasSignal) {
          why.push('沒有送達訊號');
          score += 2;
        }
        const overlap = counted.some((x) => x.id !== o.id && x.acceptedAt < o.deliveredAt && o.acceptedAt < x.deliveredAt);
        if (overlap && !o.stacked) {
          why.push('與另一張時間重疊');
          score += 1;
        }
        if (k === -1 && eq(amountOf(o), -fareTotal)) {
          why.push(`金額 ${money(amountOf(o))}＝多出的金額`);
          score += 3;
        }
        return { o, why, score };
      });
      scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.o.acceptedAt - b.o.acceptedAt)
        .slice(0, Math.max(3, -k + 2))
        .forEach(({ o, why }) =>
          proposals.push({
            id: pid('review'),
            type: 'review',
            confidence: 'low',
            text: `App 多記 ${-k} 張？${hm(o.acceptedAt)}→${hm(o.deliveredAt)}${storeTag(o)} ${o.estimateMin} 分 ${money(amountOf(o))}：${why.join('、')}`,
            orderId: o.id,
            fields: {},
            actions: ['delete', 'cancel'],
            needs: ['choice'],
          }),
        );
      if (!proposals.some((p) => p.type === 'review')) info.push(`App 多記 ${-k} 張，但每張都有送達證據；請自己對照平台明細`);
    }
    if (k > 0 && fareTotal < 0) info.push(`單數少 ${k} 張但金額反而多 ${money(-fareTotal)}，請檢查有沒有記錯金額的單`);
  }

  return { date, until: end, app, platform: plat, diff, proposals, info };
}

// ── v1.4 拒單紀錄（未接的邀請；純函式，/api/declined、/api/admin/declined 用，test/declined.test.mjs 驗） ──
//
// 來源：ext `offer_decided` result=reject（舊伺服器只剩 note=reject）。時間＝同分鐘（金額相同或任一方沒抓到）最近一個
//   `offer_seen`（決定前 15 分鐘內）的 t，沒有就＝t − wait（邀請消失的時間）；公里/金額/店名優先取決定事件，缺的用 offer_seen 補。
// 排除（不是真的拒單）：
//   ① replaced 且（自己金額不可能地低＝誤讀，或 10 秒內出現的下一張邀請同分鐘＝同一張重讀）；
//   ② 60 秒內同分鐘同金額的另一筆拒單（同一張重複判定，留第一筆）；
//   ③ 前後 60 秒內同分鐘同金額被判「接單」（offer_decided accept／ext order）；
//   ④ 有訂單（未刪除，任何來源/狀態：App 判定接單、「你有接嗎？」按有接 source=confirm…）同分鐘、接單時間在邀請時間或判定時間 ±120 秒內。
export const DECLINED_SAME_MS = 60 * SEC;
export const DECLINED_ORDER_MS = 120 * SEC;
const SEEN_LOOKBACK_MS = 15 * MIN;
const REPLACED_NEXT_MS = 10 * SEC;
const amountKeyOf = (a) => (isNum(a) && a >= 1 && a <= 999 ? Math.round(a) : 0);
const sameAmount = (a, b) => amountKeyOf(a) === 0 || amountKeyOf(b) === 0 || amountKeyOf(a) === amountKeyOf(b);
/** 金額比該分鐘的報酬還低（OCR 誤讀）；沒金額 → false */
const implausible = (min, amt) => isNum(amt) && Math.round(amt * 100) < Math.round(exactFare(min) * 100) - 1;

export const DECLINED_REASON_TEXT = { rejected: '拒絕', timeout: '逾時', superseded: '未接', stopped: '偵測停止', replaced: '換單' };

/**
 * @param {{ events:object[], orders:object[], from:number, to:number }} input from/to＝邀請時間範圍 [from, to)（ms）
 * @returns {{ t:number, min:number, amt:number|null, km:number|null, store:string|null, reason:string, decidedAt:number }[]}（依時間舊→新）
 */
export function declinedOffers(input) {
  const evs = (input.events || [])
    .filter((r) => r && r.src === 'ext' && isNum(r.min) && (r.ev === 'offer_seen' || r.ev === 'offer_decided' || r.ev === 'order'))
    .map((r) => ({ ...r, at: evTime(r) }))
    .filter((r) => isNum(r.at))
    .sort((a, b) => a.at - b.at);
  const seen = evs.filter((r) => r.ev === 'offer_seen');
  const accepts = evs.filter((r) => (r.ev === 'offer_decided' && (r.result ?? r.note) === 'accept') || r.ev === 'order');
  const live = (input.orders || []).filter((o) => o && !o.deleted && isNum(o.acceptedAt) && isNum(o.estimateMin));
  const out = [];
  for (const d of evs) {
    if (d.ev !== 'offer_decided' || (d.result ?? d.note) !== 'reject') continue;
    let s = null;
    for (const x of seen) {
      if (x.at > d.at) break;
      if (d.at - x.at <= SEEN_LOOKBACK_MS && x.min === d.min && sameAmount(x.amt, d.amt)) s = x;
    }
    const t = s ? s.at : d.at - (isNum(d.wait) && d.wait > 0 ? d.wait * SEC : 0);
    if (!(t >= input.from && t < input.to)) continue;
    const amt = isNum(d.amt) ? d.amt : isNum(s?.amt) ? s.amt : null;
    if (d.reason === 'replaced') {
      if (implausible(d.min, amt)) continue; // ①
      const next = seen.find((x) => x.at >= d.at - 1000 && x.at - d.at <= REPLACED_NEXT_MS && x !== s);
      if (next && next.min === d.min) continue;
    }
    if (out.some((p) => p.min === d.min && sameAmount(p.amt, amt) && Math.abs(p.decidedAt - d.at) <= DECLINED_SAME_MS)) continue; // ②
    if (accepts.some((a) => a.min === d.min && sameAmount(a.amt, amt) && Math.abs(a.at - d.at) <= DECLINED_SAME_MS)) continue; // ③
    if (
      live.some(
        (o) =>
          Math.abs(o.estimateMin - d.min) < 0.05 &&
          (Math.abs(o.acceptedAt - t) <= DECLINED_ORDER_MS || Math.abs(o.acceptedAt - d.at) <= DECLINED_ORDER_MS),
      )
    ) continue; // ④
    const km = isNum(d.km) ? d.km : isNum(s?.km) ? s.km : null;
    const store = typeof d.store === 'string' && d.store ? d.store : typeof s?.store === 'string' && s.store ? s.store : null;
    out.push({ t, min: d.min, amt, km, store, reason: typeof d.reason === 'string' ? d.reason : 'rejected', decidedAt: d.at });
  }
  return out;
}
