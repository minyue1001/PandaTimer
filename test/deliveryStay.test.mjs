// v1.2.4「確認已送達」按鈕消失≠送達：還在送餐/抵達頁、切到別的 App 都不算；11/18 15:08~15:15 實機時序＋真送達案例＋Swift 同規則
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DELIVERY_LEAVE_KEYWORDS,
  DELIVERY_STAY_GONE_SEC,
  DELIVERY_STAY_KEYWORDS,
  DeliveryWatch,
  deliveryStay,
} from '../src/deliveryDetector.ts';
import { scanNumbers } from '../src/orderNumbers.ts';
import { pandaPresent } from '../src/powerSaver.ts';
import { summarizeScreen } from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
/** 'HH:mm:ss(.s)' → 秒 */
const T = (hms) => hms.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
/** 11/18 實機的遠端 away.keywords（2026-11-15.4；判斷 pandarider 畫面） */
const AWAY =
  '上線中|上线中|休息中|抵達|抵达|取餐|送達|送达|每單收入|每单收入|接受訂單|接受订单|訂單|订单|預計|预计|夾單|夹单|導航|导航|目的地|即將抵達|即将抵达|樓層|楼层|付款方式|線上付款|上傳照片|上传照片|確認已送達|确认已送达|是否已送達|確認已取餐|翻譯';

/** OCR 文字 → DeliveryWatch 觀察（同 SampleHandler.runOCR：dialog/final 由 scan、panda 由 away 特徵詞、stay 由 deliveryStay） */
function obs(text, { changed = true, withStay = true } = {}) {
  const sum = summarizeScreen(text);
  const sc = scanNumbers(text);
  const o = {
    dialog: sc.dialog, final: sum.deliveredFinal || sc.final, panda: pandaPresent(text, sum.accept, AWAY),
    dialogNo: sc.dialogNo, changed, numbers: sc.numbers,
  };
  if (withStay) o.stay = deliveryStay(text, sum.accept);
  return o;
}

// 11/18 實機畫面（下半部 OCR；telemetry 只有白名單字，原文依白名單/金額重建）
const S = {
  DIALOG: '送達\n聯絡\n無法聯繫顧客\n確認已送達', // kw=送達,聯絡,已送達,確認已送達,無法聯繫
  ARRIVE: '抵達 15:12', // kw=抵達（按鈕被收合/捲走的送餐頁）
  PAY: '付款方式\n線上付款\n142 $', // screen=none amt=142（付款方式/線上付款不在白名單）
  STACK: '夾單訂單\n+45 $', // kw=夾單 amt=45/324
  AMOUNT: '45.00 $', // screen=none amt=45（沒有任何特徵詞 → 不是 pandarider）
  OTHER: 'Google 地圖\n路線', // 切到導航 App（mode=away reason=noPanda）
  BLANK: '',
  FINAL: '訂單完成\n抵達\n即將抵達', // finalAfterDialog kw=抵達,即將抵達（彈窗疊在下一頁上）
};

/** 依時間跑：每 0.5 秒 tick（計時器），回傳所有 send */
function run(watch, frames, end, opts) {
  const sends = [];
  const list = [...frames].sort((a, b) => a[0] - b[0]);
  let i = 0;
  for (let t = list[0][0]; t <= end + 1e-9; t = Math.round((t + 0.1) * 10) / 10) {
    while (i < list.length && list[i][0] <= t + 1e-9) {
      const [at, key] = list[i++];
      const a = watch.observe(at, obs(S[key], opts));
      if (a?.kind === 'send') sends.push({ at, ...a });
    }
    if (Math.round(t * 10) % 5 === 0) {
      const a = watch.tick(t);
      if (a?.kind === 'send') sends.push({ at: t, ...a });
    }
  }
  return sends;
}

// 11/18 15:01 接 10 分單：15:08:47 抵達客人處出現「確認已送達」→ 一直到 15:14:15 才真的按（訂單完成）。
// 中間按鈕來來去去（收合/捲走、切導航）：v1.2.3 在 15:09:19、15:09:55、15:12:07、15:13:06、15:14:06 各送一次 noNumber 送達。
// （15:09:06.5 與 15:11:54 兩幀是推回去的：hold 的 delay=1、且是 OCR 路徑連 2 次沒看到）
const FRAMES_1118 = [
  ['15:08:39', 'PAY'], ['15:08:45.4', 'OTHER'], ['15:08:47.7', 'DIALOG'],
  ['15:09:06.5', 'PAY'], ['15:09:07.5', 'ARRIVE'], ['15:09:09.2', 'PAY'], ['15:09:14.7', 'ARRIVE'], ['15:09:19.8', 'ARRIVE'],
  ['15:09:22.5', 'DIALOG'], ['15:09:23.7', 'PAY'], ['15:09:29.9', 'DIALOG'], ['15:09:41.6', 'PAY'], ['15:09:42.8', 'ARRIVE'],
  ['15:09:48', 'ARRIVE'], ['15:09:55.3', 'ARRIVE'], ['15:10:27.9', 'BLANK'], ['15:10:36.5', 'OTHER'], ['15:10:46.7', 'ARRIVE'],
  ['15:10:47.3', 'ARRIVE'], ['15:10:48.2', 'DIALOG'], ['15:11:54', 'STACK'], ['15:11:55', 'STACK'], ['15:12:00.5', 'AMOUNT'],
  ['15:12:07.4', 'STACK'], ['15:12:08.3', 'STACK'], ['15:12:10.9', 'DIALOG'], ['15:12:53', 'ARRIVE'], ['15:12:54', 'ARRIVE'],
  ['15:13:06.3', 'ARRIVE'], ['15:13:09.1', 'PAY'], ['15:13:38.1', 'ARRIVE'], ['15:13:51.2', 'PAY'], ['15:13:52.8', 'DIALOG'],
  ['15:13:53.9', 'ARRIVE'], ['15:13:57.3', 'ARRIVE'], ['15:14:00.2', 'DIALOG'], ['15:14:06.2', 'ARRIVE'], ['15:14:15.1', 'FINAL'],
  ['15:14:15.6', 'BLANK'], ['15:14:21.1', 'FINAL'], ['15:14:26.4', 'BLANK'],
].map(([hms, k]) => [T(hms), k]);

