// 自架伺服器（server/index.mjs）本機實跑：既有 OTA 端點（health/manifest/assets/簽章）＋ v0.6 /api/telemetry。
// 以子程序起在 127.0.0.1 隨機埠（PORT=0），資料都在暫存目錄；結束只 kill 自己起的 PID。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER = new URL('../server/index.mjs', import.meta.url).pathname;
const WRITE_KEY = crypto.randomBytes(32).toString('base64url');
const READ_KEY = crypto.randomBytes(32).toString('base64url');
const procs = [];
let tmp;
let base;
let publicKey;

function today(tz = 'Asia/Taipei') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: '0',
      UPDATES_DIR: path.join(tmp, 'updates'),
      PRIVATE_KEY_PATH: path.join(tmp, 'private-key.pem'),
      PUBLIC_URL: 'http://127.0.0.1:9',
      TELEMETRY_DIR: path.join(tmp, 'telemetry'),
      TELEMETRY_WRITE_KEY: WRITE_KEY,
      TELEMETRY_READ_KEY: READ_KEY,
      CONFIG_PATH: path.join(tmp, 'config.json'),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(child);
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server 沒起來：${out}`)), 5000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    child.on('exit', (code) => reject(new Error(`server 結束 code=${code}：${out}`)));
  });
  return `http://127.0.0.1:${port}`;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-server-test-'));
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = pub;
  fs.writeFileSync(path.join(tmp, 'private-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const upd = path.join(tmp, 'updates', '0.6', '1762900000000');
  fs.mkdirSync(path.join(upd, '_expo', 'static', 'js', 'ios'), { recursive: true });
  fs.mkdirSync(path.join(upd, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(upd, '_expo/static/js/ios/entry-abc.hbc'), 'console.log("bundle")');
  fs.writeFileSync(path.join(upd, 'assets/aaa'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  fs.writeFileSync(path.join(upd, 'metadata.json'), JSON.stringify({
    version: 0, bundler: 'metro',
    fileMetadata: { ios: { bundle: '_expo/static/js/ios/entry-abc.hbc', assets: [{ path: 'assets/aaa', ext: 'png' }] } },
  }));
  fs.writeFileSync(path.join(upd, 'expoConfig.json'), JSON.stringify({ name: 'PandaTimer', runtimeVersion: '0.6' }));
  // 15 天前的回報檔：啟動時應被清掉（保留 14 天）
  fs.mkdirSync(path.join(tmp, 'telemetry'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'telemetry', '2020-01-01.jsonl'), '{"ts":"2020-01-01T00:00:00Z","ev":"old"}\n');
  base = await startServer();
});

after(() => {
  for (const p of procs) if (p.exitCode == null) p.kill('SIGTERM');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const manifestHeaders = (rv, extra = {}) => ({ 'expo-platform': 'ios', 'expo-runtime-version': rv, 'expo-protocol-version': '1', ...extra });
const post = (body, key = WRITE_KEY, headers = {}) =>
  fetch(`${base}/api/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-pt-key': key } : {}), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (query = '', key = READ_KEY) => fetch(`${base}/api/telemetry${query}`, { headers: key ? { 'x-pt-read': key } : {} });

test('既有：/api/health = ok', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'ok');
});

test('既有：未知 runtimeVersion → noUpdateAvailable；缺 header → 400', async () => {
  const r = await fetch(`${base}/api/manifest`, { headers: manifestHeaders('deploy-check') });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /"noUpdateAvailable"/);
  const bad = await fetch(`${base}/api/manifest`, { headers: { 'expo-platform': 'ios' } });
  assert.equal(bad.status, 400);
});

test('既有：manifest multipart＋RSA 簽章可驗、資產可下載、未列出的資產 404', async () => {
  const r = await fetch(`${base}/api/manifest`, { headers: manifestHeaders('0.6', { 'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"' }) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('expo-protocol-version'), '1');
  const boundary = /boundary=(.+)$/.exec(r.headers.get('content-type'))[1];
  const text = await r.text();
  const part = text.split(`--${boundary}`).find((p) => p.includes('name="manifest"'));
  const [head, ...rest] = part.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n').replace(/\r\n$/, '');
  const sig = /sig="([^"]+)"/.exec(head)[1];
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(body), publicKey, Buffer.from(sig, 'base64')), '簽章驗證');
  const manifest = JSON.parse(body);
  assert.equal(manifest.runtimeVersion, '0.6');
  assert.equal(manifest.assets.length, 1);
  const assetUrl = new URL(manifest.launchAsset.url);
  const a = await fetch(`${base}${assetUrl.pathname}${assetUrl.search}`);
  assert.equal(a.status, 200);
  assert.equal(await a.text(), 'console.log("bundle")');
  const missing = await fetch(`${base}/api/assets?asset=1762900000000/metadata.json&runtimeVersion=0.6&platform=ios`);
  assert.equal(missing.status, 404);
  // 同一個 update id → noUpdateAvailable
  const again = await fetch(`${base}/api/manifest`, { headers: manifestHeaders('0.6', { 'expo-current-update-id': manifest.id }) });
  assert.match(await again.text(), /"noUpdateAvailable"/);
});

test('既有端點仍只收 GET：POST /api/manifest → 405', async () => {
  const r = await fetch(`${base}/api/manifest`, { method: 'POST', body: '{}' });
  assert.equal(r.status, 405);
});

test('telemetry：寫入金鑰錯/缺 → 401；讀取金鑰拿來寫 → 401', async () => {
  assert.equal((await post({ ev: 'x', src: 'app' }, 'wrong')).status, 401);
  assert.equal((await post({ ev: 'x', src: 'app' }, null)).status, 401);
  assert.equal((await post({ ev: 'x', src: 'app' }, READ_KEY)).status, 401);
});

test('telemetry：正確寫入 → GET 讀得到；只留白名單欄位、kw 只留白名單關鍵字、附伺服器時間', async () => {
  const r = await post([
    { t: 1, src: 'ext', dev: 'd1', ev: 'order', min: 27, amt: 110.26, km: 6.7, seq: 0, accept: true,
      kw: ['接受訂單', '鬍鬚張魯肉飯', '拒絕'], text: '台北市XX路 王先生', addr: '台北市', screen: 'newOrder' },
    { src: 'ext', dev: 'd1', ev: 'beat', memMB: 31.2, peakMB: 35.9, note: 'x'.repeat(500) },
    { src: 'ext', noEv: true },
  ]);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, accepted: 2 });
  const g = await get(`?date=${today()}`);
  assert.equal(g.status, 200);
  const data = await g.json();
  const order = data.records.find((x) => x.ev === 'order');
  assert.ok(order, '讀得到剛寫的');
  assert.ok(!Number.isNaN(Date.parse(order.ts)), '附伺服器時間 ts');
  assert.deepEqual(order.kw, ['接受訂單', '拒絕']);
  assert.equal(order.text, undefined);
  assert.equal(order.addr, undefined);
  assert.equal(order.min, 27);
  assert.equal(order.amt, 110.26);
  assert.equal(data.records.find((x) => x.ev === 'beat').note.length, 80);
  // since：之後沒有新資料 → 空
  const g2 = await get(`?date=${today()}&since=${encodeURIComponent(data.next)}`);
  assert.equal((await g2.json()).count, 0);
  // 檔案在 TELEMETRY_DIR/YYYY-MM-DD.jsonl
  assert.ok(fs.existsSync(path.join(tmp, 'telemetry', `${today()}.jsonl`)));
});

test('telemetry：讀取金鑰錯/缺、拿寫入金鑰讀 → 401；壞日期 → 400', async () => {
  assert.equal((await get('', 'wrong')).status, 401);
  assert.equal((await get('', null)).status, 401);
  assert.equal((await get('', WRITE_KEY)).status, 401);
  assert.equal((await get('?date=2026-1-1')).status, 400);
});

test('telemetry：壞 JSON → 400；超過 64KB → 413；PUT → 405', async () => {
  assert.equal((await post('{nope')).status, 400);
  const big = [{ src: 'ext', dev: 'big', ev: 'x', note: 'y'.repeat(70 * 1024) }];
  assert.equal((await post(big)).status, 413);
  const put = await fetch(`${base}/api/telemetry`, { method: 'PUT', headers: { 'x-pt-key': WRITE_KEY }, body: '[]' });
  assert.equal(put.status, 405);
});

test('telemetry：同來源每分鐘超過 120 筆 → 429；別的來源不受影響', async () => {
  const batch = (n, dev) => Array.from({ length: n }, (_, i) => ({ src: 'app', dev, ev: 'beat', seq: i }));
  assert.equal((await post(batch(100, 'rate'))).status, 200);
  assert.equal((await post(batch(20, 'rate'))).status, 200); // 剛好 120
  const over = await post(batch(1, 'rate'));
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /Rate limit/);
  assert.equal((await post(batch(1, 'other'))).status, 200);
});

test('telemetry：超過 14 天的檔案在啟動時清掉', () => {
  assert.equal(fs.existsSync(path.join(tmp, 'telemetry', '2020-01-01.jsonl')), false);
});

test('telemetry：單日檔案超過上限 → 429（另起一個上限 300 bytes 的實例）', async () => {
  const dir = path.join(tmp, 'telemetry-small');
  const small = await startServer({ TELEMETRY_DIR: dir, TELEMETRY_DAY_MAX_BYTES: '300' });
  const send = (n) =>
    fetch(`${small}/api/telemetry`, {
      method: 'POST',
      headers: { 'x-pt-key': WRITE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ src: 'ext', dev: 'cap', ev: 'beat', seq: n }),
    });
  assert.equal((await send(1)).status, 200);
  let last;
  for (let i = 2; i < 10; i++) {
    last = await send(i);
    if (last.status !== 200) break;
  }
  assert.equal(last.status, 429);
  assert.match((await last.json()).error, /Daily/);
  assert.ok(fs.statSync(path.join(dir, `${today()}.jsonl`)).size <= 300);
});

test('沒設金鑰 → /api/telemetry 503，其他端點照常', async () => {
  const off = await startServer({ TELEMETRY_WRITE_KEY: '', TELEMETRY_READ_KEY: '' });
  const r = await fetch(`${off}/api/telemetry`, { method: 'POST', headers: { 'x-pt-key': 'x' }, body: '{}' });
  assert.equal(r.status, 503);
  assert.equal(await (await fetch(`${off}/api/health`)).text(), 'ok');
});

// ---------- v0.6 遠端設定 /api/config ----------
const DEFAULT_CFG = JSON.parse(fs.readFileSync(new URL('../server/config.default.json', import.meta.url), 'utf8'));
const cfgPath = () => path.join(tmp, 'config.json');

test('config：檔案不存在 → 內建預設（config.default.json）＋ETag＋Cache-Control 60 秒；If-None-Match → 304', async () => {
  fs.rmSync(cfgPath(), { force: true });
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=60');
  assert.equal(r.headers.get('x-config-source'), 'builtin');
  const etag = r.headers.get('etag');
  assert.match(etag, /^".+"$/);
  const body = await r.json();
  assert.deepEqual(body, DEFAULT_CFG);
  assert.equal(body.picker.ratePerMinute, 4.08355);
  const again = await fetch(`${base}/api/config`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  // 公開：不需要任何金鑰；HEAD 也可以
  assert.equal((await fetch(`${base}/api/config`, { method: 'HEAD' })).status, 200);
});

test('config：檔案只寫部分欄位 → 其餘用內建預設補齊；改檔立即生效、ETag 變', async () => {
  const before = (await fetch(`${base}/api/config`)).headers.get('etag');
  fs.writeFileSync(cfgPath(), JSON.stringify({ version: 'test-2', picker: { ratePerMinute: 5 }, detector: { dedupeSeconds: 120 } }));
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.headers.get('x-config-source'), 'file');
  assert.notEqual(r.headers.get('etag'), before);
  const body = await r.json();
  assert.equal(body.version, 'test-2');
  assert.equal(body.picker.ratePerMinute, 5);
  assert.equal(body.picker.minFare, DEFAULT_CFG.picker.minFare);
  assert.equal(body.picker.minutePattern, DEFAULT_CFG.picker.minutePattern);
  assert.equal(body.detector.dedupeSeconds, 120);
  assert.equal(body.detector.ocrIntervalSeconds, DEFAULT_CFG.detector.ocrIntervalSeconds);
  assert.deepEqual(body.telemetry, DEFAULT_CFG.telemetry);
});

test('v0.7 config：檔案沒有 offer/stats（例如 v0.6 時代的 config.json）→ 由內建預設補齊新欄位', async () => {
  fs.writeFileSync(cfgPath(), JSON.stringify({ version: 'v06-file', detector: { dedupeSeconds: 90 } }));
  const body = await (await fetch(`${base}/api/config`)).json();
  assert.equal(body.version, 'v06-file');
  assert.deepEqual(body.offer, DEFAULT_CFG.offer);
  assert.equal(body.offer.decideWindowSec, 25);
  assert.equal(body.offer.ambiguousAs, 'accept');
  assert.deepEqual(body.stats, { graceFactor: 1.05, overrunCap: 1 });
  // 只覆寫部分 offer 欄位 → 其餘仍是預設
  fs.writeFileSync(cfgPath(), JSON.stringify({ version: 'v07-part', offer: { decideWindowSec: 40 } }));
  const part = await (await fetch(`${base}/api/config`)).json();
  assert.equal(part.offer.decideWindowSec, 40);
  assert.equal(part.offer.acceptedKeywords, DEFAULT_CFG.offer.acceptedKeywords);
  fs.rmSync(cfgPath(), { force: true });
  // 讓伺服器快取回到「檔案不存在」（快取鍵是 mtime|size；下一個測試寫的檔案若同大小同毫秒會被當成沒變）
  assert.equal((await fetch(`${base}/api/config`)).headers.get('x-config-source'), 'builtin');
});

test('config：檔案壞掉（不是 JSON 物件）→ 回內建預設、不當機', async () => {
  fs.writeFileSync(cfgPath(), '{ this is not json, longer than before to change size');
  const r = await fetch(`${base}/api/config`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-config-source'), 'builtin');
  assert.equal((await r.json()).version, DEFAULT_CFG.version);
  fs.writeFileSync(cfgPath(), '[1,2,3]');
  assert.equal((await fetch(`${base}/api/config`)).headers.get('x-config-source'), 'builtin');
});

test('config：遠端設定新增的回報關鍵字，伺服器白名單也收', async () => {
  const cfg = structuredClone(DEFAULT_CFG);
  cfg.version = 'test-kw';
  cfg.telemetry.keywords.push(['新按鈕', '新按钮']);
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg));
  assert.equal((await (await fetch(`${base}/api/config`)).json()).version, 'test-kw');
  const r = await post([{ src: 'ext', dev: 'kw', ev: 'screen', kw: ['新按鈕', '接受訂單', '店名不該進來'] }]);
  assert.equal(r.status, 200);
  const data = await (await get(`?date=${today()}&limit=5000`)).json();
  const rec = data.records.filter((x) => x.dev === 'kw').pop();
  assert.deepEqual(rec.kw, ['新按鈕', '接受訂單']);
  fs.rmSync(cfgPath(), { force: true });
});
