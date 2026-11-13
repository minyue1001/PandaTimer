// v0.9 省電：away 模式（pandarider 不在畫面上）、低電量/過熱倍率、遠端設定、Swift 與 TS 同規則、App 心跳 update 節流
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  AwayTracker,
  DEFAULT_AWAY,
  DEFAULT_AWAY_KEYWORDS,
  DEFAULT_POWER,
  THERMAL,
  effectiveTiming,
  isSaver,
  pandaPresent,
} from '../src/powerSaver.ts';
import { planOcr } from '../src/frameTrigger.ts';
import { DEFAULT_CONFIG, DEFAULT_KEEP_ALIVE, RANGES, validateConfig } from '../src/remoteConfig.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const S = {
  ocrIntervalSeconds: 1.5, idleOcrIntervalSeconds: 1.5, idleAfterMisses: 3, fastOcrIntervalSeconds: 0.6,
  changeMinBits: 120, changeMinGapSeconds: 0.6, sameFrameMaxBits: 40, forceOcrSeconds: 10,
};

test('pandarider 特徵詞：首日實測畫面都算；地圖/LINE/主畫面不算；接單鈕一律算', () => {
  for (const text of [
    '上線中', '每單收入\n85.76 $\n(5.8 公里)\n21 分鐘', '預計 7 分鐘後抵達店家・1筆訂單', '再 8 分鐘即將準備完成\n取餐體驗如何呢?',
    '是否已送達?\n確認已送達', '訂單完成', '夾單訂單依系統顯示金額為主', '休 息 中', '预计 12 分钟', '導航',
  ]) {
    assert.equal(pandaPresent(text, false), true, text);
  }
  for (const text of ['', null, '12 分鐘 · 3.4 公里\n沿著中山路直走', '好喔 晚點到\n傳送', '設定\n相機\n照片', '85.76 $']) {
    assert.equal(pandaPresent(text, false), false, String(text));
  }
  assert.equal(pandaPresent('隨便什麼', true), true);
  // 自訂正則；編不過退回預設；空字串命中不算
  assert.equal(pandaPresent('外送中', false, '外送中'), true);
  assert.equal(pandaPresent('上線中', false, '(['), true);
  assert.equal(pandaPresent('abc', false, 'x|'), false);
});

test('away 狀態機：連 5 次沒特徵詞才 away；特徵詞／判定中／綠色觸發立刻回正常；關閉＝永遠正常', () => {
  const a = new AwayTracker();
  const seq = [];
  for (let i = 0; i < 6; i++) seq.push(a.observeOcr(false, false));
  assert.deepEqual(seq.slice(0, 4), [null, null, null, null]);
  assert.deepEqual(seq[4], { mode: 'away', reason: 'noPanda' });
  assert.equal(seq[5], null); // 已經 away 不重報
  assert.equal(a.away, true);
  assert.deepEqual(a.observeOcr(true, false), { mode: 'normal', reason: 'panda' });
  // 中間看到一次特徵詞 → 重新數
  for (let i = 0; i < 4; i++) a.observeOcr(false, false);
  assert.equal(a.observeOcr(true, false), null);
  for (let i = 0; i < 4; i++) assert.equal(a.observeOcr(false, false), null);
  assert.equal(a.away, false);
  assert.deepEqual(a.observeOcr(false, false), { mode: 'away', reason: 'noPanda' });
  // 綠色觸發
  assert.deepEqual(a.observeGreen(), { mode: 'normal', reason: 'green' });
  assert.equal(a.observeGreen(), null);
  // 邀請判定中（或送達待定）視同在 pandarider：不會進 away
  const b = new AwayTracker();
  for (let i = 0; i < 20; i++) assert.equal(b.observeOcr(false, true), null);
  for (let i = 0; i < 4; i++) b.observeOcr(false, false);
  assert.deepEqual(b.observeOcr(false, false), { mode: 'away', reason: 'noPanda' });
  assert.deepEqual(b.observeOcr(false, true), { mode: 'normal', reason: 'offer' });
  // 遠端關掉 → 回正常、不再進 away
  const c = new AwayTracker();
  for (let i = 0; i < 5; i++) c.observeOcr(false, false);
  assert.equal(c.away, true);
  const off = { ...DEFAULT_AWAY, enabled: false };
  assert.deepEqual(c.observeOcr(false, false, off), { mode: 'normal', reason: 'disabled' });
  for (let i = 0; i < 10; i++) assert.equal(c.observeOcr(false, false, off), null);
  // afterMisses 可調
  const d = new AwayTracker();
  assert.deepEqual(d.observeOcr(false, false, { ...DEFAULT_AWAY, afterMisses: 1 }), { mode: 'away', reason: 'noPanda' });
});