test('畫面分類：送餐/抵達頁（stay）vs 離開（下一單取餐/待命/訂單完成/邀請）', () => {
  for (const t of [S.ARRIVE, S.PAY, S.STACK, '即將抵達\n顧客地址', '聯絡\n無法聯繫顧客', '已送達', '上傳照片', '翻譯\n顧客訊息', '目的地\n樓層 5F']) {
    assert.equal(deliveryStay(t), true, t);
  }
  for (const t of ['預計7分鐘後抵達店家・1筆訂單\n即將抵達', '上線中\n即將抵達', '訂單完成\n抵達', '前往取餐\n聯絡店家', '送達', '', '45.00 $']) {
    assert.equal(deliveryStay(t), false, t);
  }
  // 有接單鈕（新邀請）→ 一律不是 stay
  assert.equal(deliveryStay('夾單訂單依系統顯示金額為主\n+49.01 $\n12 分鐘\n接受訂單', true), false);
  assert.equal(deliveryStay('即將抵達'), true);
  assert.equal(deliveryStay('即將抵達', true), false);
  // 正則不得命中空字串
  assert.equal(new RegExp(DELIVERY_STAY_KEYWORDS).test(''), false);
  assert.equal(new RegExp(DELIVERY_LEAVE_KEYWORDS).test(''), false);
});

test('11/18 15:08~15:15 實機：按鈕收合/切導航不算送達 → 只在 15:14:15「訂單完成」送一次（v1.2.3 送了 5 次）', () => {
  const end = T('15:15:00');
  const now = run(new DeliveryWatch(), FRAMES_1118, end);
  assert.deepEqual(now.map((s) => [s.at, s.why, s.delaySec]), [[T('15:14:15.1'), 'finalAfterDialog', 0]]);
  // 舊行為（不看 stay、切 App 不清計時）重演：至少 4 次假送達、都在 15:14:15 之前
  const old = run(new DeliveryWatch(0), FRAMES_1118, end, { withStay: false });
  const early = old.filter((s) => s.at < T('15:14:15'));
  assert.ok(early.length >= 4, JSON.stringify(old.map((s) => [s.at, s.why])));
});

test('真送達照舊：對話框 → 訂單完成（14:21/14:36/15:01）、消失後進新邀請/待命/一般畫面', () => {
  // finalAfterDialog（11/18 14:36:17 對話框 → 14:36:20 訂單完成）
  let w = new DeliveryWatch();
  w.observe(T('14:36:17.8'), obs('送達\n聯絡\n確認已送達\n無法聯繫顧客\n1筆訂單'));
  assert.deepEqual(w.observe(T('14:36:20'), obs('訂單完成')), { kind: 'send', delaySec: 0, why: 'finalAfterDialog', no: null });
  // 15:01:15 對話框後的「抵達,即將抵達」不算 → 15:01:32 訂單完成（同畫面也有抵達字樣）才送
  w = new DeliveryWatch();
  w.observe(T('15:00:16.9'), obs('送達\n確認已送達\n上傳照片\n1筆訂單'));
  assert.equal(w.observe(T('15:00:33.3'), obs('送達\n聯絡\n無法聯繫顧客\n1筆訂單')), null);
  assert.equal(w.observe(T('15:01:15'), obs('抵達\n即將抵達')), null);
  assert.equal(w.tick(T('15:01:20')), null);
  assert.equal(w.observe(T('15:01:32.3'), obs(S.FINAL)).why, 'finalAfterDialog');
  // 11/18 13:17:27：對話框消失後直接是新邀請（接單鈕）→ 連 2 次 → disappear
  w = new DeliveryWatch();
  w.observe(0, obs('送達\n確認已送達'));
  assert.equal(w.observe(2, obs('每單收入\n45.00 $\n11 分鐘\n接受訂單')), null);
  assert.equal(w.observe(2.6, obs('每單收入\n45.00 $\n11 分鐘\n接受訂單')).why, 'disappear');
  // 11/17 19:14:55：消失後只剩「送達」（一般畫面）→ 1 秒計時 → disappear
  w = new DeliveryWatch();
  w.observe(0, obs('送達\n確認已送達\n是否已送達?'));
  assert.equal(w.observe(10, obs('送達')), null);
  assert.deepEqual(w.tick(11), { kind: 'send', delaySec: 1, why: 'disappear', no: null });
  // 送完回待命（上線中）
  w = new DeliveryWatch();
  w.observe(0, obs('送達\n確認已送達'));
  w.observe(3, obs('上線中\n今日收入'));
  assert.equal(w.tick(4).why, 'disappear');
});

