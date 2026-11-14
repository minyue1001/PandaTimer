// v0.7「接單後才開始倒數」：OfferTracker 狀態機（TS 版＝Swift targets/broadcast/OfferTracker.swift 的測試替身）
// 樣本在 test/fixtures/offer-cases.json：OCR 文字 → summarizeScreen（預設規則）→ OfferTracker.observe/tick/finish
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_OFFER, OfferTracker, acceptDelaySeconds, sameOffer } from '../src/offerTracker.ts';
import { DEFAULT_SCREEN_RULES, summarizeScreen } from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const fixture = JSON.parse(read('./fixtures/offer-cases.json'));

function run(c) {
  const settings = { ...DEFAULT_OFFER, ...(c.settings ?? {}) };
  const rules = { ...DEFAULT_SCREEN_RULES, acceptedKeywords: settings.acceptedKeywords, rejectedKeywords: settings.rejectedKeywords };
  const tracker = new OfferTracker(settings, 90);
  const events = [];
  for (const [t, what] of c.steps) {
    if (what === 'tick') events.push(...tracker.tick(t));
    else if (what === 'finish') events.push(...tracker.finish(t));
    else {
      assert.ok(what in fixture.screens, `未知畫面 ${what}`);
      events.push(...tracker.observe(t, summarizeScreen(fixture.screens[what], rules)));
    }
  }
  return events;
}

function brief(e, keys) {
  const flat = { type: e.type, minutes: e.offer?.minutes ?? e.minutes };
  if (e.type === 'decided') Object.assign(flat, { result: e.result, reason: e.reason, acceptedAt: e.acceptedAt, waitSec: e.waitSec, hit: e.hit });
  return Object.fromEntries(keys.map((k) => [k, flat[k]]));
}

for (const c of fixture.cases) {
  test(`樣本：${c.name}`, () => {
    const events = run(c);
    assert.equal(events.length, c.expect.length, JSON.stringify(events.map((e) => brief(e, ['type', 'minutes', 'reason']))));
    c.expect.forEach((want, i) => assert.deepEqual(brief(events[i], Object.keys(want)), want, `${c.name} 第 ${i + 1} 個事件`));
  });
}

test('樣本涵蓋：接單、拒單、兩種逾時、連續兩張、短暫遮住、acceptedAt＝goneAt', () => {
  const all = fixture.cases.flatMap((c) => run(c).filter((e) => e.type === 'decided').map((e) => ({ c, e })));
  const has = (f) => all.some(f);
  assert.ok(has(({ e }) => e.result === 'accept' && e.reason === 'accepted'));
  assert.ok(has(({ e }) => e.result === 'reject' && e.reason === 'rejected'));
  assert.ok(has(({ c, e }) => e.reason === 'timeout' && e.result === 'accept' && (c.settings?.ambiguousAs ?? 'accept') === 'accept'));
  assert.ok(has(({ c, e }) => e.reason === 'timeout' && e.result === 'reject' && c.settings?.ambiguousAs === 'reject'));
  assert.ok(has(({ e }) => e.reason === 'superseded'));
  // 所有「接單」的 acceptedAt 都等於邀請消失（第一次沒看到接單鈕）的時間，不是判定時間
  for (const { e } of all.filter(({ e }) => e.result === 'accept')) {
    assert.ok(e.acceptedAt < e.decidedAt || e.waitSec === 0, JSON.stringify(e));
    assert.equal(Math.round((e.decidedAt - e.acceptedAt) * 10) / 10, e.waitSec);
  }
});

test('deadline：只有 deciding 才有（goneAt＋decideWindowSec），給 extension 排計時器', () => {
  const t = new OfferTracker(DEFAULT_OFFER, 90);
  const s = (k) => summarizeScreen(fixture.screens[k]);
  assert.equal(t.deadline, null);
  t.observe(0, s('INVITE_27'));
  assert.equal(t.kind, 'offered');
  assert.equal(t.deadline, null);
  t.observe(2, s('BLANK'));
  t.observe(4, s('BLANK'));
  assert.equal(t.kind, 'deciding');
  assert.equal(t.deadline, 2 + DEFAULT_OFFER.decideWindowSec);
  t.observe(5, s('PICKUP'));
  assert.equal(t.kind, 'idle');
  assert.equal(t.deadline, null);
});

test('acceptDelaySeconds：四捨五入、夾 0…60', () => {
  assert.equal(acceptDelaySeconds(10, 4.5), 6);
  assert.equal(acceptDelaySeconds(10, 12), 0);
  assert.equal(acceptDelaySeconds(100, 0), 60);
  assert.equal(acceptDelaySeconds(NaN, 0), 0);
});

test('Swift OfferTracker 與 TS 同結構（狀態、理由字串、預設值、延遲換算）', () => {
  const sw = read('../targets/broadcast/OfferTracker.swift');
  for (const reason of ['"accepted"', '"rejected"', '"timeout"', '"superseded"', '"replaced"', '"stopped"']) assert.ok(sw.includes(reason), reason);
  for (const s of ['case offered(Offer, misses: Int, firstMissAt: Date?)', 'case deciding(Offer, goneAt: Date, lastKw: [String])',
    'if accepted && !o.offerRejected', 'if o.offerRejected && !accepted', 'acceptedAt: accept ? (goneAt ?? now) : nil',
    'if accept { recentAccepted.append((minutes: offer.minutes, amount: offer.amount, at: now)) }', 'return min(60, max(0, Int(d)))',
    'return a == 0 || b == 0 || a == b', 'var seen = Self.noted(Self.filled(offer, o.amount), o)',
    '"\\(minutes)/\\(ScreenInfo.amountKey(amount))"']) {
    assert.ok(sw.includes(s), s);
  }
  // extension：畫面靜止時靠計時器推進；停止時先結案再送 stopped
  const ext = read('../targets/broadcast/SampleHandler.swift');
  assert.ok(ext.includes('self.handleOffer(self.tracker.tick(Date()), info: nil)'));
  const fin = ext.slice(ext.indexOf('func finish()'), ext.indexOf('/// 每 60 秒'));
  assert.ok(fin.indexOf('self.tracker.finish(Date())') < fin.indexOf('PandaSignal.post(PandaSignal.stopped)'));
});

