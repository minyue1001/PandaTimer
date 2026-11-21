// v1.2.7 暫緩中的 plain：送達確認畫面又出現＝剛才「消失」只是閃爍 → 丟掉（11/21 16:31 實機時序＋Swift 同規則）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DeliveryGate, DeliveryWatch } from '../src/deliveryDetector.ts';
import { scanNumbers } from '../src/orderNumbers.ts';
import { pandaPresent } from '../src/powerSaver.ts';
import { summarizeScreen } from '../src/screenInfo.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const T = (hms) => hms.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
const AWAY = '上線中|送達|訂單|確認已送達|付款方式|接受訂單';
const DIALOG = '送達\n聯絡\n確認已送達\n無法聯繫顧客\n付款方式';
const DIALOG_NO = (n) => `${DIALOG}\n#${n}`;
const GONE = '送達';

function obs(text) {
  const sum = summarizeScreen(text);
  const sc = scanNumbers(text);
  return { dialog: sc.dialog, final: sum.deliveredFinal || sc.final, panda: pandaPresent(text, sum.accept, AWAY), dialogNo: sc.dialogNo, changed: true, numbers: sc.numbers, stay: false };
}

/** 模擬 SampleHandler：watch.send → gate.offer；watch.visible → gate.cancelHeld；每秒 tick */
function drive(frames, end, { cancel = true } = {}) {
  const w = new DeliveryWatch();
  const g = new DeliveryGate();
  const sends = [];
  const drops = [];
  const take = (t, acts) => {
    for (const a of acts) {
      if (a.kind === 'send') sends.push([t, a.signal.seq, a.delaySec]);
      if (a.kind === 'drop') drops.push([t, a.signal.seq, a.reason]);
    }
  };
  const handle = (t, act) => {
    if (!act) return;
    if (act.kind === 'send') take(t, g.offer(t, { seq: act.no ? 3 : null, delaySec: act.delaySec }));
    if (act.kind === 'visible' && cancel) take(t, g.cancelHeld());
  };
  for (let t = Math.floor(Math.min(...frames.map((f) => f[0]))); t <= end; t++) {
    for (const [at, text] of frames) if (Math.floor(at) === t) handle(t, w.observe(t, obs(text)));
    handle(t, w.tick(t));
    take(t, g.tick(t));
  }
  return { sends, drops, w, g };
}

test('11/21 16:31：消失→暫緩→12 秒內畫面又出現 → 丟 plain（drop reappeared），不提早結單', () => {
  const { sends, drops, w } = drive([[T('16:31:33'), DIALOG], [T('16:31:36'), GONE], [T('16:31:48'), DIALOG]], T('16:32:30'));
  assert.deepEqual(sends, []);
  assert.deepEqual(drops, [[T('16:31:48'), null, 'reappeared']]);
  assert.equal(w.active, true); // 回到可見、等待消失
});

test('對照：沒有 cancelHeld（舊行為）→ 16:31:48 暫緩到期送出提早結單', () => {
  const { sends } = drive([[T('16:31:33'), DIALOG], [T('16:31:36'), GONE], [T('16:31:48'), DIALOG]], T('16:32:30'), { cancel: false });
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], T('16:31:49')); // 16:31:37 暫緩 + 12 秒（實機 wait=13 同）
});

test('丟掉後 16:33:33 真送達（有單號 seq）照常送；之後不再有 plain', () => {
  const { sends, drops } = drive(
    [[T('16:31:33'), DIALOG], [T('16:31:36'), GONE], [T('16:31:48'), DIALOG_NO(7)], [T('16:33:30'), DIALOG_NO(7)], [T('16:33:32'), GONE]],
    T('16:34:30'),
  );
  assert.deepEqual(drops.map((d) => d[2]), ['reappeared']);
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1], 3);
  assert.ok(sends[0][0] >= T('16:33:32'));
});

test('沒再出現 → 暫緩到期照送（一般 plain 不受影響）；有單號 seq 不受 cancelHeld 影響', () => {
  const r = drive([[T('16:31:33'), DIALOG], [T('16:31:36'), GONE]], T('16:32:30'));
  assert.equal(r.sends.length, 1);
  assert.equal(r.sends[0][1], null);
  const g = new DeliveryGate();
  const out = g.offer(0, { seq: 2, delaySec: 0 });
  assert.equal(out[0].kind, 'send');
  assert.deepEqual(g.cancelHeld(), []); // 沒有暫緩中的 plain → 無動作
  assert.equal(g.offer(5, { seq: 2, delaySec: 0 })[0].reason, 'sameSeq');
});

test('Swift：DeliveryGate.cancelHeld＋handleWatch .visible 呼叫 applyGate(gate.cancelHeld())', () => {
  const on = read('../targets/broadcast/OrderNumbers.swift');
  assert.ok(on.includes('func cancelHeld() -> [Action]') && on.includes('.drop(h.signal, reason: "reappeared")'));
  const ext = read('../targets/broadcast/SampleHandler.swift');
  const hw = ext.slice(ext.indexOf('private func handleWatch('), ext.indexOf('private func sendDelivered('));
  const vis = hw.slice(hw.indexOf('case .visible:'), hw.indexOf('case .repeatSuppressed:'));
  assert.ok(vis.includes('applyGate(gate.cancelHeld())'));
});
