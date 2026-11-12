// v0.6 遠端回報：原生 client（PandaTelemetry.swift ×2）與伺服器（server/index.mjs）欄位白名單、節流參數一致
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('PandaTelemetry.swift 兩份逐字相同', () => {
  assert.equal(read('../targets/broadcast/PandaTelemetry.swift'), read('../modules/live-activity/ios/PandaTelemetry.swift'));
});

test('欄位白名單：Swift allowedKeys ＝ 伺服器 FIELD_RULES 的鍵', () => {
  const swift = read('../modules/live-activity/ios/PandaTelemetry.swift');
  const block = swift.slice(swift.indexOf('static let allowedKeys: Set<String> = ['), swift.indexOf('private let endpoint'));
  const swiftKeys = [...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]).sort();
  const server = read('../server/index.mjs');
  const sblock = server.slice(server.indexOf('const FIELD_RULES = {'), server.indexOf('const MAX_STR'));
  const serverKeys = [...sblock.matchAll(/\b([A-Za-z]+):/g)].map((m) => m[1]).sort();
  assert.deepEqual(swiftKeys, serverKeys);
  for (const forbidden of ['text', 'ocrText', 'address', 'addr', 'store', 'customer', 'name', 'phone']) {
    assert.ok(!swiftKeys.includes(forbidden), forbidden);
  }
});

test('節流參數：批次 10 筆／60 秒（v0.9）／暫存 200 筆／每分鐘 ≤100 筆（伺服器 120）', () => {
  const swift = read('../modules/live-activity/ios/PandaTelemetry.swift');
  for (const s of ['static let maxBuffer = 200', 'static let batchSize = 10', 'static let flushInterval = 60', 'static let maxPerMinute = 100']) {
    assert.ok(swift.includes(s), s);
  }
  assert.ok(read('../server/index.mjs').includes("process.env.TELEMETRY_RATE_PER_MIN || 120"));
  // 設定來源：Info.plist（plugins/withTelemetry.js 寫入）
  const plugin = read('../plugins/withTelemetry.js');
  for (const k of ['PandaTelemetryKey', 'PandaTelemetryURL', 'PandaRuntimeVersion']) {
    assert.ok(plugin.includes(k), k);
    assert.ok(swift.includes(`"${k}"`), k);
  }
});

test('withTelemetry plugin：從 extra 寫進 Info.plist、缺值就報錯', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const plugin = require('../plugins/withTelemetry.js');
  // withInfoPlist 只是登記 mods.ios.infoPlist；直接呼叫那個 mod（模擬 prebuild 傳入的 Info.plist）
  const run = async (cfg) => {
    const withMod = plugin(structuredClone(cfg));
    return (await withMod.mods.ios.infoPlist({ ...withMod, modResults: {}, modRequest: { platform: 'ios', introspect: false } })).modResults;
  };
  const config = {
    name: 'x', slug: 'x', runtimeVersion: '0.6',
    extra: { telemetryKey: 'k'.repeat(43), telemetryUrl: 'https://example.com/pandatimer/api/telemetry', configUrl: 'https://example.com/pandatimer/api/config' },
  };
  const plist = await run(config);
  assert.equal(plist.PandaTelemetryKey, 'k'.repeat(43));
  assert.equal(plist.PandaTelemetryURL, 'https://example.com/pandatimer/api/telemetry');
  assert.equal(plist.PandaRuntimeVersion, '0.6');
  assert.equal(plist.PandaConfigURL, 'https://example.com/pandatimer/api/config');
  await assert.rejects(run({ ...config, extra: { ...config.extra, configUrl: undefined } }), /configUrl/);
  await assert.rejects(run({ ...config, extra: {} }), /telemetryKey/);
  await assert.rejects(run({ ...config, extra: { ...config.extra, telemetryUrl: 'http://x' } }), /https/);
});

test('讀取金鑰不在 repo 內任何追蹤檔', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const keyFile = `${os.homedir()}/.config/pandatimer/telemetry-read-key`;
  if (!fs.existsSync(keyFile)) return; // CI 沒有本機金鑰
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const root = new URL('..', import.meta.url).pathname;
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const full = `${root}${f}`;
    if (!fs.existsSync(full) || fs.statSync(full).size > 2_000_000) continue;
    assert.ok(!fs.readFileSync(full, 'utf8').includes(key), `讀取金鑰出現在 ${f}`);
  }
});
