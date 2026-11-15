// v1.2.3 同一次送達只結一張（DeliveryGate）：11/15 實機時序＋Swift 同規則
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_DELIVERY, DeliveryGate } from '../src/deliveryDetector.ts';
import { DEFAULT_CONFIG, RANGES, validateConfig } from '../src/remoteConfig.ts';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
/** 'HH:mm:ss' → 秒 */
const T = (hms) => hms.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
const plain = (delaySec = 0, result = 'noNumber') => ({ seq: null, delaySec, result });
const seq = (n, delaySec = 0) => ({ seq: n, delaySec, result: 'seq' });

/** 依時間跑一串訊號（中間每秒 tick 一次＝計時器），最後跑到 end；回傳所有 send（含送出時間） */
function run(events, end, gate = new DeliveryGate()) {
  const sends = [];
  const drops = [];
  const take = (now, acts) => {
    for (const a of acts) {
      if (a.kind === 'send') sends.push({ at: now, seq: a.signal.seq, delaySec: a.delaySec, heldSec: a.heldSec, result: a.signal.result });
      if (a.kind === 'drop') drops.push({ at: now, seq: a.signal.seq, reason: a.reason });
    }
  };
  const list = [...events].sort((a, b) => a[0] - b[0]);
  const start = list[0][0];
  for (let t = start; t <= end; t++) {
    take(t, gate.tick(t));
    for (const [at, sig] of list) if (at === t) take(t, gate.offer(t, sig));
  }
  return { sends, drops };
}

test('預設 sameDeliverySec=30、plainHoldSec=12；設定範圍與驗證', () => {
  assert.equal(DEFAULT_DELIVERY.sameDeliverySec, 30);
  assert.equal(DEFAULT_DELIVERY.plainHoldSec, 12);
  assert.equal(DEFAULT_CONFIG.delivery.sameDeliverySec, 30);
  assert.equal(DEFAULT_CONFIG.delivery.plainHoldSec, 12);
  assert.deepEqual(RANGES['delivery.sameDeliverySec'], [0, 120, true]);
  assert.deepEqual(RANGES['delivery.plainHoldSec'], [0, 60, true]);
  const bad = validateConfig({ version: 'x', delivery: { sameDeliverySec: 121, plainHoldSec: 1.5 } });
  assert.equal(bad.config.delivery.sameDeliverySec, 30);
  assert.equal(bad.config.delivery.plainHoldSec, 12);
  const ok = validateConfig({ version: 'x', delivery: { sameDeliverySec: 0, plainHoldSec: 60 } });
  assert.equal(ok.config.delivery.sameDeliverySec, 0);
  assert.equal(ok.config.delivery.plainHoldSec, 60);
  const def = JSON.parse(read('../server/config.default.json'));
  assert.equal(def.delivery.sameDeliverySec, 30);
  assert.equal(def.delivery.plainHoldSec, 12);
});

test('10:41 先 seq3 後 plain（相隔 6 秒）→ 只送 seq3（plain 被當同一次送達丟掉）', () => {
  const { sends, drops } = run([[T('10:41:46'), seq(3, 0)], [T('10:41:52'), plain(1)]], T('10:43:00'));
  assert.deepEqual(sends.map((s) => [s.seq, s.delaySec, s.at]), [[3, 0, T('10:41:46')]]);
  assert.deepEqual(drops.map((d) => d.reason), ['sameDelivery']);
});

test('00:33 / 01:36 / 03:13 先 plain 後 seq（相隔 9/5/8 秒）→ 只送 seq、delay＝seq 自己的', () => {
  for (const [p, s, n, d] of [['00:33:08', '00:33:17', 3, 0], ['01:36:46', '01:36:51', 1, 2], ['03:13:41', '03:13:49', 3, 1]]) {
    const { sends, drops } = run([[T(p), plain(1)], [T(s), seq(n, d)]], T(s) + 120);
    assert.deepEqual(sends.map((x) => [x.seq, x.delaySec, x.heldSec, x.at]), [[n, d, 0, T(s)]], p);
    assert.deepEqual(drops.map((x) => [x.seq, x.reason]), [[null, 'superseded']], p);
  }
});

