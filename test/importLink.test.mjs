// v0.8 訂單匯入 deep link：base64url、時區、缺欄位、時間反序、重複判定、上限 200 筆、壞資料拒絕
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_IMPORT_ORDERS,
  base64UrlToBytes,
  bytesToBase64Url,
  describeImport,
  makeImportLink,
  parseImportLink,
  parseImportTime,
  planImport,
  utf8Decode,
  utf8Encode,
} from '../src/importLink.ts';
import { parseDeepLink } from '../src/orders.ts';

const T = (iso) => Date.parse(iso);
const row = (o = {}) => ({ acceptedAt: '2026-11-12T11:04:00+08:00', estimateMin: 21, deliveredAt: '2026-11-12T11:25:00+08:00', ...o });
const link = (orders, v = 1) => makeImportLink({ v, orders });

test('base64url／UTF-8 來回一致（含中文、emoji、不同長度補位）；壞字元拒絕', () => {
  for (const s of ['', 'a', 'ab', 'abc', 'abcd', '補記 夾單測試', '🐼 熊貓', '{"v":1}']) {
    const b = bytesToBase64Url(utf8Encode(s));
    assert.ok(/^[A-Za-z0-9_-]*$/.test(b), b);
    assert.equal(utf8Decode(base64UrlToBytes(b)), s);
    assert.equal(Buffer.from(s, 'utf8').toString('base64url'), b); // 與 Node 的 base64url 相同
  }
  assert.equal(utf8Decode(base64UrlToBytes(Buffer.from('中文').toString('base64'))), '中文'); // 容忍 +/=
  assert.equal(base64UrlToBytes('ab$c'), null);
  assert.equal(base64UrlToBytes('a'), null);
  assert.equal(utf8Decode(Uint8Array.from([0xe4, 0xb8])), null); // 截斷的 UTF-8
  assert.equal(utf8Decode(Uint8Array.from([0xc0, 0x80])), null); // 過長編碼
});

test('時間：帶時區照時區、沒寫時區＝台北、Z＝UTC、毫秒數字；不存在的日期/時間拒絕', () => {
  assert.equal(parseImportTime('2026-11-12T11:04:00+08:00'), T('2026-11-12T03:04:00Z'));
  assert.equal(parseImportTime('2026-11-12 11:04'), T('2026-11-12T03:04:00Z'));
  assert.equal(parseImportTime('2026-11-12T11:04:30'), T('2026-11-12T03:04:30Z'));
  assert.equal(parseImportTime('2026-11-12T03:04:00Z'), T('2026-11-12T03:04:00Z'));
  assert.equal(parseImportTime('2026-11-12T11:04:00.5+0800'), T('2026-11-12T03:04:00.500Z'));
  assert.equal(parseImportTime('2026-11-11T22:04:00-05:00'), T('2026-11-12T03:04:00Z'));
  assert.equal(parseImportTime(T('2026-11-12T03:04:00Z')), T('2026-11-12T03:04:00Z'));
  for (const bad of ['2026-02-30 10:00', '2026-11-12 24:00', '2026-13-01 10:00', '2026-11-12', '昨天 11:04', '2026-11-12T11:04+15:00', 1234, null, {}]) {
    assert.equal(parseImportTime(bad), null, String(bad));
  }
});

test('解析連結：正常、進行中略過、選填欄位、不是匯入連結 → null', () => {
  const r = parseImportLink(link([row({ amount: 85.76, stacked: true, note: '補記' }), row({ acceptedAt: '2026-11-12 12:02', deliveredAt: undefined })]));
  assert.equal(r.ok, true);
  assert.equal(r.skippedActive, 1);
  assert.deepEqual(r.rows, [{
    acceptedAt: T('2026-11-12T03:04:00Z'), estimateMin: 21, deliveredAt: T('2026-11-12T03:25:00Z'), amount: 85.76, stacked: true, note: '補記',
  }]);
  assert.equal(parseImportLink('pandatimer://start?min=18'), null);
  assert.equal(parseImportLink(null), null);
  // 既有 deep link 解析不受影響（import 不是 start/done）
  assert.equal(parseDeepLink(link([row()])), null);
  // URL 編碼過的 d 也能解
  const enc = link([row()]).replace(/d=(.*)$/, (_, d) => `d=${encodeURIComponent(d)}`);
  assert.equal(parseImportLink(enc).ok, true);
  assert.equal(parseImportLink('pandatimer:///import/?x=1&d=' + link([row()]).split('d=')[1]).ok, true);
});

