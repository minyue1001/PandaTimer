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
  DEFAULT_SCREEN_RULES,
  DEFAULT_ACCEPTED_KEYWORDS,
  DEFAULT_REJECTED_KEYWORDS,
  DEFAULT_COMPLETED_KEYWORDS,
} from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

const NEW_ORDER =
  '狀態\n上線中\n每單收入\n110.26 $ 6.7公里\n27 分鐘\n鬍鬚張魯肉飯 (台北美食文化館)\n台北市XX區XX路XX巷XX號X樓\n送餐資訊\n需要收取現金\n拒絕\n接受訂單';

test('白名單：v0.8 共 44 個正式名稱、無重複（≤60）、每字 ≤12', () => {
  assert.equal(KEYWORD_NAMES.length, 44);
  assert.equal(new Set(KEYWORD_NAMES).size, 44);
  assert.ok(UI_KEYWORDS.every((r) => r.length <= 6 && r.every((w) => w.length >= 1 && w.length <= 12)));
  for (const k of ['接受訂單', '拒絕', '前往取餐', '抵達餐廳', '已取餐', '前往送餐', '抵達', '送達', '完成訂單', '上線中', '休息中', '訂單詳情', '聯絡', '導航', '拍照', '確認取餐', '取消',
    '已拒絕', '訂單已取消', '逾時', '已過期', '已抵達', '抵達店家', '聯絡店家', '取餐',
    '訂單已完成', '已送達', '送達完成', '確認送達', '完成送達',
    '夾單', '訂單完成', '確認已送達', '確認已取餐', '是否已取餐', '是否已送達', 'pickedup', '即將抵達', '上傳照片', '無法聯繫',
    '筆訂單', '即將準備完成', '取餐體驗', '每單收入']) {
    assert.ok(KEYWORD_NAMES.includes(k), k);
  }
});

