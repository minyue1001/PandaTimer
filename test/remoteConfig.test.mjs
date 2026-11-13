// v0.6 遠端設定：預設值、欄位缺漏/不合法時用預設、自訂設定的挑選規則、Swift/TS/JSON 預設與範圍一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_PICKER, detectNewOrderMinutes, hasAcceptButton, pickAmount, pickMinutes } from '../src/ocrPick.ts';
import { DEFAULT_CONFIG, RANGES, validateConfig } from '../src/remoteConfig.ts';
import { summarizeScreen } from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));

test('server/config.default.json＝內建預設（只差 version），驗證零問題；server/config.json 也合法', () => {
  const def = json('../server/config.default.json');
  const { config, problems } = validateConfig(def);
  assert.deepEqual(problems, []);
  assert.deepEqual({ ...config, version: 'default' }, DEFAULT_CONFIG);
  assert.notEqual(def.version, 'default');
  assert.deepEqual(validateConfig(json('../server/config.json')).problems, []);
});

test('欄位缺漏 → 用預設（並列出 problem）', () => {
  const { config, problems } = validateConfig({ version: 'v-partial', picker: { ratePerMinute: 5 } });
  assert.equal(config.version, 'v-partial');
  assert.equal(config.picker.ratePerMinute, 5);
  assert.equal(config.picker.minFare, 45);
  assert.equal(config.detector.dedupeSeconds, 90);
  assert.deepEqual(config.telemetry, DEFAULT_CONFIG.telemetry);
  assert.ok(problems.some((p) => p.startsWith('picker.minFare 缺漏')));
  // 整份不是物件 → 全預設
  const bad = validateConfig('nope');
  assert.deepEqual({ ...bad.config, version: 'default' }, DEFAULT_CONFIG);
  assert.equal(bad.config.version, 'default');
});

test('不合法 → 用預設：範圍外、非整數、正則編不過、捕捉群組不足、型別錯、交叉檢查', () => {
  const { config, problems } = validateConfig({
    version: 'x'.repeat(41),
    picker: { maxMinutes: 120, minMinutes: 2.5, minutePattern: '([0-9]+', amountAfterPattern: '[0-9]+元', keywords: 'abc', minAmount: 700, maxAmount: 600 },
    detector: { ocrIntervalSeconds: 0.1, maxLongEdge: 640.5, acceptPattern: '接受訂單', dedupeSeconds: '90' },
    telemetry: { keywords: [['太長的關鍵字太長的關鍵字太長']], batchSize: 0 },
    app: { beatTimeoutSeconds: 10 },
  });
  assert.equal(config.version, 'default');
  assert.equal(config.picker.maxMinutes, 90);
  assert.equal(config.picker.minMinutes, 1);
  assert.equal(config.picker.minutePattern, DEFAULT_PICKER.minutePattern);
  assert.equal(config.picker.amountAfterPattern, DEFAULT_PICKER.amountAfterPattern);
  assert.deepEqual(config.picker.keywords, DEFAULT_PICKER.keywords);
  assert.equal(config.picker.minAmount, 30);
  assert.equal(config.picker.maxAmount, 600);
  assert.equal(config.detector.ocrIntervalSeconds, 1.5);
  assert.equal(config.detector.maxLongEdge, 640);
  assert.equal(config.detector.acceptPattern, '接受訂單'); // 合法（不需捕捉群組）
  assert.equal(config.detector.dedupeSeconds, 90);
  assert.deepEqual(config.telemetry.keywords, DEFAULT_CONFIG.telemetry.keywords);
  assert.equal(config.telemetry.batchSize, 10);
  assert.equal(config.app.beatTimeoutSeconds, 150);
  assert.ok(problems.length >= 12, problems.join('\n'));
});

