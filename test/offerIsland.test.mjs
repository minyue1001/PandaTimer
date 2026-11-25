// v1.0 偵測到邀請 → 動態島立即顯示：TS 規則（src/offerIsland.ts）＋Swift 原始碼（DetectorHub / widget / extension）文字與規則一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  clearedReasonFor, DEFAULT_OFFER_ISLAND, isShortOffer, modeAfterClear, offerCardAction, offerExpired, offerFare, offerTexts, OFFER_ISLAND_SECONDS, OFFER_WARN_TEXT,
} from '../src/offerIsland.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const hub = read('../modules/live-activity/ios/DetectorHub.swift');
const widget = read('../targets/widget/PandaLiveActivity.swift');
const ext = read('../targets/broadcast/SampleHandler.swift');

test('金額＝平台確切報酬（19 分 $77.59、12 分 $49.01、短單 45）；Swift 整數分算法逐分一致', () => {
  assert.equal(offerFare(19), 77.59);
  assert.equal(offerFare(12), 49.01);
  assert.equal(offerFare(21), 85.76);
  assert.equal(offerFare(5), 45);
  // DetectorHub.offerFare：cents = minutes * 24500 / 60 + 1（整數除法）、max(4500)
  assert.ok(hub.includes('let cents = minutes * 24500 / 60 + 1') && hub.includes('return Double(max(4500, cents)) / 100'));
  for (let m = 1; m <= 90; m++) {
    const swift = Math.max(4500, Math.floor((m * 24500) / 60) + 1) / 100;
    assert.equal(swift, offerFare(m), `${m} 分`);
  }
});

test('文字：compact「19分✓」、minimal「19」、展開/鎖定「✓ 已偵測 19 分邀請」「$77.59・可以按接受」、提示', () => {
  const t = offerTexts(19, offerFare(19));
  assert.deepEqual(t, {
    compact: '19分✓',
    minimal: '19',
    title: '✓ 已偵測 19 分邀請',
    subtitle: '$77.59・可以按接受',
    badge: '＋偵測到 19 分邀請・$77.59・可以按接受',
    alertTitle: '已偵測 19 分邀請',
    alertBody: '可以按接受訂單',
    alertBodyCounting: '可以按接受訂單・倒數照常進行',
  });
  assert.equal(offerTexts(7, null).subtitle, '可以按接受');
  // widget 的組字（Swift 插值）
  for (const s of ['Text(offerCompact(context.state))', 'Text(offerMinimal(context.state))', 'Text(offerTitle(state))',
    '"✓ 已偵測 \\(state.offerMin ?? 0) 分邀請"', '"\\(state.offerMin ?? 0)分✓"', 'String(format: "$%.2f・", $0)',
    'return amount + (state.offerWarn ?? "可以按接受")', '"＋偵測到 \\(m) 分邀請・"', 'Text(offerBadgeText(state, m))',
    'Text("偵測於 \\(at, format: .dateTime.hour().minute().second())")']) {
    assert.ok(widget.includes(s), s);
  }
  // App 的提示文字
  assert.ok(hub.includes('static func offerAlertTitle(_ minutes: Int) -> String { "已偵測 \\(minutes) 分邀請" }'));
  assert.ok(hub.includes(`static let offerAlertBody = "${t.alertBody}"`));
  assert.ok(hub.includes(`static let offerAlertBodyCounting = "${t.alertBodyCounting}"`));
});

test('卡片怎麼變：待命→offer、倒數中→不蓋倒數只加一行、關閉→不動；清除後 offer→standby；60 秒過期', () => {
  assert.equal(offerCardAction('standby'), 'offer');
  assert.equal(offerCardAction('offer'), 'offer');
  assert.equal(offerCardAction('stopped'), 'offer');
  assert.equal(offerCardAction('countdown'), 'badge');
  assert.equal(offerCardAction('standby', { ...DEFAULT_OFFER_ISLAND, islandIndicator: false }), 'none');
  assert.equal(modeAfterClear('offer'), 'standby');
  assert.equal(modeAfterClear('countdown'), 'countdown');
  assert.equal(OFFER_ISLAND_SECONDS, 60);
  assert.equal(offerExpired(0, 59_999), false);
  assert.equal(offerExpired(0, 60_000), true);
  // Swift：同規則
  assert.ok(hub.includes('static let offerIslandSeconds: TimeInterval = 60'));
  assert.ok(hub.includes('guard island.islandIndicator else { return }'));
  assert.ok(hub.includes('let counting = state.mode == "countdown"'));
  assert.ok(hub.includes('state.mode = "offer"'));
  assert.ok(hub.includes('if state.mode == "offer" {\n        state.mode = "standby"'));
  assert.ok(hub.includes('staleDate = at.addingTimeInterval(Self.offerIslandSeconds)'));
  assert.ok(hub.includes('await card.update(ActivityContent(state: state, staleDate: staleDate), alertConfiguration: alert)'));
  assert.ok(hub.includes('let sound: AlertConfiguration.AlertSound = silent ? .named("") : .default'));
  assert.ok(widget.includes('context.state.mode == "offer" && context.state.offerMin != nil && !context.isStale'));
  // order → DetectorCardPlan.apply 一律清邀請欄位（三份逐字相同另有 diff 測試）
  const plan = read('../modules/live-activity/ios/DetectorCardPlan.swift');
  assert.ok(plan.includes('state.offerMin = nil\n    state.offerAmount = nil\n    state.offerAt = nil\n    state.offerWarn = nil\n    guard let main = items.first'));
});