test('省電判定：低電量模式或 thermal ≥ serious；可遠端改門檻/關低電量', () => {
  assert.equal(isSaver(false, THERMAL.nominal), false);
  assert.equal(isSaver(false, THERMAL.fair), false);
  assert.equal(isSaver(true, THERMAL.nominal), true);
  assert.equal(isSaver(false, THERMAL.serious), true);
  assert.equal(isSaver(false, THERMAL.critical), true);
  assert.equal(isSaver(true, 0, { ...DEFAULT_POWER, onLowPower: false }), false);
  assert.equal(isSaver(false, THERMAL.critical, { ...DEFAULT_POWER, thermalLevel: 4 }), false); // 4＝不看溫度
  assert.equal(isSaver(false, THERMAL.fair, { ...DEFAULT_POWER, thermalLevel: 1 }), true);
});

test('有效排程：正常不變；away 6 秒/取樣 0.5 秒/不做變化觸發；省電所有間隔 ×1.5；兩者疊加', () => {
  const normal = effectiveTiming(S, 0.2, { away: false, saver: false });
  assert.deepEqual(normal, { s: S, probeInterval: 0.2, changeEnabled: true });
  const away = effectiveTiming(S, 0.2, { away: true, saver: false });
  assert.equal(away.s.ocrIntervalSeconds, 6);
  assert.equal(away.s.idleOcrIntervalSeconds, 6);
  assert.equal(away.s.fastOcrIntervalSeconds, 0.6);
  assert.equal(away.probeInterval, 0.5);
  assert.equal(away.changeEnabled, false);
  const saver = effectiveTiming(S, 0.2, { away: false, saver: true });
  assert.ok(Math.abs(saver.probeInterval - 0.3) < 1e-9);
  assert.equal(saver.s.ocrIntervalSeconds, 2.25);
  assert.ok(Math.abs(saver.s.fastOcrIntervalSeconds - 0.9) < 1e-9);
  assert.ok(Math.abs(saver.s.changeMinGapSeconds - 0.9) < 1e-9);
  assert.equal(saver.s.forceOcrSeconds, 15);
  assert.equal(saver.s.changeMinBits, 120); // 位元門檻不是間隔
  assert.equal(saver.changeEnabled, true);
  const both = effectiveTiming(S, 0.2, { away: true, saver: true });
  assert.equal(both.s.ocrIntervalSeconds, 9);
  assert.equal(both.probeInterval, 0.75);
  // 倍率 1 ＝ 不省電
  assert.deepEqual(effectiveTiming(S, 0.2, { away: false, saver: true }, DEFAULT_AWAY, { ...DEFAULT_POWER, saverFactor: 1 }).s, S);
});

test('away 模式下的 OCR 排程：畫面變化不觸發、綠色照觸發、6 秒間隔、同畫面照樣跳過/強制', () => {
  const t = effectiveTiming(S, 0.2, { away: true, saver: false });
  const plan = (o) => planOcr({ fast: false, diffFromOcr: 900, diffFromPrev: 5, greenPending: false, interval: t.s.ocrIntervalSeconds, s: t.s, changeEnabled: t.changeEnabled, ...o });
  // 正常模式這會是 change
  assert.deepEqual(planOcr({ now: 10.8, lastOcrAt: 10, fast: false, diffFromOcr: 900, diffFromPrev: 5, greenPending: false, interval: 1.5, s: S }), { run: true, why: 'change' });
  assert.deepEqual(plan({ now: 10.8, lastOcrAt: 10 }), { run: false, skip: 'wait' });
  assert.deepEqual(plan({ now: 14, lastOcrAt: 10 }), { run: false, skip: 'wait' });
  assert.deepEqual(plan({ now: 16, lastOcrAt: 10 }), { run: true, why: 'interval' });
  assert.deepEqual(plan({ now: 10.8, lastOcrAt: 10, greenPending: true }), { run: true, why: 'green' });
  assert.deepEqual(plan({ now: 16, lastOcrAt: 10, diffFromOcr: 3 }), { run: false, skip: 'same' });
  assert.deepEqual(plan({ now: 20, lastOcrAt: 10, diffFromOcr: 3 }), { run: true, why: 'force' });
});

