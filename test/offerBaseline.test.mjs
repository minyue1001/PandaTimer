// v1.2.8「接單證據必須是邀請前沒有的新東西」（11/22 09:17、09:19、09:31 實機：帶著單時沒接的邀請，消失後露出原本那張的
// 店家頁 → 被判接單）。規則以 src/offerTracker.ts（acceptEvidence / resetLevel / baselineOf）＋src/screenInfo.ts（acceptTerms 摘要）
// 為準；Swift＝targets/broadcast/OfferTracker.swift、OrderDetector.swift。實機重建樣本在 test/fixtures/offer-cases.json（v1.2.8）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BASELINE_SEC, DEFAULT_OFFER, MAX_BASELINE_LOG, MULTI_SEC, WEAK_BASELINE_SEC, OfferTracker, acceptEvidence, baselineOf, resetLevel,
} from '../src/offerTracker.ts';
import { DEFAULT_SCREEN_RULES, summarizeScreen, termDigest, termParts } from '../src/screenInfo.ts';
import { clearedReasonFor } from '../src/offerIsland.ts';
import { EMPTY_STATE, clearOffer, recordOffer } from '../src/unconfirmedOffers.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const STORE = '店名\n預計9分鐘後抵達店家・1筆訂單\n再 6 分鐘即將準備完成\n取餐體驗如何呢?';

test('termDigest＝FNV-1a 32（UTF-16）；termParts 含所有 ≥2 字子字串（少讀前後字也對得上）', () => {
  assert.equal(termDigest('a'), 'e40c292c'); // FNV-1a 標準向量
  assert.equal(termDigest(''), '811c9dc5');
  assert.equal(termDigest('抵達店家'), 'f0e65955');
  const parts = termParts('即將準備完成');
  for (const sub of ['即將準備完成', '準備完成', '即將', '準備']) assert.ok(parts.includes(termDigest(sub)), sub);
  assert.ok(!parts.includes(termDigest('完')));
  assert.equal(termParts('x'.repeat(17)).length, 1);
});

test('summarizeScreen：acceptTerms＝去掉常駐字後的強接單字摘要（不留原文）；pickedUp / otherPage', () => {
  const s = summarizeScreen(STORE);
  assert.deepEqual(s.acceptTerms, [termDigest('抵達店家'), termDigest('即將準備完成')]);
  assert.ok(s.acceptTermParts.includes(termDigest('準備完成')));
  assert.deepEqual([s.pickedUp, s.otherPage], [false, false]);
  // 只有常駐字（送餐段）→ 沒有強接單字、是別的頁
  const leg = summarizeScreen('即將抵達\n1筆訂單\n取餐體驗如何呢?');
  assert.deepEqual([leg.acceptTerms, leg.otherPage], [[], true]);
  assert.equal(summarizeScreen('送達\n45.00 $').otherPage, true);
  assert.equal(summarizeScreen('取消').otherPage, true);
  // 邀請卡滑動中（沒讀到接單鈕）、別的 App（沒有白名單字）、空白 → 不是別的頁
  assert.equal(summarizeScreen('每單收入\n45.00 $').otherPage, false);
  assert.equal(summarizeScreen('夾單訂單依系統顯示金額為主').otherPage, false);
  assert.equal(summarizeScreen('LINE\n王小明：晚點到').otherPage, false);
  assert.equal(summarizeScreen('').otherPage, false);
  assert.equal(summarizeScreen('是否已取餐?\n確認已取餐').pickedUp, true);
  // 隱私：自訂正則抓到店名也只留摘要
  const custom = summarizeScreen('抵達鬍鬚張魯肉飯', { ...DEFAULT_SCREEN_RULES, acceptedKeywords: '抵達.{0,6}' });
  assert.ok(!JSON.stringify(custom).includes('鬍鬚張'));
});

