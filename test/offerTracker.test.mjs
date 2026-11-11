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
    'if o.offerAccepted && !o.offerRejected', 'if o.offerRejected && !o.offerAccepted', 'acceptedAt: accept ? (goneAt ?? now) : nil',
    'if accept { recentAccepted.append((minutes: offer.minutes, amount: offer.amount, at: now)) }', 'return min(60, max(0, Int(d)))',
    'return a == 0 || b == 0 || a == b', 'var seen = Self.filled(offer, o.amount)',
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
  // 不同金額＝不同張
  assert.equal(sameOffer(27, 110.26, 27, 98.4), false);
  assert.equal(sameOffer(27, null, 27, 98.4), true);
  assert.equal(sameOffer(27, 0, 27, 98.4), true);
  assert.equal(sameOffer(27, 110.26, 18, 110.26), false);
});