test('遠端設定 away/power/keepAlive/app.cardRefreshSeconds/telemetry.flushSeconds：預設、範圍、型別、列舉', () => {
  assert.deepEqual(DEFAULT_CONFIG.away, DEFAULT_AWAY);
  assert.deepEqual(DEFAULT_CONFIG.power, DEFAULT_POWER);
  assert.deepEqual(DEFAULT_CONFIG.keepAlive, { locationAccuracy: 'hundred', distanceFilterM: 50 });
  assert.deepEqual(DEFAULT_CONFIG.keepAlive, DEFAULT_KEEP_ALIVE);
  assert.equal(DEFAULT_CONFIG.app.cardRefreshSeconds, 300);
  assert.equal(DEFAULT_CONFIG.telemetry.flushSeconds, 60);
  assert.equal(DEFAULT_CONFIG.detector.heartbeatSeconds, 60); // 心跳維持 60 秒
  // v0.8 的設定（沒有新區塊）→ 全用預設
  const old = validateConfig({ version: 'v08' });
  assert.deepEqual([old.config.away, old.config.power, old.config.keepAlive], [DEFAULT_AWAY, DEFAULT_POWER, DEFAULT_KEEP_ALIVE]);
  const bad = validateConfig({
    version: 'x',
    away: { enabled: 'yes', afterMisses: 0, intervalSec: 0.5, probeIntervalSec: 3, keywords: '上線中|' },
    power: { saverFactor: 0.5, thermalLevel: 2.5, onLowPower: 1 },
    keepAlive: { locationAccuracy: 'best', distanceFilterM: -1 },
    app: { cardRefreshSeconds: 30 },
  });
  assert.deepEqual([bad.config.away, bad.config.power, bad.config.keepAlive], [DEFAULT_AWAY, DEFAULT_POWER, DEFAULT_KEEP_ALIVE]);
  assert.equal(bad.config.app.cardRefreshSeconds, 300);
  for (const k of ['away.enabled', 'away.afterMisses', 'away.intervalSec', 'away.probeIntervalSec', 'away.keywords', 'power.saverFactor',
    'power.thermalLevel', 'power.onLowPower', 'keepAlive.locationAccuracy', 'keepAlive.distanceFilterM', 'app.cardRefreshSeconds']) {
    assert.ok(bad.problems.some((p) => p.startsWith(k)), k);
  }
  const ok = validateConfig({
    version: 'y',
    away: { enabled: false, afterMisses: 8, intervalSec: 10, probeIntervalSec: 1, keywords: '外送' },
    power: { saverFactor: 2, thermalLevel: 3, onLowPower: false },
    keepAlive: { locationAccuracy: 'threeKilometers', distanceFilterM: 0 },
  });
  assert.deepEqual(ok.config.away, { enabled: false, afterMisses: 8, intervalSec: 10, probeIntervalSec: 1, keywords: '外送' });
  assert.deepEqual(ok.config.power, { saverFactor: 2, thermalLevel: 3, onLowPower: false });
  assert.deepEqual(ok.config.keepAlive, { locationAccuracy: 'threeKilometers', distanceFilterM: 0 });
  // 伺服器設定已升版並帶新區塊
  const cfg = JSON.parse(read('../server/config.json'));
  assert.ok(cfg.version >= '2026-11-14.1', `config version ${cfg.version} 應 ≥ 2026-11-14.1`);
  assert.deepEqual(validateConfig(cfg).problems, []);
});