test('plain 暫緩到期沒等到 seq → 照送，delay＝原 delay＋暫緩秒數（App 記的仍是畫面消失那刻）', () => {
  const { sends } = run([[T('00:33:08'), plain(1)]], T('00:35:00'));
  assert.deepEqual(sends.map((x) => [x.seq, x.delaySec, x.heldSec, x.at]), [[null, 13, 12, T('00:33:20')]]);
  // delay 上限 60
  const g = new DeliveryGate(30, 60);
  assert.equal(g.offer(0, plain(5))[0].kind, 'hold');
  assert.equal(g.deadline, 60);
  assert.deepEqual(g.tick(59), []);
  const [a] = g.tick(60);
  assert.equal(a.kind, 'send');
  assert.equal(a.delaySec, 60);
});

test('02:39 兩個 plain 相隔 10 秒 → 只送一個（第一個，暫緩到期送）', () => {
  const { sends, drops } = run([[T('02:39:49'), plain(1)], [T('02:39:59'), plain(0)]], T('02:42:00'));
  assert.deepEqual(sends.map((x) => [x.seq, x.delaySec, x.at]), [[null, 13, T('02:40:01')]]);
  assert.deepEqual(drops.map((x) => x.reason), ['heldPlain']);
  // 不暫緩（plainHoldSec=0）時：第一個立刻送、第二個被 sameDelivery 擋
  const r0 = run([[T('02:39:49'), plain(1)], [T('02:39:59'), plain(0)]], T('02:42:00'), new DeliveryGate(30, 0));
  assert.deepEqual(r0.sends.map((x) => [x.seq, x.delaySec, x.at]), [[null, 1, T('02:39:49')]]);
  assert.deepEqual(r0.drops.map((x) => x.reason), ['sameDelivery']);
});

test('兩張真的分開 >30 秒送達 → 兩個都送（plain/plain、seq/plain、plain/seq）', () => {
  const pp = run([[0, plain(1)], [31, plain(0)]], 200);
  assert.deepEqual(pp.sends.map((x) => [x.seq, x.at]), [[null, 12], [null, 43]]);
  const sp = run([[0, seq(2)], [35, plain(0)]], 200);
  assert.deepEqual(sp.sends.map((x) => [x.seq, x.at]), [[2, 0], [null, 47]]);
  const ps = run([[0, plain(0)], [40, seq(1)]], 200);
  assert.deepEqual(ps.sends.map((x) => [x.seq, x.at]), [[null, 12], [1, 40]]);
  // 30 秒內的第二個 plain（以第一個的判定時間起算）→ 丟
  const near = run([[0, plain(0)], [25, plain(0)]], 200);
  assert.deepEqual(near.sends.map((x) => x.at), [12]);
  assert.deepEqual(near.drops.map((x) => x.reason), ['sameDelivery']);
});

test('兩個不同 seq 相隔 10 秒 → 都送；同 seq → 只送一次', () => {
  const diff = run([[0, seq(1)], [10, seq(2)]], 100);
  assert.deepEqual(diff.sends.map((x) => [x.seq, x.at]), [[1, 0], [2, 10]]);
  const same = run([[0, seq(1)], [10, seq(1)]], 100);
  assert.deepEqual(same.sends.map((x) => [x.seq, x.at]), [[1, 0]]);
  assert.deepEqual(same.drops.map((x) => x.reason), ['sameSeq']);
  // 同 seq 但已過 30 秒 → 照送（真的另一張占了同槽的情況由 OrderNumberBook 處理）
  const later = run([[0, seq(1)], [31, seq(1)]], 100);
  assert.equal(later.sends.length, 2);
});

test('廣播停止（finish）→ 暫緩中的 plain 立刻送，delay 含暫緩秒數；沒暫緩 → 不送', () => {
  const g = new DeliveryGate();
  assert.deepEqual(g.finish(0), []);
  assert.equal(g.offer(100, plain(2))[0].kind, 'hold');
  const [a] = g.finish(105);
  assert.deepEqual([a.kind, a.signal.seq, a.delaySec, a.heldSec], ['send', null, 7, 5]);
  assert.equal(g.deadline, null);
  assert.deepEqual(g.finish(106), []);
  // finish 送出的那個也算「最近送達」：之後 30 秒內 plain 不送
  assert.equal(g.offer(110, plain(0))[0].reason, 'sameDelivery');
});

test('sameDeliverySec=0 → 不擋（只剩暫緩合併）', () => {
  const r = run([[0, seq(3)], [6, plain(1)]], 100, new DeliveryGate(0, 12));
  assert.deepEqual(r.sends.map((x) => [x.seq, x.at]), [[3, 0], [null, 18]]);
});

