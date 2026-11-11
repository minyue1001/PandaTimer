// node --test（Node 22.18+ 內建 type stripping，可直接 import .ts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickMinutes } from '../src/ocrPick.ts';

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
