#!/usr/bin/env node
// v0.8 產生訂單匯入 deep link（主對話替使用者補記 App 沒偵測到的單用）。
// 用法：node scripts/make-import-link.mjs <orders.json>
//   orders.json＝{"v":1,"orders":[{"acceptedAt":"2026-11-12T11:04:00+08:00","estimateMin":21,"deliveredAt":"2026-11-12T11:25:00+08:00",
//                 "amount":85.76,"stacked":false,"note":"可省略"}]}（也接受直接一個陣列）
// 先用 App 同一套規則（src/importLink.ts）驗證，不合法就印出問題並以 1 結束；合法則 stdout 只印連結一行，
// 摘要印在 stderr。連結在 iPhone 上點（或貼到 Safari 網址列）→ App 跳確認視窗 → 確認才寫入。
import fs from 'node:fs';
import { makeImportLink, parseImportLink, planImport, describeImport } from '../src/importLink.ts';

const file = process.argv[2];
if (!file) {
  console.error('用法：node scripts/make-import-link.mjs <orders.json>');
  process.exit(2);
}
let raw;
try {
  raw = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`讀不到或不是 JSON：${e.message}`);
  process.exit(1);
}
const payload = Array.isArray(raw) ? { v: 1, orders: raw } : raw;
const link = makeImportLink(payload);
const parsed = parseImportLink(link);
if (!parsed?.ok) {
  console.error(`不合法：${parsed?.error ?? '未知'}`);
  process.exit(1);
}
const plan = planImport([], parsed.rows);
console.error(describeImport(plan, parsed.skippedActive));
console.error(`連結長度 ${link.length} 字元`);
console.log(link);