test('resetLevel：送達/取餐確認＝hard；別的頁、「1筆訂單」沒強接單字＝soft；店家頁＝0', () => {
  assert.equal(resetLevel(summarizeScreen('訂單完成')), 2);
  assert.equal(resetLevel(summarizeScreen('完成訂單')), 2);
  assert.equal(resetLevel(summarizeScreen('是否已取餐?')), 2);
  assert.equal(resetLevel(summarizeScreen('送達\n45.00 $')), 1);
  assert.equal(resetLevel(summarizeScreen('即將抵達\n1筆訂單')), 1);
  assert.equal(resetLevel(summarizeScreen(STORE)), 0);
  assert.equal(resetLevel(summarizeScreen('')), 0);
  assert.equal(resetLevel({ offerAccepted: false, orders: 1 }), 1); // 舊樣本沒有 acceptTerms
});

test('baselineOf：從最新往回累積；hard 停、soft 只在 MULTI_SEC 內沒看過 N≥2 時停；超過 BASELINE_SEC 不算', () => {
  const e = (at, terms, reset = 0, orders = null, weak = false) => ({ at, terms, reset, orders, weak });
  assert.deepEqual(baselineOf([e(0, ['a']), e(10, ['b'])], 20).terms.sort(), ['a', 'b']);
  // soft：停在那一幀（它自己算進去）
  assert.deepEqual(baselineOf([e(0, ['a']), e(10, ['b'], 1), e(15, ['c'])], 20).terms.sort(), ['b', 'c']);
  // 手上兩張 → soft 不停；hard 照停
  assert.deepEqual(baselineOf([e(0, ['a']), e(5, [], 0, 2), e(10, [], 1)], 20).terms, ['a']);
  assert.deepEqual(baselineOf([e(0, ['a']), e(5, [], 0, 2), e(10, [], 2)], 20).terms, []);
  // N≥2 是 MULTI_SEC 以前看到的 → soft 照停
  assert.deepEqual(baselineOf([e(0, ['a'], 0, 2), e(MULTI_SEC + 5, [], 1)], MULTI_SEC + 10).terms, []);
  assert.deepEqual(baselineOf([e(0, ['a'])], BASELINE_SEC + 1).terms, []);
  const b = baselineOf([e(0, ['a'], 0, 1, true), e(5, ['b'], 0, 2)], 10);
  assert.deepEqual([b.weak, b.orders], [true, 2]);
  // 常駐字：WEAK_BASELINE_SEC 內看過就算，過期標記擋不住（送餐段→「送達 $」頁→邀請沒接→又回送餐段：只剩常駐字不算接單）
  assert.equal(baselineOf([e(0, [], 0, 1, true), e(10, [], 1)], 20).weak, true);
  assert.equal(baselineOf([e(0, [], 0, 1, true), e(WEAK_BASELINE_SEC + 5, [], 1)], WEAK_BASELINE_SEC + 10).weak, false);
  assert.equal(baselineOf([e(0, [], 0, 1), e(10, [], 1)], 20).orders, 1); // N 同上（疊單 1→2 照算）
});

test('acceptEvidence：N 變大＝是；強接單字要有邀請前沒看過的；只剩常駐字看 baseWeak；舊樣本＝舊行為', () => {
  const s = summarizeScreen(STORE);
  const seen = { baseWeak: true, baseOrders: 1, baseTerms: s.acceptTermParts };
  assert.equal(acceptEvidence(seen, s), false);
  assert.equal(acceptEvidence({ ...seen, baseTerms: [] }, s), true);
  assert.equal(acceptEvidence({ ...seen, baseTerms: summarizeScreen('預計5分鐘後抵達店家').acceptTermParts }, s), true); // 即將準備完成是新的
  assert.equal(acceptEvidence(seen, summarizeScreen('預計7分鐘後抵達店家・2筆訂單\n再 8 分鐘即將準備完成')), true); // N 1→2
  assert.equal(acceptEvidence(seen, summarizeScreen('預計9分鐘後抵達店家\n準備完成')), false); // 少讀前字也算看過
  assert.equal(acceptEvidence({ baseWeak: true, baseOrders: 1 }, { offerAccepted: true }), true);
});

