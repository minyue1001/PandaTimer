// v0.6 遠端回報的畫面摘要（白名單關鍵字萃取、畫面分類、公里數）＋隱私檢查
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  KEYWORD_NAMES,
  UI_KEYWORDS,
  classifyScreen,
  extractKm,
  matchKeywords,
  orderKey,
  summarizeScreen,
} from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const NEW_ORDER =
  '狀態\n上線中\n每單收入\n110.26 $ 6.7公里\n27 分鐘\n鬍鬚張魯肉飯 (台北美食文化館)\n台北市XX區XX路XX巷XX號X樓\n送餐資訊\n需要收取現金\n拒絕\n接受訂單';

test('白名單：17 個正式名稱、無重複', () => {
  assert.equal(KEYWORD_NAMES.length, 17);
  assert.equal(new Set(KEYWORD_NAMES).size, 17);
  for (const k of ['接受訂單', '拒絕', '前往取餐', '抵達餐廳', '已取餐', '前往送餐', '抵達', '送達', '完成訂單', '上線中', '休息中', '訂單詳情', '聯絡', '導航', '拍照', '確認取餐', '取消']) {
    assert.ok(KEYWORD_NAMES.includes(k), k);
  }
});

test('matchKeywords：只回白名單正式名稱；簡體/字間空白也認得；依白名單順序', () => {
  assert.deepEqual(matchKeywords(NEW_ORDER), ['接受訂單', '拒絕', '上線中']);
  assert.deepEqual(matchKeywords('前往 取餐\n導航  联系'), ['前往取餐', '聯絡', '導航']);
  assert.deepEqual(matchKeywords('抵达餐厅'), ['抵達餐廳', '抵達']);
  assert.deepEqual(matchKeywords('预计送达 16 分钟'), ['送達']);
  assert.deepEqual(matchKeywords(''), []);
  assert.deepEqual(matchKeywords(null), []);
  assert.deepEqual(matchKeywords('王小明 0912345678 台北市中正區'), []);
});

test('classifyScreen：優先序 newOrder > detail > delivering > pickup > idle > other > none', () => {
  assert.equal(classifyScreen(true, ['上線中']), 'newOrder');
  assert.equal(classifyScreen(false, ['訂單詳情', '已取餐']), 'detail');
  assert.equal(classifyScreen(false, ['前往送餐', '導航']), 'delivering');
  assert.equal(classifyScreen(false, ['已取餐']), 'delivering');
  assert.equal(classifyScreen(false, ['前往取餐', '導航']), 'pickup');
  assert.equal(classifyScreen(false, ['確認取餐']), 'pickup');
  assert.equal(classifyScreen(false, ['上線中']), 'idle');
  assert.equal(classifyScreen(false, ['取消']), 'other');
  assert.equal(classifyScreen(false, []), 'none');
});

test('extractKm', () => {
  assert.equal(extractKm('110.26 $ 6.7公里'), 6.7);
  assert.equal(extractKm('距離 12 km'), 12);
  assert.equal(extractKm('１.５ 公里'), 1.5);
  assert.equal(extractKm('123 公里'), null);
  assert.equal(extractKm('沒有距離'), null);
});

test('summarizeScreen：新單畫面 → 結構化欄位，沒有任何原文（店名/地址）', () => {
  const s = summarizeScreen(NEW_ORDER);
  assert.deepEqual(s, { accept: true, minutes: 27, amount: 110.26, km: 6.7, kw: ['接受訂單', '拒絕', '上線中'], screen: 'newOrder' });
  const json = JSON.stringify(s);
  for (const leak of ['鬍鬚張', '台北市', 'XX路', '現金', '送餐資訊']) assert.ok(!json.includes(leak), leak);
  // 沒有接單鈕 → 不挑分鐘數
  assert.equal(summarizeScreen('送餐資訊\n預計送達 18 分鐘\n已取餐').minutes, null);
});

test('orderKey：分鐘數＋金額取整', () => {
  assert.equal(orderKey(27, 110.26), '27/110');
  assert.equal(orderKey(27, null), '27/0');
  assert.notEqual(orderKey(27, 110.26), orderKey(27, 98.4));
});

test('三處白名單一致：TS、Swift（ScreenInfo.keywords）、伺服器（TELEMETRY_KEYWORDS）', () => {
  const swift = read('../targets/broadcast/OrderDetector.swift');
  const block = swift.slice(swift.indexOf('static let keywords: [[String]] = ['), swift.indexOf('private static let kmPattern'));
  const swiftRows = [...block.matchAll(/\[("[^\]]+)\]/g)].map((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.deepEqual(swiftRows, UI_KEYWORDS.map((r) => [...r]));
  const server = read('../server/index.mjs');
  const sblock = server.slice(server.indexOf('const TELEMETRY_KEYWORDS = ['), server.indexOf('const KEYWORD_SET'));
  assert.deepEqual([...sblock.matchAll(/'([^']+)'/g)].map((m) => m[1]), [...KEYWORD_NAMES]);
  // Swift 的分類規則字串與 TS 相同
  for (const k of ['"newOrder"', '"detail"', '"delivering"', '"pickup"', '"idle"', '"other"', '"none"']) assert.ok(swift.includes(k), k);
});

test('隱私：extension 的 OCR 原文只在 runOCR 內轉成摘要，telemetry 呼叫不得帶原文變數', () => {
  const ext = read('../targets/broadcast/SampleHandler.swift');
  const body = ext.slice(ext.indexOf('private func runOCR('), ext.indexOf('private func logScreenIfChanged('));
  // 原文只出現在「辨識 → ScreenInfo.analyze」兩行
  const uses = [...body.matchAll(/\bocrText\b/g)].length;
  assert.equal(uses, 2, 'ocrText 只能被宣告一次、交給 ScreenInfo.analyze 一次');
  for (const line of ext.split('\n').filter((l) => /telemetry\.log\(/.test(l))) {
    assert.ok(!/ocrText|recognize\(/.test(line), line);
  }
  // 伺服器端只收白名單鍵：sanitizeRecord 對未知鍵（例如 text）一律丟掉
  const server = read('../server/index.mjs');
  assert.ok(!/\btext: S\b|\bocr(Text)?: S\b|\baddr/.test(server.slice(server.indexOf('const FIELD_RULES'), server.indexOf('const MAX_STR'))));
});