test('用自訂設定：關鍵字/費率/範圍/分鐘正則/接單鈕正則都會改變結果', () => {
  // 換分鐘正則：「約 25 mins」預設也認得 min（25），自訂成只認「X 分鐘」→ 走金額回推
  const text = '約 25 mins\n61.25 $';
  assert.equal(pickMinutes(text), 25);
  const onlyChinese = { ...DEFAULT_PICKER, minutePattern: '(?<![0-9.])([0-9]{1,3})\\s*分鐘' };
  assert.equal(pickMinutes(text, onlyChinese), 15); // 61.25 / 4.08355 = 15
  // 費率改 5 → 61.25 / 5 = 12
  assert.equal(pickMinutes('61.25 $', { ...DEFAULT_PICKER, ratePerMinute: 5 }), 12);
  // 最低價/短單分鐘
  assert.equal(pickMinutes('50.00 $', { ...DEFAULT_PICKER, minFare: 50, shortOrderMinutes: 10 }), 10);
  // 範圍：maxMinutes 20 → 27 分被丟掉、改用金額 110.26 → 27 也超出 → null
  assert.equal(pickMinutes('27 分鐘\n110.26 $', { ...DEFAULT_PICKER, maxMinutes: 20 }), null);
  // 關鍵字：自訂「騎乘」→ 同行關鍵字優先
  const kwText = '取餐 5 分鐘\n騎乘 22 分鐘';
  assert.equal(pickMinutes(kwText), 5);
  assert.equal(pickMinutes(kwText, { ...DEFAULT_PICKER, keywords: ['騎乘'] }), 22);
  // 金額正則與範圍
  assert.equal(pickAmount('收入 NTD88', { ...DEFAULT_PICKER, amountBeforePattern: 'NTD([0-9]{2,4})' }), 88);
  // 接單鈕正則
  assert.equal(hasAcceptButton('立即接單'), false);
  assert.equal(hasAcceptButton('立即接單', '接單'), true);
  assert.equal(detectNewOrderMinutes('立即接單\n18 分鐘', DEFAULT_PICKER, '接單'), 18);
  // 編不過的正則 → 退回預設，不會丟例外
  assert.equal(pickMinutes('18 分鐘', { ...DEFAULT_PICKER, minutePattern: '([0-9' }), 18);
  // 畫面摘要吃同一份規則（含自訂回報關鍵字）
  const s = summarizeScreen('立即接單\n18 分鐘\n新按鈕', { picker: DEFAULT_PICKER, acceptPattern: '接單', keywords: [['新按鈕']] });
  assert.deepEqual([s.accept, s.minutes, s.kw], [true, 18, ['新按鈕']]);
});