test('tracker：邀請消失途中/判定中的畫面也進紀錄（對下一張是邀請前）；紀錄有上限', () => {
  const t = new OfferTracker({ ...DEFAULT_OFFER, ambiguousAs: 'reject', decideWindowSec: 60 }, 90);
  const inv = (m, a) => summarizeScreen(`每單收入\n${a} $\n${m} 分鐘\n送餐資訊\n接受訂單`);
  const ev = [];
  ev.push(...t.observe(0, inv(14, '57.17')), ...t.observe(1.5, summarizeScreen('')), ...t.observe(3, summarizeScreen(STORE)));
  assert.deepEqual(ev.filter((e) => e.type === 'decided').map((e) => e.result), ['accept']); // 空手接單
  // 那張的店家頁是在判定時看到的（非 idle）→ 下一張邀請（沒接）消失後同一頁 → 不是證據
  ev.length = 0;
  ev.push(...t.observe(100, inv(16, '65.34')), ...t.observe(101.5, summarizeScreen(STORE)), ...t.observe(103, summarizeScreen(STORE)));
  ev.push(...t.tick(170));
  assert.deepEqual(ev.filter((e) => e.type === 'decided').map((e) => [e.result, e.reason]), [['reject', 'timeout']]);
  for (let i = 0; i < MAX_BASELINE_LOG + 50; i++) t.observe(200 + i * 0.1, summarizeScreen(STORE));
  assert.equal(t.idleLog.length, MAX_BASELINE_LOG);
});

test('證據不足 → timeout → offer.cleared.timeout → App 立刻出「你有接嗎？」卡', () => {
  assert.equal(clearedReasonFor('timeout'), 'timeout');
  const s = clearOffer(recordOffer(EMPTY_STATE, 20, 1_000_000, 'x'), 20, clearedReasonFor('timeout'));
  assert.deepEqual(s.unconfirmed.map((e) => e.id), ['x']);
  const ext = read('../targets/broadcast/SampleHandler.swift');
  assert.ok(ext.includes('case "rejected", "replaced": return "reject"') && ext.includes('default: return "timeout"'));
});

test('Swift 鏡像：OfferTracker / OrderDetector 的 v1.2.8 規則與常數', () => {
  const ot = read('../targets/broadcast/OfferTracker.swift');
  for (const s of [
    `static let baselineSec: TimeInterval = ${BASELINE_SEC}`,
    `static let multiSec: TimeInterval = ${MULTI_SEC}`,
    `static let maxLog = ${MAX_BASELINE_LOG}`,
    'if let n = o.orders, let base = offer.baseOrders, n > base { return true }',
    'if !o.acceptStrong { return !offer.baseWeak }',
    'return o.acceptTerms.contains { !offer.baseTerms.contains($0) }',
    'if o.delivered || o.pickedUp { return 2 }',
    'if o.otherPage || (o.orders == 1 && o.acceptTerms.isEmpty) { return 1 }',
    'let multi = recent.contains { now.timeIntervalSince($0.at) <= Self.multiSec && ($0.orders ?? 0) >= 2 }',
    'if e.reset == 2 || (e.reset == 1 && !multi) { break }',
    `static let weakBaselineSec: TimeInterval = ${WEAK_BASELINE_SEC}`,
    'for e in recent where now.timeIntervalSince(e.at) <= Self.weakBaselineSec { take(e) }',
    'BaselineEntry(at: now, weak: o.acceptWeak, orders: o.orders, terms: o.acceptTermParts, reset: Self.resetLevel(o)))',
    'let base = Self.baselineOf(idleLog, now)',
  ]) assert.ok(ot.includes(s), s);
  // 非邀請畫面在 switch state 之前就記（任何狀態）
  const obs = ot.slice(ot.indexOf('// 畫面上沒有接單鈕'), ot.indexOf('case .offered(let current, let misses, let firstMissAt):'));
  assert.ok(obs.indexOf('idleLog.append(') < obs.indexOf('switch state {'));
  const od = read('../targets/broadcast/OrderDetector.swift');
  for (const s of [
    'var h: UInt32 = 0x811c_9dc5', 'h = h &* 0x0100_0193', 'return String(format: "%08x", h)', 'if u.count > 16 { return [termDigest(u)] }',
    'static let pickedUpPattern = "已取餐|已取单"', 'static let offerCardPattern = "每單收入|每单收入|夾單|夹单"',
    'otherPage: !accept && !kw.isEmpty && terms.isEmpty && !offerCard',
    'weak != nil ? stripWeak(text, rules.weakAcceptedKeywords) : text, rules.acceptedKeywords,',
  ]) assert.ok(od.includes(s), s);
});
