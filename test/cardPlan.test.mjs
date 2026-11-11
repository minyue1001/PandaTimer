// v0.6 多單：偵測卡顯示最早截止那單，其餘寫進 others（與 DetectorCardPlan.swift 同規則）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { othersText, planCard, sortByDeadline } from '../src/cardPlan.ts';

const at = (h, m) => new Date(2026, 10, 12, h, m).getTime();
const o = (id, acceptedAt, min, activityId = 'DET') => ({ id, acceptedAt, estimateMin: min, deadline: acceptedAt + min * 60_000, activityId });

test('othersText：0 單 null；1~3 單列時間；超過 3 單加 …', () => {
  assert.equal(othersText([]), null);
  assert.equal(othersText([o('a', at(18, 20), 22)]), '另 1 單：18:42 截止');
  assert.equal(othersText([o('a', at(18, 20), 22), o('b', at(18, 30), 25)]), '另 2 單：18:42、18:55 截止');
  const five = [10, 20, 30, 40, 50].map((m, i) => o(`x${i}`, at(19, 0), m));
  assert.equal(othersText(five), '另 5 單：19:10、19:20、19:30… 截止');
});

test('planCard：主單＝最早截止（不是最新接的），others 列其餘；只看這張卡', () => {
  const mirror = [
    o('first', at(18, 0), 40), // 18:40 截止
    o('second', at(18, 10), 18), // 18:28 截止 ← 最早
    o('third', at(18, 15), 30), // 18:45
    o('manual', at(18, 5), 10, 'OTHER'), // 別張卡
  ];
  const p = planCard(mirror, 'DET');
  assert.equal(p.main.id, 'second');
  assert.equal(p.count, 3);
  assert.equal(p.others, '另 2 單：18:40、18:45 截止');
  // 送達 second 之後 → 自動切到 first
  const p2 = planCard(mirror.filter((x) => x.id !== 'second'), 'DET');
  assert.equal(p2.main.id, 'first');
  assert.equal(p2.others, '另 1 單：18:45 截止');
  // 全部送達 → 回待命
  assert.deepEqual(planCard(mirror.filter((x) => x.activityId !== 'DET'), 'DET'), { main: null, others: null, count: 0 });
});

test('sortByDeadline：同截止依接單時間', () => {
  const a = o('a', at(18, 10), 20);
  const b = o('b', at(18, 0), 30);
  assert.deepEqual(sortByDeadline([a, b]).map((x) => x.id), ['b', 'a']);
});

test('Swift 三份 DetectorCardPlan 逐字相同，文字規則與 TS 一致', () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
  const a = read('../native/intents/DetectorCardPlan.swift');
  assert.equal(read('../modules/live-activity/ios/DetectorCardPlan.swift'), a);
  assert.equal(read('../targets/widget/DetectorCardPlan.swift'), a);
  assert.ok(a.includes('return "另 \\(rest.count) 單：\\(times)\\(more) 截止"'));
  assert.ok(a.includes('.joined(separator: "、")'));
  assert.ok(a.includes('let more = rest.count > maxListed ? "…" : ""'));
  assert.ok(a.includes('static let maxListed = 3'));
  assert.ok(a.includes('a.deadline != b.deadline ? a.deadline < b.deadline : a.acceptedAt < b.acceptedAt'));
  // ContentState 三份都有 others（Optional＋預設 nil）
  for (const p of ['../native/intents/PandaTimerAttributes.swift', '../modules/live-activity/ios/PandaTimerAttributes.swift', '../targets/widget/PandaTimerAttributes.swift']) {
    assert.ok(read(p).includes('var others: String? = nil'), p);
  }
});