test('Swift 預設值與 TS／JSON 一致（MinutePicker.swift、SampleHandler.swift）', () => {
  const swiftLit = (p) => `"${p.replace(/\\/g, '\\\\')}"`;
  const mp = read('../native/intents/MinutePicker.swift');
  assert.equal(read('../targets/broadcast/MinutePicker.swift'), mp);
  for (const k of ['minutePattern', 'amountAfterPattern', 'amountBeforePattern']) assert.ok(mp.includes(swiftLit(DEFAULT_PICKER[k])), k);
  for (const kw of DEFAULT_PICKER.keywords) assert.ok(mp.includes(`"${kw}"`), kw);
  for (const line of ['var minMinutes = 1', 'var maxMinutes = 90', 'var minAmount = 30.0', 'var maxAmount = 600.0', 'var ratePerMinute = 4.08355', 'var minFare = 45.0', 'var shortOrderMinutes = 8']) {
    assert.ok(mp.includes(line), line);
  }
  const ext = read('../targets/broadcast/SampleHandler.swift');
  const d = DEFAULT_CONFIG.detector;
  const expect = {
    ocrInterval: d.ocrIntervalSeconds, idleOcrInterval: d.idleOcrIntervalSeconds, idleAfterMisses: d.idleAfterMisses,
    forceOcrInterval: d.forceOcrSeconds, sameFrameMaxBits: d.sameFrameMaxBits, heartbeatInterval: d.heartbeatSeconds,
    dedupeWindow: d.dedupeSeconds, maxLongEdge: d.maxLongEdge,
    bottomFraction: d.bottomFraction, minimumTextHeight: d.minimumTextHeight, memoryAlertMB: d.memoryAlertMB, refreshSeconds: d.configRefreshSeconds,
    // v0.8
    fastOcrInterval: d.fastOcrIntervalSeconds, changeMinBits: d.changeMinBits, changeMinGap: d.changeMinGapSeconds, probeInterval: d.probeIntervalSeconds,
  };
  for (const [name, value] of Object.entries(expect)) {
    const m = new RegExp(`var ${name}(?:: [A-Za-z]+)? = ([0-9.]+)`).exec(ext);
    assert.ok(m, name);
    assert.equal(Number(m[1]), value, name);
  }
  assert.ok(read('../targets/broadcast/OrderDetector.swift').includes(`static let defaultAcceptPattern = "${d.acceptPattern}"`));
  // v0.7 offer（OfferTracker.swift 的 OfferSettings）
  const ot = read('../targets/broadcast/OfferTracker.swift');
  const o = DEFAULT_CONFIG.offer;
  assert.ok(ot.includes(`var goneAfterMisses = ${o.goneAfterMisses}`));
  assert.ok(ot.includes(`var decideWindowSec = ${o.decideWindowSec}`));
  assert.ok(ot.includes(`var ambiguousAs = "${o.ambiguousAs}"`));
  assert.ok(ot.includes(`static let defaultAcceptedKeywords =\n    "${o.acceptedKeywords}"`));
  assert.ok(ot.includes(`static let defaultRejectedKeywords = "${o.rejectedKeywords}"`));
  assert.ok(ot.includes(`static let defaultStackedKeywords = "${o.stackedKeywords}"`));
  assert.ok(ot.includes('stackedKeywords = RemoteConfig.offerRegex(o["stackedKeywords"], stackedKeywords)'));
  // v0.7 extension 不再用 detector.goneAfterMisses（改 offer.goneAfterMisses）
  assert.ok(!/d\["goneAfterMisses"\]/.test(ext));
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  assert.equal(read('../targets/broadcast/RemoteConfig.swift'), rc);
  assert.ok(rc.includes('static let cacheKey = "pandatimer.remoteConfig.v1"'));
  assert.ok(mp.includes('static let cacheKey = "pandatimer.remoteConfig.v1"'));
});

test('Swift 的合法範圍與 TS RANGES 一致', () => {
  const ext = read('../targets/broadcast/SampleHandler.swift');
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  const mp = read('../native/intents/MinutePicker.swift');
  const swiftKey = { ocrInterval: 'ocrIntervalSeconds' };
  let checked = 0;
  for (const m of ext.matchAll(/RemoteConfig\.(?:number|int)\(d\["(\w+)"\], ([0-9.]+), ([0-9.]+),/g)) {
    assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[`detector.${swiftKey[m[1]] ?? m[1]}`].slice(0, 2), m[1]);
    checked++;
  }
  for (const m of mp.matchAll(/Self\.(?:number|int)\(d\["(\w+)"\], ([0-9.]+), ([0-9.]+)\)/g)) {
    assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[`picker.${m[1]}`].slice(0, 2), m[1]);
    checked++;
  }
  for (const m of rc.matchAll(/int\((?:t|section\(root, "(?:app|detector)"\))\["(\w+)"\], ([0-9.]+), ([0-9.]+), ([0-9.]+)\)/g)) {
    const key = Object.keys(RANGES).find((k) => k.endsWith(`.${m[1]}`));
    assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[key].slice(0, 2), m[1]);
    const [section, field] = key.split('.');
    assert.equal(Number(m[4]), DEFAULT_CONFIG[section][field], `${m[1]} 預設`);
    checked++;
  }
  const ot = read('../targets/broadcast/OfferTracker.swift');
  for (const m of ot.matchAll(/RemoteConfig\.int\(o\["(\w+)"\], ([0-9.]+), ([0-9.]+), (\w+)\)/g)) {
    assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[`offer.${m[1]}`].slice(0, 2), m[1]);
    checked++;
  }
  assert.ok(checked >= 15 + 7 + 4 + 2, `只比對到 ${checked} 個欄位`);
});