test('壞資料整批拒絕：缺欄位、時間反序、估計分鐘不合法、選填型別錯、版本、空陣列、上限 200 筆、壞 base64/JSON', () => {
  const err = (orders, v) => {
    const r = parseImportLink(link(orders, v));
    assert.equal(r.ok, false, JSON.stringify(orders).slice(0, 80));
    return r.error;
  };
  assert.match(err([row({ acceptedAt: undefined })]), /acceptedAt/);
  assert.match(err([row({ estimateMin: 0 })]), /estimateMin/);
  assert.match(err([row({ estimateMin: 12.5 })]), /estimateMin/);
  assert.match(err([row({ deliveredAt: '2026-11-12T11:00:00+08:00' })]), /不晚於/);
  assert.match(err([row({ deliveredAt: '2026-11-12T11:04:00+08:00' })]), /不晚於/);
  assert.match(err([row({ deliveredAt: '2026-11-13T11:25:00+08:00' })]), /300/);
  assert.match(err([row({ deliveredAt: 'later' })]), /deliveredAt/);
  assert.match(err([row({ amount: -1 })]), /amount/);
  assert.match(err([row({ stacked: 'yes' })]), /stacked/);
  assert.match(err([row({ note: 'x'.repeat(101) })]), /note/);
  assert.match(err([row(), 'oops']), /第 2 筆/);
  assert.match(err([row()], 2), /版本/);
  assert.match(err([]), /非空/);
  assert.match(err([row({ deliveredAt: undefined })]), /沒有可匯入/);
  const many = Array.from({ length: MAX_IMPORT_ORDERS + 1 }, (_, i) => row({ acceptedAt: T('2026-11-01T00:00:00Z') + i * 3600_000, deliveredAt: T('2026-11-01T00:20:00Z') + i * 3600_000 }));
  assert.match(err(many), /最多 200/);
  assert.equal(parseImportLink(link(many.slice(0, MAX_IMPORT_ORDERS))).ok, true);
  // 一筆壞 → 整批不收（不會只匯一半）
  const mixed = parseImportLink(link([row(), row({ estimateMin: 'x' })]));
  assert.equal(mixed.ok, false);
  assert.equal(parseImportLink('pandatimer://import?d=%%%').ok, false);
  assert.equal(parseImportLink('pandatimer://import?d=$$$').ok, false);
  assert.equal(parseImportLink(`pandatimer://import?d=${Buffer.from('not json').toString('base64url')}`).ok, false);
  assert.equal(parseImportLink(`pandatimer://import?d=${Buffer.from('[1,2]').toString('base64url')}`).ok, false);
  assert.equal(parseImportLink('pandatimer://import').ok, false);
});

test('重複判定：與既有紀錄 acceptedAt 相差 ≤90 秒且 estimateMin 相同 → 不匯入；同批重複也只收一筆；轉成已送達 Order', () => {
  const at = T('2026-11-12T03:04:00Z');
  const existing = [
    { id: 'e1', acceptedAt: at + 80_000, estimateMin: 21, deadline: at + 21 * 60_000, status: 'delivered', actualMin: 20 },
    { id: 'e2', acceptedAt: at + 3600_000, estimateMin: 14, deadline: 0, status: 'canceled' },
  ];
  const rows = parseImportLink(link([
    row(), // 與 e1 相差 80 秒、同 21 分 → 重複
    row({ acceptedAt: '2026-11-12T11:04:00+08:00', estimateMin: 22 }), // 分鐘不同 → 不重複
    row({ acceptedAt: '2026-11-12T12:04:00+08:00', estimateMin: 14, deliveredAt: '2026-11-12T12:20:00+08:00' }), // 與已取消 e2 重複
    row({ acceptedAt: '2026-11-12T13:00:00+08:00', estimateMin: 10, deliveredAt: '2026-11-12T13:12:30+08:00', stacked: true, amount: 45 }),
    row({ acceptedAt: '2026-11-12T13:01:00+08:00', estimateMin: 10, deliveredAt: '2026-11-12T13:12:30+08:00' }), // 同批前一筆的重複
    row({ acceptedAt: '2026-11-13T09:00:00+08:00', estimateMin: 18, deliveredAt: '2026-11-13T09:15:00+08:00' }),
  ])).rows;
  const plan = planImport(existing, rows);
  assert.equal(plan.duplicates.length, 3);
  assert.equal(plan.add.length, 3);
  assert.deepEqual([plan.from, plan.to], ['2026-11-12', '2026-11-13']);
  const s = plan.add.find((o) => o.stacked);
  assert.deepEqual(
    { ...s },
    {
      id: `${T('2026-11-12T05:00:00Z')}-imp10`, acceptedAt: T('2026-11-12T05:00:00Z'), estimateMin: 10, deadline: T('2026-11-12T05:10:00Z'),
      status: 'delivered', deliveredAt: T('2026-11-12T05:12:30Z'), actualMin: 12.5, source: 'import', stacked: true, amount: 45,
    },
  );
  assert.ok(plan.add.every((o) => o.status === 'delivered' && o.source === 'import' && !o.activityId && !o.notifIds));
  // 邊界：剛好 90 秒算重複、91 秒不算
  const one = (sec) => planImport(existing, [{ acceptedAt: at + 80_000 + sec * 1000, estimateMin: 21, deliveredAt: at + 3600_000 }]).add.length;
  assert.equal(one(90), 0);
  assert.equal(one(91), 1);
  const text = describeImport(plan, 1);
  assert.match(text, /匯入 3 筆/);
  assert.match(text, /重複 3 筆/);
  assert.match(text, /進行中，不匯入/);
  assert.match(text, /夾單 1 筆/);
});

test('scripts/make-import-link.mjs：合法 → 印出可解析的連結；不合法 → 退出碼 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-import-'));
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify([row({ note: '補記' })]));
  const script = new URL('../scripts/make-import-link.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, good], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.ok(out.startsWith('pandatimer://import?d='));
  assert.equal(parseImportLink(out).rows[0].note, '補記');
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ v: 1, orders: [row({ deliveredAt: '2026-11-12T10:00:00+08:00' })] }));
  assert.throws(() => execFileSync(process.execPath, [script, bad], { stdio: 'pipe' }), (e) => e.status === 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
