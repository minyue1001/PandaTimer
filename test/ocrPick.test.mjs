// node --test（Node 22.18+ 內建 type stripping，可直接 import .ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectNewOrderMinutes, hasAcceptButton, pickMinutes } from '../src/ocrPick.ts';

const cases = [
  // 指定樣本
  ['預計送達 18 分鐘', 18],
  ['取餐 5 分鐘\n送達 22 分鐘', 22],
  ['距離 3.2 公里 約 12分鐘', 12],
  ['１８ 分鐘', 18],
  ['沒有任何數字', null],
  // 補充邊界
  ['', null],
  ['預計送達\n18\n分鐘', 18], // OCR 把數字與「分鐘」拆行
  ['18 分\n鐘', 18], // 「分鐘」被拆開
  ['送達 22\r\n分鐘', 22], // CRLF
  ['取餐 120 分鐘', null], // 超出 1~90
  ['預估 95 分鐘\n其他 10 分鐘', 10], // 95 丟棄後取剩下的
  ['店家 8 分鐘\n顧客地址\n剩餘 25 分鐘', 25], // 同行關鍵字優先於第一個
  ['步行 7 分鐘\n預計送達\n其他文字\n騎車 30 分鐘', 7], // 相鄰行關鍵字（tier1）勝過無關鍵字
  ['距離 1234 分', null], // 4 位數不是候選
  ['約 15 min', 15],
  ['预计送达 16 分钟', 16], // 簡體
];

for (const [input, expected] of cases) {
  test(`pickMinutes(${JSON.stringify(input)}) → ${expected}`, () => {
    assert.equal(pickMinutes(input), expected);
  });
}

// 規則 5：用新單金額回推（預估報酬 = max(45, 分鐘 × 4.08355)）
test('金額回推分鐘數', () => {
  const cases = [
    ['上線中\n100.00 $\n麥當勞\n(X)桃園市\n送餐資訊\n接受訂單', 24], // 實際 pandarider 新單畫面
    ['73.51 $\n接受訂單', 18],
    ['49.01 $', 12],
    ['45.00 $\n拒絕', 8], // 最低價分不出 → 保守 8 分
    ['NT$ 138.84', 34],
    ['１００.００ ＄', 24],
    ['預計送達 18 分鐘\n200.00 $', 18], // 有分鐘數時優先用分鐘數
    ['狀態 上線中\n拒絕', null],
    ['9999.00 $', null],
  ];
  for (const [text, want] of cases) assert.equal(pickMinutes(text), want, JSON.stringify(text));
});

test('pandarider 新版接單頁（金額＋公里＋分鐘同時出現）', () => {
  const text = '狀態\n上線中\n每單收入\n110.26 $ 6.7公里\n27 分鐘\n鬍鬚張魯肉飯 (台北美食文化館)\n台北市XX區XX路XX巷XX號X樓\n送餐資訊\n品項數量與消費者/店家備註(5)\n需要收取現金\n接受訂單';
  assert.equal(pickMinutes(text), 27);
  // 金額回推也應一致：110.26 / 4.08355 = 27
  assert.equal(pickMinutes('每單收入\n110.26 $ 6.7公里\n接受訂單'), 27);
});

// v0.3 螢幕廣播偵測：只有含「接受訂單」的新單畫面才觸發（與 targets/broadcast/OrderDetector.swift 同規則）
test('detectNewOrderMinutes：新單畫面才觸發', () => {
  const cases = [
    // 新版接單頁（金額＋公里＋分鐘）→ 27
    ['狀態\n上線中\n每單收入\n110.26 $ 6.7公里\n27 分鐘\n鬍鬚張魯肉飯 (台北美食文化館)\n台北市XX區XX路XX巷XX號X樓\n送餐資訊\n需要收取現金\n接受訂單', 27],
    // 舊版接單頁（只有金額）→ 金額回推 24
    ['上線中\n100.00 $\n麥當勞\n(X)桃園市\n送餐資訊\n接受訂單', 24],
    // 地圖待命 → null
    ['狀態 上線中', null],
    ['狀態\n上線中\n目前沒有訂單\n熱區 3 分鐘', null],
    // 訂單詳情／送餐中（有分鐘數但沒有「接受訂單」）→ null
    ['送餐資訊\n預計送達 18 分鐘\n顧客 王先生\n已取餐', null],
    ['訂單詳情\n110.26 $\n27 分鐘\n聯絡顧客', null],
    // OCR 字間空白、簡體字形也要認得
    ['每單收入\n73.51 $\n接受 訂單', 18],
    ['22 分钟\n接受订单', 22],
    // 有按鈕但挑不出分鐘數 → null
    ['接受訂單', null],
    ['', null],
  ];
  for (const [text, want] of cases) assert.equal(detectNewOrderMinutes(text), want, JSON.stringify(text));
  assert.equal(hasAcceptButton(null), false);
  assert.equal(hasAcceptButton('拒絕\n接受訂單'), true);
  assert.equal(hasAcceptButton('已接受 訂單詳情'), false);
});

// v0.6：螢幕廣播用「分鐘數＋金額」辨識同一張新單（與 MinutePicker.pickAmount / ScreenInfo.amountKey 同規則）
test('pickAmount／amountKey', async () => {
  const { pickAmount, amountKey } = await import('../src/ocrPick.ts');
  assert.equal(pickAmount('每單收入\n110.26 $ 6.7公里\n27 分鐘\n接受訂單'), 110.26);
  assert.equal(pickAmount('NT$ 138.84'), 138.84);
  assert.equal(pickAmount('１００.００ ＄'), 100);
  assert.equal(pickAmount('預計送達 18 分鐘'), null);
  assert.equal(pickAmount(''), null);
  assert.equal(pickAmount(null), null);
  assert.equal(pickAmount('9999.00 $'), 9999); // 原始值照給；範圍交給 amountKey / minutesFromAmount
  assert.equal(amountKey(110.26), 110);
  assert.equal(amountKey(73.51), 74);
  assert.equal(amountKey(null), 0);
  assert.equal(amountKey(9999), 0);
  assert.equal(amountKey(0.3), 0);
  // 金額回推分鐘數的舊行為不變
  assert.equal(pickMinutes('73.51 $\n接受訂單'), 18);
});