test('v0.7 offer 區塊：缺漏補預設、範圍、正則（不得命中空字串）、ambiguousAs 列舉', () => {
  // 舊版（v0.6）設定沒有 offer → 全用預設，各列一條 problem
  const old = validateConfig({ version: 'v06' });
  assert.deepEqual(old.config.offer, DEFAULT_CONFIG.offer);
  assert.ok(old.problems.some((p) => p.startsWith('offer.decideWindowSec 缺漏')));
  const { config, problems } = validateConfig({
    version: 'v07',
    offer: { goneAfterMisses: 0, decideWindowSec: 61, acceptedKeywords: '前往取餐|', rejectedKeywords: '([', ambiguousAs: 'maybe' },
  });
  assert.deepEqual(config.offer, DEFAULT_CONFIG.offer);
  for (const k of ['goneAfterMisses', 'decideWindowSec', 'acceptedKeywords', 'rejectedKeywords', 'ambiguousAs']) {
    assert.ok(problems.some((p) => p.startsWith(`offer.${k}`)), k);
  }
  const ok = validateConfig({ version: 'v07b', offer: { goneAfterMisses: 3, decideWindowSec: 40, acceptedKeywords: '開始配送', rejectedKeywords: '略過', ambiguousAs: 'reject', stackedKeywords: '順路單' } });
  assert.deepEqual(ok.config.offer, { goneAfterMisses: 3, decideWindowSec: 40, acceptedKeywords: '開始配送', rejectedKeywords: '略過', ambiguousAs: 'reject', stackedKeywords: '順路單', islandIndicator: true, alertSound: 'default', suspectBelowMinutes: 3 });
  assert.equal(DEFAULT_CONFIG.offer.ambiguousAs, 'accept');
  assert.equal(DEFAULT_CONFIG.offer.decideWindowSec, 25);
  // Swift：offerRegex 擋空字串命中、choice 列舉
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  assert.ok(rc.includes('static func offerRegex(') && rc.includes('r.firstMatch(in: "", options: [], range: NSRange(location: 0, length: 0)) == nil'));
  assert.ok(rc.includes('static func choice('));
  assert.ok(read('../targets/broadcast/OfferTracker.swift').includes('RemoteConfig.choice(o["ambiguousAs"], ["accept", "reject"], ambiguousAs)'));
});

test('v1.0 offer.islandIndicator / offer.alertSound：預設、驗證、Swift 同規則', () => {
  assert.equal(DEFAULT_CONFIG.offer.islandIndicator, true);
  assert.equal(DEFAULT_CONFIG.offer.alertSound, 'default');
  const ok = validateConfig({ version: 'v10', offer: { islandIndicator: false, alertSound: 'none' } });
  assert.equal(ok.config.offer.islandIndicator, false);
  assert.equal(ok.config.offer.alertSound, 'none');
  const bad = validateConfig({ version: 'v10b', offer: { islandIndicator: 'yes', alertSound: 'loud' } });
  assert.equal(bad.config.offer.islandIndicator, true);
  assert.equal(bad.config.offer.alertSound, 'default');
  assert.ok(bad.problems.some((p) => p.startsWith('offer.islandIndicator')));
  assert.ok(bad.problems.some((p) => p.startsWith('offer.alertSound')));
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  for (const s of ['var islandIndicator = true', 'var alertSound = "default"',
    'out.islandIndicator = bool(o["islandIndicator"], out.islandIndicator)',
    'out.alertSound = choice(o["alertSound"], ["default", "none"], out.alertSound)']) assert.ok(rc.includes(s), s);
});