test('Swift：DeliveryGate 同規則、SampleHandler 兩條送達路徑都經過 gate、finish 在 stopped 前 flush', () => {
  const on = read('../targets/broadcast/OrderNumbers.swift');
  for (const s of ['final class DeliveryGate {', 'var sameDeliverySec: TimeInterval = 30', 'var plainHoldSec: TimeInterval = 12',
    'if held != nil { return out + [.drop(signal, reason: "heldPlain")] }',
    'if recent(now) { return out + [.drop(signal, reason: "sameDelivery")] }',
    'if plainHoldSec <= 0 { return out + [emit(now, decidedAt: now, signal)] }',
    'out.append(.drop(h.signal, reason: "superseded"))',
    'if recent(now), let l = last, l.seq == signal.seq { return out + [.drop(signal, reason: "sameSeq")] }',
    'guard let h = held, now.timeIntervalSince(h.at) >= plainHoldSec else { return [] }',
    'return [emit(now, decidedAt: h.at, h.signal)]', 'last = (at: decidedAt, seq: signal.seq)',
    'return .send(signal, delay: min(60, signal.delay + heldSec), held: heldSec)']) {
    assert.ok(on.includes(s), s);
  }
  const ext = read('../targets/broadcast/SampleHandler.swift');
  for (const s of ['private let gate = DeliveryGate()', 'gate.sameDeliverySec = TimeInterval(next.delivery.sameDeliverySec)',
    'gate.plainHoldSec = TimeInterval(next.delivery.plainHoldSec)',
    'applyGate(gate.offer(now, DeliveryGate.Signal(seq: seq, delay: delay, result: result, fields: fields)))',
    'let deadlines = [tracker.deadline, deliveryEdge.deadline, watch.deadline, gate.deadline].compactMap { $0 }',
    'self.applyGate(self.gate.tick(Date()))']) {
    assert.ok(ext.includes(s), s);
  }
  // Darwin 訊號只在 applyGate 的 send 送出（sendDelivered 不直接送）
  const send = ext.slice(ext.indexOf('private func sendDelivered('), ext.indexOf('private func applyGate('));
  assert.ok(!send.includes('PandaSignal.post'), 'sendDelivered 不得直接送訊號');
  const apply = ext.slice(ext.indexOf('private func applyGate('), ext.indexOf('// MARK: - v0.7 邀請 → 接單判定'));
  assert.ok(apply.indexOf('PandaSignal.postDeliveredDelay(delay)') < apply.indexOf('PandaSignal.postDeliveredSeq(seq)'));
  assert.ok(apply.indexOf('PandaSignal.postDeliveredDelay(delay)') < apply.indexOf('PandaSignal.post(PandaSignal.delivered)'));
  // 兩條送達路徑（appear 的 handleDelivery、disappear 的 handleWatch）都走 sendDelivered
  const hd = ext.slice(ext.indexOf('private func handleDelivery('), ext.indexOf('private func handleWatch('));
  const hw = ext.slice(ext.indexOf('private func handleWatch('), ext.indexOf('private func sendDelivered('));
  assert.ok(hd.includes('sendDelivered(') && !hd.includes('PandaSignal.post'));
  assert.ok(hw.includes('sendDelivered(') && !hw.includes('PandaSignal.post'));
  const fin = ext.slice(ext.indexOf('func finish()'), ext.indexOf('/// v0.8：ReplayKit 暫停'));
  assert.ok(fin.indexOf('self.handleWatch(self.watch.finish(Date()), info: nil)') < fin.indexOf('self.applyGate(self.gate.finish(Date()))'));
  assert.ok(fin.indexOf('self.applyGate(self.gate.finish(Date()))') < fin.indexOf('PandaSignal.post(PandaSignal.stopped)'));
  for (const f of ['../targets/broadcast/RemoteConfig.swift', '../modules/live-activity/ios/RemoteConfig.swift']) {
    const rc = read(f);
    for (const s of ['var sameDeliverySec = 30', 'var plainHoldSec = 12', 'int(d["sameDeliverySec"], 0, 120, out.sameDeliverySec)',
      'int(d["plainHoldSec"], 0, 60, out.plainHoldSec)']) {
      assert.ok(rc.includes(s), `${f}: ${s}`);
    }
  }
});