test('v0.7 實機修正：同一張邀請先沒抓到金額、後來抓到 → 補齊金額，不算第二張；接單後去重也只比分鐘', () => {
  const t = new OfferTracker(DEFAULT_OFFER, 90);
  const s = (text) => summarizeScreen(text);
  const noAmt = '27 分鐘\n拒絕\n接受訂單';
  const withAmt = '110.26 $ 6.7公里\n27 分鐘\n拒絕\n接受訂單';
  const ev = [];
  ev.push(...t.observe(0, s(noAmt)));
  ev.push(...t.observe(25, s(withAmt)));
  ev.push(...t.observe(26.5, s(withAmt)));
  assert.deepEqual(ev.map((e) => e.type), ['seen']);
  ev.push(...t.observe(28, s('')), ...t.observe(29.5, s('')), ...t.observe(31, s('前往取餐')));
  const decided = ev.filter((e) => e.type === 'decided');
  assert.equal(decided.length, 1);
  assert.equal(decided[0].offer.amount, 110.26);
  assert.equal(decided[0].offer.key, '27/110');
  // 接單後同一張（這次又沒抓到金額）回來 → dup，不是新單
  assert.deepEqual(t.observe(40, s(noAmt)).map((e) => e.type), ['dup']);
  // 不同金額（兩個都合理，例如含小費）＝不同張；v1.2 不可能地低的金額（< fare−0.01）＝誤讀，算同一張
  assert.equal(sameOffer(27, 110.26, 27, 140.26), false);
  assert.equal(sameOffer(27, 110.26, 27, 98.4), true);
  assert.equal(sameOffer(27, null, 27, 98.4), true);
  assert.equal(sameOffer(27, 0, 27, 98.4), true);
  assert.equal(sameOffer(27, 110.26, 18, 110.26), false);
});

test('v0.8 首日實測畫面：暗色主題邀請 → 接單後畫面判定接單；夾單邀請標 stacked（任一次看到就算）', () => {
  const s = (text) => summarizeScreen(text);
  const invite = '每單收入\n85.76 $\n(5.8 公里) ⓘ\n21 分鐘\n店名\n地址\n送餐資訊\n接受訂單';
  const stackedInvite = '夾單訂單依系統顯示金額為主\n+49.01 $\n(2.1 公里)\n12 分鐘\n店名A\n店名B\n接受訂單';
  const after = '店名\n預計7分鐘後抵達店家・1筆訂單\n再 8 分鐘即將準備完成\n#7318\n取餐體驗如何呢?記得邀請店家給好評!';
  const si = s(invite);
  assert.deepEqual([si.accept, si.minutes, si.amount, si.km, si.stacked], [true, 21, 85.76, 5.8, false]);
  const ss = s(stackedInvite);
  assert.deepEqual([ss.accept, ss.minutes, ss.amount, ss.stacked], [true, 12, 49.01, true]);
  assert.ok(ss.kw.includes('夾單'));
  const sa = s(after);
  assert.deepEqual([sa.offerAccepted, sa.offerRejected], [true, false]);
  for (const k of ['抵達店家', '筆訂單', '即將準備完成', '取餐體驗']) assert.ok(sa.kw.includes(k), k);
  // 一般邀請 → 接單後畫面：accepted、不是夾單
  let t = new OfferTracker(DEFAULT_OFFER, 90);
  const ev = [...t.observe(0, si), ...t.observe(0.6, s('')), ...t.observe(1.2, s('')), ...t.observe(1.8, sa)];
  const d = ev.find((e) => e.type === 'decided');
  assert.deepEqual([d.result, d.reason, d.offer.stacked, d.acceptedAt], ['accept', 'accepted', false, 0.6]);
  // 夾單字樣只在第二次 OCR 出現 → 仍標 stacked；active 在判定前為 true、判定後 false
  t = new OfferTracker(DEFAULT_OFFER, 90);
  const noBanner = s('+49.01 $\n12 分鐘\n接受訂單');
  assert.equal(noBanner.stacked, false);
  t.observe(0, noBanner);
  assert.equal(t.active, true);
  t.observe(0.6, ss);
  t.observe(1.2, s(''));
  t.observe(1.8, s(''));
  const d2 = t.observe(2.4, sa).find((e) => e.type === 'decided');
  assert.equal(d2.offer.stacked, true);
  assert.equal(t.active, false);
  // Swift 同步
  const sw = read('../targets/broadcast/OfferTracker.swift');
  assert.equal([...sw.matchAll(/if o\.stacked \{ seen\.stacked = true \}/g)].length, 3);
  assert.ok(sw.includes('stacked: o.stacked)'));
  assert.ok(read('../targets/broadcast/OrderDetector.swift').includes('stacked: stacked,'));
});