test('Swift 與 TS 同規則：RemoteConfig 預設/範圍、AwayTracker、PowerTiming、取樣/排程接線', () => {
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  assert.equal(read('../targets/broadcast/RemoteConfig.swift'), rc);
  const a = DEFAULT_AWAY;
  const p = DEFAULT_POWER;
  for (const s of [
    `static let defaultKeywords =\n      "${DEFAULT_AWAY_KEYWORDS}"`, `var afterMisses = ${a.afterMisses}`, `var intervalSec = ${a.intervalSec.toFixed(1)}`,
    `var probeIntervalSec = ${a.probeIntervalSec}`, `var saverFactor = ${p.saverFactor}`, `var thermalLevel = ${p.thermalLevel}`,
    'var onLowPower = true', 'out.keywords = offerRegex(a["keywords"], out.keywords)',
    '(p.onLowPower && lowPower) || thermal >= p.thermalLevel',
    `var locationAccuracy = "${DEFAULT_KEEP_ALIVE.locationAccuracy}"`, `var distanceFilterM = ${DEFAULT_KEEP_ALIVE.distanceFilterM}`,
    'choice(k["locationAccuracy"], ["hundred", "kilometer", "threeKilometers"], out.locationAccuracy)',
    'flushSeconds: int(t["flushSeconds"], 5, 600, 60)',
  ]) {
    assert.ok(rc.includes(s), s);
  }
  let checked = 0;
  for (const [sec, v] of [['away', 'a'], ['power', 'p'], ['keepAlive', 'k']]) {
    for (const m of rc.matchAll(new RegExp(`(?:number|int)\\(${v}\\["(\\w+)"\\], ([0-9.]+), ([0-9.]+),`, 'g'))) {
      assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[`${sec}.${m[1]}`].slice(0, 2), m[1]);
      checked++;
    }
  }
  assert.equal(checked, 6);
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of [
    'if away || misses < s.afterMisses { return nil }', 'return Change(away: false, reason: panda ? "panda" : "offer")',
    'return Change(away: false, reason: "green")', 'return Change(away: false, reason: "disabled")',
    'let f = saver ? s.power.saverFactor : 1', 't.ocrInterval = (away ? s.away.intervalSec : s.ocrInterval) * f',
    't.idleOcrInterval = (away ? s.away.intervalSec : s.idleOcrInterval) * f', 't.fastOcrInterval = s.fastOcrInterval * f',
    't.changeMinGap = s.changeMinGap * f', 't.forceOcrInterval = s.forceOcrInterval * f',
    'let probe = (away ? s.away.probeIntervalSec : s.probeInterval) * f', 'return (t, probe, !away)',
    // 接線：取樣用 PowerTiming 的 probe、排程傳 changeEnabled、綠色觸發離開 away、OCR 後判定（判定中/送達待定算在 pandarider）
    'let probeEvery = PowerTiming.make(s, away: awayTracker.away, saver: saverFlag).probe',
    'changeEnabled: timing.changeEnabled', 'modeChange = awayTracker.observeGreen()',
    'let busyWithOffer = tracker.isActive || deliveryEdge.deadline != nil',
    'awayTracker.observeOcr(panda: panda, offerActive: busyWithOffer, s.away)',
    // v1.1：原文改交給 OrderNumbers.analyze（內部仍呼叫 analyzeWithPresence＋號碼摘要）
    'let analyzed = OrderNumbers.analyze(ocrText, rules: s.rules, awayKeywords: s.away.keywords, delivery: s.delivery)',
    'NSProcessInfoPowerStateDidChange', 'ProcessInfo.thermalStateDidChangeNotification',
    'telemetry.log("beat", statsFields().merging(powerFields(reset: true)) { $1 })',
  ]) {
    assert.ok(ext.includes(s), s);
  }
  assert.ok(read('../targets/broadcast/OrderDetector.swift').includes(
    'firstOfferMatch(compact(raw), awayKeywords, fallback: RemoteConfig.AwaySettings.defaultKeywords) != nil'));
  assert.ok(read('../targets/broadcast/OrderNumbers.swift').includes(
    'let analyzed = ScreenInfo.analyzeWithPresence(raw, rules: rules, awayKeywords: awayKeywords)'));
  // extension 不碰 UIKit（電量只在 App 量）
  assert.ok(!/^import UIKit/m.test(ext));
});

test('App：心跳 update 節流、電量量測、省電中字樣、定位精度遠端設定（預設維持 v0.5 實測的百米/50m）', () => {
  const hub = read('../modules/live-activity/ios/DetectorHub.swift');
  for (const s of [
    'pushCard(note: nil, throttle: true)', 'cardRefresh = RemoteConfig.cardRefreshSeconds(root)',
    'let due = !throttle || lastCardPushAt.map { now.timeIntervalSince($0) >= cardRefresh } ?? true',
    '&& Self.stableDiag(current.state.diag) == Self.stableDiag(text)',
    'of: "App 已收到心跳 [0-9]{1,2}:[0-9]{2}:[0-9]{2}", with: "App 已收到心跳", options: .regularExpression',
    'parts.append("App 已收到心跳 \\(Self.hms(beat))")',
    'device.isBatteryMonitoringEnabled = true', 'ProcessInfo.processInfo', 'if RemoteConfig.deviceSaver(power).saver { parts.append("省電中") }',
    'keepAlive.configure(accuracy: k.locationAccuracy, distanceFilterM: k.distanceFilterM)',
    'case "threeKilometers": m.desiredAccuracy = kCLLocationAccuracyThreeKilometers',
    'default: m.desiredAccuracy = kCLLocationAccuracyHundredMeters',
    'm.distanceFilter = distanceFilterM > 0 ? CLLocationDistance(distanceFilterM) : kCLDistanceFilterNone',
    'm.pausesLocationUpdatesAutomatically = false', 'm.showsBackgroundLocationIndicator = true',
  ]) {
    assert.ok(hub.includes(s), s);
  }
  // 倒數由系統畫（Text style .timer），沒有任何每秒 update 的計時器
  const widget = read('../targets/widget/PandaLiveActivity.swift');
  assert.ok(widget.includes('Text(context.state.deadline, style: .timer)'));
  for (const f of ['../modules/live-activity/ios/DetectorHub.swift', '../modules/live-activity/ios/LiveActivityModule.swift', '../targets/widget/PandaLiveActivity.swift']) {
    assert.ok(!/Timer\.scheduledTimer|TimelineView\(\.periodic/.test(read(f)), f);
  }
});
