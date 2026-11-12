// v0.8 偵測更快：亮綠色金額觸發（像素統計）、畫面變化觸發、OCR 排程（TS 版＝SampleHandler.swift 的 FrameProbe/GreenEdge/OcrPlanner）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULT_GREEN,
  FAST_FORCE_SEC,
  GREEN_GRID_H,
  GREEN_GRID_W,
  GreenEdge,
  chooseInterval,
  greenHit,
  hamming,
  isFast,
  isGreenRGB,
  isGreenYCbCr,
  planOcr,
  rgbToYCbCr,
} from '../src/frameTrigger.ts';
import { DEFAULT_CONFIG, RANGES, validateConfig } from '../src/remoteConfig.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('亮綠色判定：暗色主題金額綠、淺色主題綠字算；黃、青、粉紅、白、灰、深色背景不算', () => {
  // 暗色主題金額 ≈ RGB(60,220,60)
  assert.deepEqual(rgbToYCbCr(60, 220, 60), [154, 75, 61]);
  assert.equal(isGreenRGB(60, 220, 60), true);
  assert.equal(isGreenRGB(0, 160, 0), true); // 淺色主題綠字
  assert.equal(isGreenRGB(52, 199, 89), true); // iOS 系統綠
  for (const [name, rgb] of Object.entries({
    yellow: [255, 220, 0], cyan: [0, 200, 220], pink: [215, 15, 100], white: [255, 255, 255], gray: [128, 128, 128],
    darkBg: [18, 18, 18], black: [0, 0, 0], darkGreenBg: [10, 40, 10], orange: [255, 140, 0], blue: [30, 90, 230],
  })) {
    assert.equal(isGreenRGB(...rgb), false, name);
  }
  // YUV 直接判斷（420v 視訊範圍的色差往 128 收縮一點，仍在門檻內）
  assert.equal(isGreenYCbCr(148, 81, 69), true);
  assert.equal(isGreenYCbCr(40, 75, 61), false); // 太暗
  assert.equal(isGreenYCbCr(150, 120, 61), false); // Cb 太高（偏青/灰）
});

test('像素統計 → 疑似邀請：96×160 取樣中綠色比例 ≥ 0.2%', () => {
  const total = GREEN_GRID_W * GREEN_GRID_H;
  assert.equal(total, 15360);
  // 「85.76 $」大字：約 0.5% 的取樣點是綠色
  assert.equal(greenHit(Math.round(total * 0.005), total), true);
  assert.equal(greenHit(Math.round(total * 0.0015), total), false); // 零星綠色圖示
  assert.equal(greenHit(0, 0), false);
  assert.equal(greenHit(500, total, { ...DEFAULT_GREEN, enabled: false }), false);
  assert.equal(greenHit(20, total, { ...DEFAULT_GREEN, minRatio: 0.001 }), true);
});

test('綠色邊緣觸發：從沒有變成有才觸發一次；連 2 次取樣沒有才算消失', () => {
  const g = new GreenEdge();
  const seq = [false, true, true, false, true, false, false, true].map((h) => g.observe(h));
  assert.deepEqual(seq, [false, true, false, false, false, false, false, true]);
});

const S = {
  ocrIntervalSeconds: 1.5, idleOcrIntervalSeconds: 1.5, idleAfterMisses: 3, fastOcrIntervalSeconds: 0.6,
  changeMinBits: 120, changeMinGapSeconds: 0.6, sameFrameMaxBits: 40, forceOcrSeconds: 10,
};
const plan = (o) => planOcr({ fast: false, diffFromOcr: 0, diffFromPrev: 0, greenPending: false, interval: 1.5, ...o, s: S });

test('OCR 排程：第一次、綠色觸發（≥0.6 秒）、畫面變了且靜止（≥0.6 秒）、固定間隔、同畫面跳過/強制', () => {
  assert.deepEqual(plan({ now: 0, lastOcrAt: null }), { run: true, why: 'first' });
  // 綠色：距上次 0.6 秒以上立刻 OCR；太近先等（greenPending 由呼叫端保留到真的 OCR）
  assert.deepEqual(plan({ now: 10.7, lastOcrAt: 10, greenPending: true }), { run: true, why: 'green' });
  assert.deepEqual(plan({ now: 10.4, lastOcrAt: 10, greenPending: true }), { run: false, skip: 'wait' });
  // 畫面變化：與上次 OCR 差很多、且與上一個取樣幾乎一樣（已靜止）
  assert.deepEqual(plan({ now: 10.8, lastOcrAt: 10, diffFromOcr: 900, diffFromPrev: 5 }), { run: true, why: 'change' });
  // 還在動（影片/捲動）→ 不觸發，等固定間隔
  assert.deepEqual(plan({ now: 10.8, lastOcrAt: 10, diffFromOcr: 900, diffFromPrev: 600 }), { run: false, skip: 'wait' });
  assert.deepEqual(plan({ now: 11.5, lastOcrAt: 10, diffFromOcr: 900, diffFromPrev: 600 }), { run: true, why: 'interval' });
  // 小變化（倒數文字跳一格）不算變化
  assert.deepEqual(plan({ now: 10.8, lastOcrAt: 10, diffFromOcr: 60, diffFromPrev: 0 }), { run: false, skip: 'wait' });
  // 同畫面：一般 10 秒強制一次；疑似邀請狀態 2 秒
  assert.deepEqual(plan({ now: 12, lastOcrAt: 10, diffFromOcr: 10 }), { run: false, skip: 'same' });
  assert.deepEqual(plan({ now: 20, lastOcrAt: 10, diffFromOcr: 10 }), { run: true, why: 'force' });
  assert.deepEqual(plan({ now: 12, lastOcrAt: 10, diffFromOcr: 10, fast: true, interval: 0.6 }), { run: true, why: 'force' });
  assert.deepEqual(plan({ now: 11, lastOcrAt: 10, diffFromOcr: 10, fast: true, interval: 0.6 }), { run: false, skip: 'same' });
  assert.equal(FAST_FORCE_SEC, 2);
});