test('切到別的 App：已開始的消失確認作廢（含 1 秒計時），回來再看', () => {
  const w = new DeliveryWatch();
  w.observe(0, obs(S.DIALOG));
  assert.equal(w.observe(5, obs('送達')), null); // 一般畫面第 1 次沒看到 → 計時
  assert.equal(w.deadline, 6);
  assert.equal(w.observe(5.5, obs(S.OTHER)), null); // 1 秒內切走
  assert.equal(w.deadline, null);
  assert.equal(w.tick(7), null);
  assert.equal(w.observe(30, obs(S.DIALOG)), null); // 回來按鈕還在（同一次顯示，不重報 visible）
  assert.equal(w.active, true);
});

test(`退路：對話框 ${DELIVERY_STAY_GONE_SEC} 秒沒再出現且在 pandarider → stayGone（疊單送完 A 直接進 B 的送餐頁、沒讀到訂單完成）`, () => {
  const w = new DeliveryWatch();
  w.observe(0, obs(S.DIALOG));
  for (let t = 5; t < 5 + DELIVERY_STAY_GONE_SEC; t += 10) assert.equal(w.observe(t, obs('即將抵達\n顧客地址')), null, String(t));
  assert.equal(w.deadline, 5 + DELIVERY_STAY_GONE_SEC);
  assert.deepEqual(w.tick(5 + DELIVERY_STAY_GONE_SEC), { kind: 'send', delaySec: 60, why: 'stayGone', no: null });
  // 期間對話框又出現 → 重算；最後一幀不是 pandarider → 不從計時器送，回到 pandarider 才送
  const v = new DeliveryWatch();
  v.observe(0, obs(S.DIALOG));
  v.observe(5, obs(S.ARRIVE));
  v.observe(100, obs(S.DIALOG));
  v.observe(101, obs(S.ARRIVE));
  assert.equal(v.tick(200), null);
  assert.equal(v.deadline, 101 + DELIVERY_STAY_GONE_SEC);
  v.observe(150, obs(S.OTHER));
  assert.equal(v.deadline, null);
  assert.equal(v.tick(400), null);
  assert.equal(v.observe(401, obs(S.ARRIVE)).why, 'stayGone');
  // 0＝不走退路
  const z = new DeliveryWatch(0);
  z.observe(0, obs(S.DIALOG));
  z.observe(5, obs(S.ARRIVE));
  assert.equal(z.deadline, null);
  assert.equal(z.tick(1000), null);
  assert.equal(z.finish(1000), null); // 沒有在確認中的消失 → 停止也不送
});

test('Swift 與 TS 同規則：stay/leave 字樣、退路秒數、暫離作廢、SampleHandler 傳 stay', () => {
  const on = read('../targets/broadcast/OrderNumbers.swift');
  for (const s of [
    `static let stayPattern = "${DELIVERY_STAY_KEYWORDS}"`, `static let leavePattern = "${DELIVERY_LEAVE_KEYWORDS}"`,
    `static let stayGoneSeconds: TimeInterval = ${DELIVERY_STAY_GONE_SEC}`, 'if accept { return false }',
    'stay(raw, accept: analyzed.summary.accept)', 'guard visible, lastPanda, stayGoneSec > 0, let at = absentAt else { return nil }',
    'if stay {\n        // v1.2.4', 'return send(now, why: "stayGone", delay: d.isFinite ? min(60, max(0, Int(d))) : 0)',
  ]) {
    assert.ok(on.includes(s), s);
  }
  // !panda：作廢後回 nil（不能再 tick 送出）；同一單號：連 absentAt 一起清
  const watch = on.slice(on.indexOf('final class DeliveryWatch'), on.indexOf('final class DeliveryGate'));
  const away = watch.slice(watch.indexOf('if !panda {'), watch.indexOf('if let n = no, numbers.contains(n) {'));
  assert.ok(away.includes('resetMiss()') && away.includes('return nil') && !away.includes('tick('));
  const same = watch.slice(watch.indexOf('if let n = no, numbers.contains(n) {'), watch.indexOf('if stay {'));
  assert.ok(same.includes('absentAt = nil'));
  assert.equal((watch.match(/absentAt = nil/g) ?? []).length, 4); // dialog/同號/finish/send
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['stay = analyzed.stay', 'changed: why != "force", numbers: scan.numbers, stay: stay)']) assert.ok(ext.includes(s), s);
});