test('matchKeywords：只回白名單正式名稱；簡體/字間空白也認得；依白名單順序', () => {
  assert.deepEqual(matchKeywords(NEW_ORDER), ['接受訂單', '拒絕', '上線中', '每單收入']);
  assert.deepEqual(matchKeywords('前往 取餐\n導航  联系'), ['前往取餐', '聯絡', '導航', '取餐']);
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

test('v0.7 extractKm 實機修正：6.7→6.7、12→12、0.8→0.8；小數點被吃掉（67 公里/27 分）→ 6.7；全形句點/中點', () => {
  assert.equal(extractKm('110.26 $ 6.7公里'), 6.7);
  assert.equal(extractKm('12公里'), 12);
  assert.equal(extractKm('0.8 公里'), 0.8);
  assert.equal(extractKm('6．7公里'), 6.7);
  assert.equal(extractKm('6·7 公里'), 6.7);
  assert.equal(extractKm('6,7km'), 6.7);
  assert.equal(extractKm('110.26 $ 67公里', 27), 6.7);
  assert.equal(extractKm('12公里', 27), 12);
  assert.equal(extractKm('12公里', 8), 1.2);
  assert.equal(extractKm('67公里'), 67); // 不知道分鐘數 → 不猜
  assert.equal(summarizeScreen('110.26 $ 67公里\n27 分鐘\n接受訂單').km, 6.7);
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
  // 邀請畫面本身就有「上線中」（rejectedKeywords 命中）——只在邀請消失後才拿來判斷，見 OfferTracker
  assert.deepEqual(s, {
    accept: true, minutes: 27, amount: 110.26, km: 6.7, kw: ['接受訂單', '拒絕', '上線中', '每單收入'], screen: 'newOrder',
    offerAccepted: false, offerRejected: true, offerHit: ['上線中'],
    delivered: false, deliveredHit: [], deliveredFinal: false, stacked: false,
    acceptStrong: false, acceptWeak: false, orders: null, stackScreen: false, bundle: 1, tip: null,
  });
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
  const sblock = server.slice(server.indexOf('const TELEMETRY_KEYWORDS = ['), server.indexOf('const BUILTIN_KEYWORDS'));
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
  // v1.1 上方補掃的原文：宣告一次、交給 OrderNumbers.scan 一次（號碼只在記憶體）
  assert.equal([...body.matchAll(/\bupperText\b/g)].length, 2);
  assert.ok(body.includes('OrderNumbers.scan(upperText, dialogPattern: s.delivery.dialogKeywords, finalPattern: s.delivery.finalKeywords)'));
  for (const line of ext.split('\n').filter((l) => /telemetry\.log\(/.test(l))) {
    assert.ok(!/ocrText|recognize\(/.test(line), line);
  }
  // 伺服器端只收白名單鍵：sanitizeRecord 對未知鍵（例如 text）一律丟掉
  const server = read('../server/index.mjs');
  assert.ok(!/\btext: S\b|\bocr(Text)?: S\b|\baddr/.test(server.slice(server.indexOf('const FIELD_RULES'), server.indexOf('const MAX_STR'))));
});

test('v0.7 offer 命中：接單後畫面 / 未接畫面 / 兩邊都命中 / 自訂與壞掉的正則', () => {
  const pickup = summarizeScreen('前往 取餐\n導航\n訂單詳情\n鬍鬚張魯肉飯');
  assert.deepEqual([pickup.offerAccepted, pickup.offerRejected, pickup.offerHit], [true, false, ['前往取餐', '取餐']]);
  const rejected = summarizeScreen('已拒絕訂單\n狀態 上線中');
  assert.deepEqual([rejected.offerAccepted, rejected.offerRejected, rejected.offerHit], [false, true, ['拒絕', '已拒絕']]);
  const idle = summarizeScreen('狀態\n上线中\n今日收入');
  assert.deepEqual([idle.offerAccepted, idle.offerRejected, idle.offerHit], [false, true, ['上線中']]);
  const both = summarizeScreen('上線中\n前往取餐');
  assert.deepEqual([both.offerAccepted, both.offerRejected], [true, true]);
  const none = summarizeScreen('LINE 新訊息\n王小明');
  assert.deepEqual([none.offerAccepted, none.offerRejected, none.offerHit], [false, false, []]);
  // 自訂正則（不在白名單的命中只回報布林，不回報文字）
  const rules = { ...DEFAULT_SCREEN_RULES, acceptedKeywords: '開始配送', rejectedKeywords: '已略過' };
  const custom = summarizeScreen('開始 配送\n店名', rules);
  assert.deepEqual([custom.offerAccepted, custom.offerRejected, custom.offerHit], [true, false, []]);
  assert.ok(!JSON.stringify(custom).includes('開始配送'));
  // 編不過的正則 → 用預設
  const broken = summarizeScreen('前往取餐', { ...DEFAULT_SCREEN_RULES, acceptedKeywords: '([' });
  assert.equal(broken.offerAccepted, true);
});

test('v0.7 Swift ScreenInfo.analyze 有 offer 欄位、預設正則與 TS 一致', () => {
  const det = read('../targets/broadcast/OrderDetector.swift');
  for (const f of ['offerAccepted: acc != nil', 'offerRejected: rej != nil', 'joined(separator: "|")', 'match.range.length > 0']) assert.ok(det.includes(f), f);
  const tracker = read('../targets/broadcast/OfferTracker.swift');
  assert.ok(tracker.includes(`static let defaultRejectedKeywords = "${DEFAULT_REJECTED_KEYWORDS}"`));
  assert.ok(tracker.includes(`"${DEFAULT_ACCEPTED_KEYWORDS}"`));
});

test('v0.7 自動送達畫面：命中完成/送達關鍵字（邀請畫面不算）；只回報白名單詞', () => {
  const d = summarizeScreen('完成 訂單\n聯絡\n王小明 台北市');
  assert.deepEqual([d.delivered, d.deliveredHit, d.screen], [true, ['完成訂單'], 'delivering']);
  assert.deepEqual(summarizeScreen('訂單已完成').deliveredHit, ['訂單已完成']);
  assert.equal(summarizeScreen('已送达').delivered, true);
  assert.equal(summarizeScreen('前往送餐\n導航').delivered, false);
  assert.equal(summarizeScreen('完成訂單\n27 分鐘\n接受訂單').delivered, false); // 邀請畫面不算
  const custom = summarizeScreen('交付成功', { ...DEFAULT_SCREEN_RULES, completedKeywords: '交付成功' });
  assert.deepEqual([custom.delivered, custom.deliveredHit], [true, []]);
  const sw = read('../targets/broadcast/OrderDetector.swift');
  assert.ok(sw.includes('delivered: done != nil'));
  assert.ok(read('../modules/live-activity/ios/RemoteConfig.swift').includes(`"${DEFAULT_COMPLETED_KEYWORDS}"`));
});