test('extension：判定原因 → cleared 原因（reject 只給明確拒單/換單）', () => {
  assert.equal(clearedReasonFor('rejected'), 'reject');
  assert.equal(clearedReasonFor('replaced'), 'reject');
  assert.equal(clearedReasonFor('stopped'), 'stopped');
  assert.equal(clearedReasonFor('timeout'), 'timeout');
  assert.equal(clearedReasonFor('superseded'), 'timeout');
  assert.ok(ext.includes('case "rejected", "replaced": return "reject"\n    case "stopped": return "stopped"\n    default: return "timeout"'));
});

test('共用 Swift：PandaTimerAttributes／DetectorCardPlan 三份、RemoteConfig 兩份逐字相同；新欄位 Optional＋預設 nil', () => {
  const attrs = read('../modules/live-activity/ios/PandaTimerAttributes.swift');
  assert.equal(read('../native/intents/PandaTimerAttributes.swift'), attrs);
  assert.equal(read('../targets/widget/PandaTimerAttributes.swift'), attrs);
  for (const f of ['var offerMin: Int? = nil', 'var offerAmount: Double? = nil', 'var offerAt: Date? = nil', 'var offerWarn: String? = nil']) assert.ok(attrs.includes(f), f);
  const plan = read('../modules/live-activity/ios/DetectorCardPlan.swift');
  assert.equal(read('../native/intents/DetectorCardPlan.swift'), plan);
  assert.equal(read('../targets/widget/DetectorCardPlan.swift'), plan);
  assert.equal(read('../targets/broadcast/RemoteConfig.swift'), read('../modules/live-activity/ios/RemoteConfig.swift'));
});

test('v1.2.9 短單提醒：isShortOffer 邊界、文字（⚠️ 短單 8 分／$45.00・建議不接／compact ⚠️8）、Swift 同構', () => {
  assert.equal(DEFAULT_OFFER_ISLAND.shortWarnMinutes, 10);
  assert.equal(OFFER_WARN_TEXT, '建議不接');
  assert.equal(isShortOffer(10, 10), true);
  assert.equal(isShortOffer(11, 10), false);
  assert.equal(isShortOffer(1, 10), true);
  assert.equal(isShortOffer(0, 10), false);
  assert.equal(isShortOffer(8, 0), false); // 0＝關閉
  assert.equal(isShortOffer(30, 30), true);
  const t = offerTexts(8, offerFare(8), true);
  assert.deepEqual(t, {
    compact: '⚠️8',
    minimal: '⚠️',
    title: '⚠️ 短單 8 分',
    subtitle: '$45.00・建議不接',
    badge: '＋⚠️ 短單 8 分・$45.00・建議不接',
    alertTitle: '⚠️ 短單 8 分',
    alertBody: '建議不接這單',
    alertBodyCounting: '建議不接這單・倒數照常進行',
  });
  assert.equal(offerTexts(8, null, true).subtitle, '建議不接');
  assert.equal(offerTexts(19, offerFare(19), false).title, '✓ 已偵測 19 分邀請'); // 非短單照舊
  // Swift：DetectorHub 與 widget
  for (const s of ['static let offerWarnText = "建議不接"',
    'static func isShortOffer(_ minutes: Int, warnMinutes: Int) -> Bool { warnMinutes > 0 && minutes > 0 && minutes <= warnMinutes }',
    'static func offerWarnAlertTitle(_ minutes: Int) -> String { "⚠️ 短單 \\(minutes) 分" }', 'static let offerWarnAlertBody = "建議不接這單"',
    'static let offerWarnAlertBodyCounting = "建議不接這單・倒數照常進行"',
    'state.offerWarn = short ? Self.offerWarnText : nil', 'island.shortWarnMinutes']) assert.ok(hub.includes(s), s);
  for (const s of ['"⚠️ 短單 \\(state.offerMin ?? 0) 分"', '"⚠️\\(state.offerMin ?? 0)"', 'state.offerWarn != nil ? "⚠️" :',
    '"＋⚠️ 短單 \\(m) 分・"', 'state.offerWarn != nil ? offerRed : offerYellow']) assert.ok(widget.includes(s), s);
  // clearOfferFields 一併清 offerWarn
  assert.ok(hub.includes('state.offerAt = nil\n    state.offerWarn = nil\n  }'));
});