test('間隔：疑似邀請（綠色 hold／判定中／上次有接單鈕）0.6 秒、閒置 1.5 秒', () => {
  assert.equal(isFast(5, 10, false, false), true); // 綠色 hold 中
  assert.equal(isFast(11, 10, false, false), false);
  assert.equal(isFast(11, null, true, false), true);
  assert.equal(isFast(11, null, false, true), true);
  assert.equal(chooseInterval(true, 9, S), 0.6);
  assert.equal(chooseInterval(false, 9, S), 1.5);
  assert.equal(chooseInterval(false, 0, { ...S, ocrIntervalSeconds: 1 }), 1);
  assert.equal(DEFAULT_CONFIG.detector.idleOcrIntervalSeconds, 1.5);
  assert.equal(DEFAULT_CONFIG.detector.fastOcrIntervalSeconds, 0.6);
  assert.equal(hamming([1, 0, 1], [1, 1, 0]), 2);
});

test('遠端設定 detector.greenTrigger：巢狀驗證、範圍、型別', () => {
  assert.deepEqual(DEFAULT_CONFIG.detector.greenTrigger, DEFAULT_GREEN);
  const bad = validateConfig({ version: 'x', detector: { greenTrigger: { enabled: 1, minRatio: 0, yMin: 300, cbMax: 1.5, crMax: -1, holdSec: 0, regionFraction: 2 } } });
  assert.deepEqual(bad.config.detector.greenTrigger, DEFAULT_GREEN);
  for (const k of ['enabled', 'minRatio', 'yMin', 'cbMax', 'crMax', 'holdSec', 'regionFraction']) {
    assert.ok(bad.problems.some((p) => p.startsWith(`detector.greenTrigger.${k}`)), k);
  }
  const notObj = validateConfig({ version: 'x', detector: { greenTrigger: 'on' } });
  assert.ok(notObj.problems.some((p) => p.startsWith('detector.greenTrigger 不是物件')));
  const ok = validateConfig({ version: 'x', detector: { greenTrigger: { ...DEFAULT_GREEN, enabled: false, minRatio: 0.01 } } });
  assert.equal(ok.config.detector.greenTrigger.enabled, false);
  assert.equal(ok.config.detector.greenTrigger.minRatio, 0.01);
  // 預設物件沒被改到
  assert.equal(DEFAULT_CONFIG.detector.greenTrigger.enabled, true);
});

test('Swift 與 TS 同規則：FrameProbe 取樣格數、YCbCr 係數、GreenEdge、OcrPlanner、預設與範圍', () => {
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['static let hashGrid = 64', `static let greenW = ${GREEN_GRID_W}`, `static let greenH = ${GREEN_GRID_H}`,
    'c((299 * rd + 587 * gd + 114 * bd) / 1000)', 'c(128 + (-169 * rd - 331 * gd + 500 * bd) / 1000)', 'c(128 + (500 * rd - 419 * gd - 81 * bd) / 1000)',
    'y >= s.yMin && cb <= s.cbMax && cr <= s.crMax', 'static let goneAfter = 2', 'static let fastForceSeconds: CFAbsoluteTime = 2',
    'offerActive || lastSawAccept || now < fastUntil', 'if greenPending { return Plan(why: "green", same: false) }',
    'if let d = diffFromOcr, d > s.changeMinBits, settled { return Plan(why: "change", same: false) }',
    'let force = fast ? min(s.forceOcrInterval, fastForceSeconds) : s.forceOcrInterval',
    'let cp = c + (sy >> 1) * chromaStride + (sx >> 1) * 2']) {
    assert.ok(ext.includes(s), s);
  }
  const rc = read('../modules/live-activity/ios/RemoteConfig.swift');
  const g = DEFAULT_GREEN;
  for (const s of ['var enabled = true', `var minRatio = ${g.minRatio}`, `var yMin = ${g.yMin}`, `var cbMax = ${g.cbMax}`, `var crMax = ${g.crMax}`,
    `var holdSec = ${g.holdSec.toFixed(1)}`, `var regionFraction = ${g.regionFraction}`]) {
    assert.ok(rc.includes(s), s);
  }
  for (const m of rc.matchAll(/(?:number|int)\(g\["(\w+)"\], ([0-9.]+), ([0-9.]+),/g)) {
    assert.deepEqual([Number(m[2]), Number(m[3])], RANGES[`detector.greenTrigger.${m[1]}`].slice(0, 2), m[1]);
  }
  assert.ok(rc.includes('static let maxKeywordRows = 60'));
});
