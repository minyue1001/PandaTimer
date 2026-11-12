#!/usr/bin/env node
// 熊貓倒數 PandaTimer — 自架 expo-updates 伺服器（Expo Updates protocol v1，零依賴）
// 參考：https://docs.expo.dev/technical-specs/expo-updates-1/ 與 expo/custom-expo-updates-server
//
// 端點（nginx 把 https://wheat.yueshengift.xyz/pandatimer/ 轉到本服務根目錄）：
//   GET /api/manifest   header: expo-platform / expo-runtime-version / expo-protocol-version / expo-expect-signature
//   GET /api/assets?asset=<timestamp>/<相對路徑>&runtimeVersion=<rv>&platform=ios
//   GET /api/health     → "ok"
//   GET /api/config     公開、無金鑰：遠端設定 JSON（CONFIG_PATH；不存在/壞掉 → 內建預設 config.default.json），
//        檔案缺的欄位以內建預設補齊（物件逐層合併、陣列整個取代）；ETag＋Cache-Control 60 秒，If-None-Match → 304
//   POST /api/telemetry header x-pt-key: <寫入金鑰>；body JSON 物件或陣列（≤64KB；每來源每分鐘 ≤120 筆）
//        → 只留白名單欄位（FIELD_RULES）、附伺服器時間 ts → TELEMETRY_DIR/YYYY-MM-DD.jsonl（台北日期；保留 14 天、單日 ≤20MB）
//   GET /api/telemetry?date=YYYY-MM-DD&since=<ISO>&limit=N   header x-pt-read: <讀取金鑰>
//        → {date, count, records[], truncated, next}（有 since：since 之後最早的 N 筆；沒有：最後 N 筆）
//   隱私鐵律：不得收 OCR 原文、地址、店名、顧客資訊 → 伺服器只收白名單鍵、字串截短、kw 只收白名單關鍵字。
//   訂單雲端同步（資料庫 DATA_DIR/orders.db，node:sqlite；邏輯在 orders.mjs）：
//   POST /api/sync      header x-pt-sync: <同步碼>；body {since, changes:{orders[], baselines[]}}（≤64KB、≤300 筆）
//        → LWW 合併（updatedAt 較新者勝、刪除＝deleted 墓碑）→ {now, more, dbId, reset, changes, accepted, invalid}
//   GET  /admin         管理網頁（admin.html，CSP nonce）；登入後 HttpOnly+Secure+SameSite=Strict 簽章 cookie（12 小時）
//   /api/admin/*        login/logout/session、orders（列表/新增/編輯/刪除/還原）、baselines、sync-code/reset、export.csv
//        寫入一律要 cookie＋x-pt-csrf＋JSON；GET orders/baselines/export.csv 也可用 x-pt-read（讀取金鑰）唯讀
//        登入失敗 5 次 → 鎖 15 分鐘（全域：nginx 沒帶可信的來源 IP）；同步碼錯 10 次 → 鎖 15 分鐘
//
// 資料目錄：UPDATES_DIR/<runtimeVersion>/<timestamp>/ = `npx expo export -p ios` 的 dist + expoConfig.json
//   - 取數字最大的 timestamp；以 "." 開頭的目錄（上傳中）忽略
//   - 目錄內有 `rollback` 檔 → 回 rollBackToEmbedded directive（回到 App 內建版本）
//
// 環境變數：
//   HOST (127.0.0.1)  PORT (3970)  UPDATES_DIR (/opt/pandatimer-updates/updates)
//   PRIVATE_KEY_PATH (/opt/pandatimer-updates/keys/private-key.pem)
//   PUBLIC_URL (https://wheat.yueshengift.xyz/pandatimer)：manifest 內資產網址的前綴
//   TELEMETRY_DIR (/opt/pandatimer-updates/telemetry)  TELEMETRY_WRITE_KEY  TELEMETRY_READ_KEY（兩把金鑰由
//   systemd EnvironmentFile=/opt/pandatimer-updates/server.env 提供；沒設 → /api/telemetry 回 503）
//   CONFIG_PATH (/opt/pandatimer-updates/config.json)；內建預設＝本檔旁的 config.default.json
//   TELEMETRY_TZ (Asia/Taipei)  TELEMETRY_RATE_PER_MIN (120)  TELEMETRY_DAY_MAX_BYTES (20MB)  TELEMETRY_KEEP_DAYS (14)
//   DATA_DIR (/opt/pandatimer-updates/data)：orders.db＋backup/（每日 VACUUM INTO，留 14 份）
//   ADMIN_PASSWORD（server.env；沒設或 <12 字 → 管理登入 503）  SYNC_CODE（server.env；資料庫還沒有同步碼時的初始值）
//   ADMIN_COOKIE_PATH (/pandatimer)  ADMIN_COOKIE_SECURE (1；本機 http 測試可設 0)  SYNC_RATE_PER_MIN (60)

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { formatSyncCode, normalizeSyncCode, openStore } from './orders.mjs';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3970);
const UPDATES_DIR = path.resolve(process.env.UPDATES_DIR || '/opt/pandatimer-updates/updates');
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || '/opt/pandatimer-updates/keys/private-key.pem';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://wheat.yueshengift.xyz/pandatimer').replace(/\/+$/, '');
const TELEMETRY_DIR = path.resolve(process.env.TELEMETRY_DIR || '/opt/pandatimer-updates/telemetry');
const TELEMETRY_WRITE_KEY = process.env.TELEMETRY_WRITE_KEY || '';
const TELEMETRY_READ_KEY = process.env.TELEMETRY_READ_KEY || '';
const TELEMETRY_TZ = process.env.TELEMETRY_TZ || 'Asia/Taipei';
const TELEMETRY_RATE_PER_MIN = Number(process.env.TELEMETRY_RATE_PER_MIN || 120);
const TELEMETRY_DAY_MAX_BYTES = Number(process.env.TELEMETRY_DAY_MAX_BYTES || 20 * 1024 * 1024);
const TELEMETRY_KEEP_DAYS = Number(process.env.TELEMETRY_KEEP_DAYS || 14);
const TELEMETRY_MAX_BODY = 64 * 1024;
const CONFIG_PATH = path.resolve(process.env.CONFIG_PATH || '/opt/pandatimer-updates/config.json');
const DEFAULT_CONFIG_PATH = new URL('./config.default.json', import.meta.url);
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/opt/pandatimer-updates/data');
const DB_PATH = path.join(DATA_DIR, 'orders.db');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SYNC_CODE_SEED = process.env.SYNC_CODE || '';
const ADMIN_COOKIE_PATH = process.env.ADMIN_COOKIE_PATH || '/pandatimer';
const ADMIN_COOKIE_SECURE = process.env.ADMIN_COOKIE_SECURE !== '0';
const SYNC_RATE_PER_MIN = Number(process.env.SYNC_RATE_PER_MIN || 60);
const ADMIN_HTML_PATH = new URL('./admin.html', import.meta.url);
const KEY_ID = 'main';
const ALG = 'rsa-v1_5-sha256';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
  json: 'application/json', txt: 'text/plain', html: 'text/html', css: 'text/css',
  js: 'application/javascript', hbc: 'application/javascript', bundle: 'application/javascript',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', caf: 'audio/x-caf',
  mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf', db: 'application/octet-stream',
};
const mimeOf = (ext) => MIME[String(ext || '').toLowerCase()] || 'application/octet-stream';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- 簽章 ----------
let privateKeyCache = null;
async function getPrivateKey() {
  if (privateKeyCache) return privateKeyCache;
  try {
    privateKeyCache = await fsp.readFile(PRIVATE_KEY_PATH, 'utf8');
  } catch {
    return null;
  }
  return privateKeyCache;
}

function signRSASHA256(data, privateKeyPem) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

// Expo SFV dictionary：sig="...", keyid="main", alg="rsa-v1_5-sha256"
const sfvString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
async function signatureHeaderFor(body, req) {
  if (!req.headers['expo-expect-signature']) return null;
  const key = await getPrivateKey();
  if (!key) throw new HttpError(500, 'Code signing requested but no private key configured');
  const sig = signRSASHA256(body, key);
  return `sig=${sfvString(sig)}, keyid=${sfvString(KEY_ID)}, alg=${sfvString(ALG)}`;
}

// ---------- 雜湊（依 mtime/size 快取） ----------
const hashCache = new Map();
async function fileHashes(filePath) {
  const st = await fsp.stat(filePath);
  const cacheKey = `${filePath}|${st.mtimeMs}|${st.size}`;
  const hit = hashCache.get(cacheKey);
  if (hit) return hit;
  const buf = await fsp.readFile(filePath);
  const value = {
    sha256: crypto.createHash('sha256').update(buf).digest('base64url'),
    md5: crypto.createHash('md5').update(buf).digest('hex'),
  };
  if (hashCache.size > 2000) hashCache.clear();
  hashCache.set(cacheKey, value);
  return value;
}

const toUUID = (hex) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

// ---------- 更新目錄 ----------
async function latestUpdate(runtimeVersion) {
  if (!SAFE_SEGMENT.test(runtimeVersion)) throw new HttpError(400, 'Invalid runtime version');
  const rvDir = path.join(UPDATES_DIR, runtimeVersion);
  let entries;
  try {
    entries = await fsp.readdir(rvDir, { withFileTypes: true });
  } catch {
    return null; // 未知 runtimeVersion
  }
  const stamps = entries
    .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : BigInt(b) < BigInt(a) ? -1 : 0));
  for (const ts of stamps) {
    const dir = path.join(rvDir, ts);
    if (fs.existsSync(path.join(dir, 'rollback'))) return { kind: 'rollback', ts, dir };
    if (fs.existsSync(path.join(dir, 'metadata.json'))) return { kind: 'update', ts, dir };
  }
  return null;
}

function resolveInside(base, rel) {
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) throw new HttpError(400, 'Invalid asset path');
  return full;
}

function assetUrl(runtimeVersion, ts, relPath) {
  const q = new URLSearchParams({ asset: `${ts}/${relPath}`, runtimeVersion, platform: 'ios' });
  return `${PUBLIC_URL}/api/assets?${q.toString()}`;
}

async function buildManifest(runtimeVersion, upd) {
  const metadataPath = path.join(upd.dir, 'metadata.json');
  const metadataBuf = await fsp.readFile(metadataPath);
  const metadata = JSON.parse(metadataBuf.toString('utf8'));
  const ios = metadata?.fileMetadata?.ios;
  if (!ios?.bundle) throw new HttpError(500, 'metadata.json has no ios bundle');

  let expoClient = {};
  try {
    expoClient = JSON.parse(await fsp.readFile(path.join(upd.dir, 'expoConfig.json'), 'utf8'));
  } catch {
    throw new HttpError(500, 'expoConfig.json missing or invalid');
  }

  const bundlePath = resolveInside(upd.dir, ios.bundle);
  const bh = await fileHashes(bundlePath);
  const launchAsset = {
    hash: bh.sha256,
    key: bh.md5,
    contentType: 'application/javascript',
    url: assetUrl(runtimeVersion, upd.ts, ios.bundle),
  };

  const assets = [];
  for (const a of ios.assets || []) {
    const ah = await fileHashes(resolveInside(upd.dir, a.path));
    assets.push({
      hash: ah.sha256,
      key: ah.md5,
      fileExtension: `.${a.ext}`,
      contentType: mimeOf(a.ext),
      url: assetUrl(runtimeVersion, upd.ts, a.path),
    });
  }

  // id：metadata 內容 + rv + timestamp → 同一份 dist 重新發佈（換 timestamp）也會得到新 id
  const idHex = crypto.createHash('sha256')
    .update(metadataBuf).update('\0').update(runtimeVersion).update('\0').update(upd.ts)
    .digest('hex');

  return {
    id: toUUID(idHex),
    createdAt: new Date(Number(upd.ts)).toISOString(),
    runtimeVersion,
    launchAsset,
    assets,
    metadata: {},
    extra: { expoClient },
  };
}

// ---------- multipart ----------
function multipart(parts) {
  const boundary = `pandatimer-${crypto.randomBytes(12).toString('hex')}`;
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\nContent-Type: application/json; charset=utf-8\r\n`;
    if (p.signature) head += `expo-signature: ${p.signature}\r\n`;
    chunks.push(head + '\r\n', p.body, '\r\n');
  }
  chunks.push(`--${boundary}--\r\n`);
  return { boundary, body: Buffer.from(chunks.join(''), 'utf8') };
}

async function sendParts(res, req, name, obj, extra = []) {
  const body = JSON.stringify(obj);
  const signature = await signatureHeaderFor(body, req);
  const mp = multipart([{ name, body, signature }, ...extra]);
  res.writeHead(200, {
    'expo-protocol-version': '1',
    'expo-sfv-version': '0',
    'cache-control': 'private, max-age=0',
    'content-type': `multipart/mixed; boundary=${mp.boundary}`,
    'content-length': mp.body.length,
  });
  res.end(mp.body);
}

const sendNoUpdate = (res, req) => sendParts(res, req, 'directive', { type: 'noUpdateAvailable' });

// ---------- handlers ----------
async function handleManifest(req, res, url) {
  const protocolVersion = Number(req.headers['expo-protocol-version'] ?? 0);
  const platform = req.headers['expo-platform'] || url.searchParams.get('platform');
  const runtimeVersion = req.headers['expo-runtime-version'] || url.searchParams.get('runtime-version');
  if (platform !== 'ios') throw new HttpError(400, 'Unsupported platform. Expected "ios".');
  if (!runtimeVersion) throw new HttpError(400, 'No runtimeVersion provided.');
  if (protocolVersion !== 1) throw new HttpError(400, 'Only expo-protocol-version 1 is supported.');
  if (!SAFE_SEGMENT.test(runtimeVersion)) throw new HttpError(400, 'Invalid runtime version');

  const upd = await latestUpdate(runtimeVersion);
  if (!upd) return sendNoUpdate(res, req);

  if (upd.kind === 'rollback') {
    return sendParts(res, req, 'directive', {
      type: 'rollBackToEmbedded',
      parameters: { commitTime: new Date(Number(upd.ts)).toISOString() },
    });
  }

  const manifest = await buildManifest(runtimeVersion, upd);
  const currentId = String(req.headers['expo-current-update-id'] || '').toLowerCase();
  if (currentId && currentId === manifest.id) return sendNoUpdate(res, req);

  const extensions = { name: 'extensions', body: JSON.stringify({ assetRequestHeaders: {} }) };
  return sendParts(res, req, 'manifest', manifest, [extensions]);
}

async function handleAsset(req, res, url) {
  const asset = url.searchParams.get('asset') || '';
  const runtimeVersion = url.searchParams.get('runtimeVersion') || '';
  const platform = url.searchParams.get('platform') || '';
  if (platform !== 'ios') throw new HttpError(400, 'Unsupported platform. Expected "ios".');
  if (!SAFE_SEGMENT.test(runtimeVersion)) throw new HttpError(400, 'Invalid runtime version');
  const m = /^(\d+)\/(.+)$/.exec(asset);
  if (!m) throw new HttpError(400, 'Invalid asset parameter');
  const updateDir = path.join(UPDATES_DIR, runtimeVersion, m[1]);
  const filePath = resolveInside(updateDir, m[2]);

  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(path.join(updateDir, 'metadata.json'), 'utf8'));
  } catch {
    throw new HttpError(404, 'Update not found');
  }
  const ios = metadata?.fileMetadata?.ios || {};
  let contentType;
  if (m[2] === ios.bundle) contentType = 'application/javascript';
  else {
    const entry = (ios.assets || []).find((a) => a.path === m[2]);
    if (!entry) throw new HttpError(404, 'Asset not listed in update');
    contentType = mimeOf(entry.ext);
  }

  let st;
  try {
    st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    throw new HttpError(404, 'Asset not found');
  }
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': st.size,
    'cache-control': 'public, max-age=31536000, immutable',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
}



// ---------- 遠端設定（v0.6 /api/config） ----------
const isPlainObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isPlainObject(base[k]) && isPlainObject(v) ? deepMerge(base[k], v) : v;
  return out;
}

let builtinConfig = null;
function loadBuiltinConfig() {
  if (builtinConfig) return builtinConfig;
  try {
    builtinConfig = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  } catch {
    builtinConfig = { version: 'builtin' };
  }
  return builtinConfig;
}

// 依 CONFIG_PATH 的 mtime/size 快取；每次請求 stat 一次（改檔立即生效，不用重啟）
let configCache = { key: null, body: null, text: null, etag: null, source: null };
function currentConfig() {
  let key = 'missing';
  let st = null;
  try {
    st = fs.statSync(CONFIG_PATH);
    key = `${st.mtimeMs}|${st.size}`;
  } catch { /* 不存在 → 內建預設 */ }
  if (configCache.key === key && configCache.body) return configCache;
  let body = loadBuiltinConfig();
  let source = 'builtin';
  if (st) {
    try {
      const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (!isPlainObject(file)) throw new Error('not an object');
      body = deepMerge(body, file);
      source = 'file';
    } catch (e) {
      console.error(`[config] ${CONFIG_PATH} 讀不到或不是 JSON 物件，改用內建預設：${e.message}`);
    }
  }
  const text = JSON.stringify(body);
  const etag = `"${crypto.createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;
  configCache = { key, body, text, etag, source };
  return configCache;
}

function handleConfig(req, res) {
  const c = currentConfig();
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=60',
    etag: c.etag,
    'x-config-source': c.source,
  };
  if (String(req.headers['if-none-match'] || '') === c.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': Buffer.byteLength(c.text) });
  if (req.method === 'HEAD') return res.end();
  res.end(c.text);
}

// ---------- telemetry（v0.6 遠端狀態回報） ----------
// ⚠️ 白名單關鍵字與 src/screenInfo.ts 的 KEYWORD_NAMES、targets/broadcast/OrderDetector.swift 的 ScreenInfo.keywords 一致；
//    欄位鍵名與 PandaTelemetry.swift 的 allowedKeys 一致（test/telemetry.test.mjs 比對）。
const TELEMETRY_KEYWORDS = [
  '接受訂單', '拒絕', '前往取餐', '抵達餐廳', '已取餐', '前往送餐', '抵達', '送達', '完成訂單',
  '上線中', '休息中', '訂單詳情', '聯絡', '導航', '拍照', '確認取餐', '取消',
  '已拒絕', '訂單已取消', '逾時', '已過期', '已抵達', '抵達店家', '聯絡店家', '取餐',
  '訂單已完成', '已送達', '送達完成', '確認送達', '完成送達',
  '夾單', '訂單完成', '確認已送達', '確認已取餐', '是否已取餐', '是否已送達', 'pickedup', '即將抵達', '上傳照片', '無法聯繫',
  '筆訂單', '即將準備完成', '取餐體驗', '每單收入',
];
const BUILTIN_KEYWORDS = new Set(TELEMETRY_KEYWORDS);
/** 白名單＝內建 ∪ 目前遠端設定 telemetry.keywords 的正式名稱（設定檔由擁有者維護） */
function keywordAllowed(word) {
  if (BUILTIN_KEYWORDS.has(word)) return true;
  const rows = currentConfig().body?.telemetry?.keywords;
  return Array.isArray(rows) && rows.some((r) => Array.isArray(r) && r[0] === word);
}
const N = 'num', B = 'bool', S = 'str';
// 型別：num（有限數字）、bool、str（截 80 字）、kw（白名單字串陣列）
const FIELD_RULES = {
  t: N, src: S, ev: S, dev: S, ver: S, rv: S, upd: S,
  seq: N, gap: N, frames: N, ocr: N, skip: N, fails: N, errs: N, memMB: N, peakMB: N,
  accept: B, min: N, amt: N, km: N, kw: 'kw', screen: S, interval: N, triggers: N, dups: N,
  island: S, islandErr: S, keep: S, auth: S, fg: S, orders: N, others: S, susp: B,
  note: S, code: N, sent: N, dropped: N, beatAge: N, reason: S, cfg: S,
  result: S, wait: N, delay: N, hit: 'kw',
  // v0.8：OCR 前後記憶體差最大值、綠色金額比例、OCR 觸發原因、夾單、鎖屏（距上次鎖屏秒數／目前是否鎖屏）
  dMB: N, green: N, trig: S, stacked: B, lockAge: N, locked: B,
  // v0.9 省電量測：電量%、充電中、溫度狀態 0~3、低電量模式；ext 每分鐘 OCR 次數/取樣次數/模式/away 秒數/省電倍率生效；app 動態島略過次數
  batt: N, charging: B, thermal: N, lowPower: B, ocrMin: N, probes: N, mode: S, awaySec: N, saver: B, cardSkip: N,
};
const MAX_STR = 80;

/** 單筆紀錄 → 只留白名單欄位；不是物件或沒有 ev → null */
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  for (const [k, type] of Object.entries(FIELD_RULES)) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) continue;
    const v = r[k];
    if (type === N) { if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; }
    else if (type === B) { if (typeof v === 'boolean') out[k] = v; }
    else if (type === S) { if (typeof v === 'string' && v.length) out[k] = v.slice(0, MAX_STR); }
    else if (type === 'kw') {
      if (Array.isArray(v)) out[k] = [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 12 && keywordAllowed(x)))];
    }
  }
  if (typeof out.ev !== 'string') return null;
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (!x.length || !y.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TELEMETRY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDate = (ms) => dateFmt.format(new Date(ms)); // YYYY-MM-DD
const telemetryFile = (date) => path.join(TELEMETRY_DIR, `${date}.jsonl`);

// 來源（src|dev）每 60 秒的筆數；外加全域上限（來源數×4）避免換 dev 灌爆磁碟
const rateBuckets = new Map();
function rateAllow(key, n, now) {
  const take = (k, limit) => {
    let b = rateBuckets.get(k);
    if (!b || now - b.start >= 60_000) { b = { start: now, count: 0 }; rateBuckets.set(k, b); }
    return { ok: b.count + n <= limit, commit: () => { b.count += n; } };
  };
  if (rateBuckets.size > 5000) {
    // 只清掉來源 bucket，保留全域 '*'，避免輪換 dev 欄位繞過全域上限
    for (const k of rateBuckets.keys()) if (k !== '*') rateBuckets.delete(k);
  }
  const one = take(`s:${key}`, TELEMETRY_RATE_PER_MIN);
  const all = take('*', TELEMETRY_RATE_PER_MIN * 4);
  if (!one.ok || !all.ok) return false;
  one.commit(); all.commit();
  return true;
}

async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, `Body too large (> ${limit} bytes)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, `Body too large (> ${limit} bytes)`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

let lastPrune = 0;
async function pruneTelemetry(now) {
  if (now - lastPrune < 60 * 60 * 1000) return;
  lastPrune = now;
  const keepFrom = localDate(now - (TELEMETRY_KEEP_DAYS - 1) * 86_400_000);
  let names = [];
  try { names = await fsp.readdir(TELEMETRY_DIR); } catch { return; }
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (m && m[1] < keepFrom) await fsp.rm(path.join(TELEMETRY_DIR, name), { force: true }).catch(() => undefined);
  }
}

let writeChain = Promise.resolve();
async function handleTelemetryPost(req, res) {
  if (!TELEMETRY_WRITE_KEY) throw new HttpError(503, 'Telemetry not configured');
  if (!safeEqual(req.headers['x-pt-key'], TELEMETRY_WRITE_KEY)) throw new HttpError(401, 'Bad key');
  const body = await readBody(req, TELEMETRY_MAX_BODY);
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  const list = (Array.isArray(parsed) ? parsed : [parsed]).map(sanitizeRecord).filter(Boolean);
  if (!list.length) throw new HttpError(400, 'No valid records');
  if (list.length > 500) throw new HttpError(413, 'Too many records');
  const now = Date.now();
  const first = list[0];
  if (!rateAllow(`${first.src || '-'}|${first.dev || '-'}`, list.length, now)) {
    throw new HttpError(429, `Rate limit: ${TELEMETRY_RATE_PER_MIN} records/min per source`);
  }
  const ts = new Date(now).toISOString();
  const text = list.map((r) => JSON.stringify({ ts, ...r })).join('\n') + '\n';
  const file = telemetryFile(localDate(now));
  const run = writeChain.then(async () => {
    await fsp.mkdir(TELEMETRY_DIR, { recursive: true });
    let size = 0;
    try { size = (await fsp.stat(file)).size; } catch { /* 今天第一筆 */ }
    if (size + Buffer.byteLength(text) > TELEMETRY_DAY_MAX_BYTES) throw new HttpError(429, 'Daily telemetry quota reached');
    await fsp.appendFile(file, text, { mode: 0o640 });
  });
  writeChain = run.catch(() => undefined);
  await run;
  void pruneTelemetry(now);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: true, accepted: list.length }));
}

async function handleTelemetryGet(req, res, url) {
  if (!TELEMETRY_READ_KEY) throw new HttpError(503, 'Telemetry not configured');
  if (!safeEqual(req.headers['x-pt-read'], TELEMETRY_READ_KEY)) throw new HttpError(401, 'Bad key');
  const date = url.searchParams.get('date') || localDate(Date.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Invalid date');
  const sinceRaw = url.searchParams.get('since');
  const since = sinceRaw ? Date.parse(sinceRaw) : null;
  if (sinceRaw && !Number.isFinite(since)) throw new HttpError(400, 'Invalid since');
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 500));
  let text = '';
  try { text = await fsp.readFile(telemetryFile(date), 'utf8'); } catch { /* 沒有資料 */ }
  let records = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (since == null || Date.parse(r.ts) > since) records.push(r);
    } catch { /* 壞行略過 */ }
  }
  const total = records.length;
  records = since == null ? records.slice(-limit) : records.slice(0, limit);
  const next = records.length ? records[records.length - 1].ts : sinceRaw;
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ date, count: records.length, total, truncated: total > records.length, next, records }));
}

// ---------- 訂單資料庫／同步／管理頁 ----------
let storePromise = null;
let storeReady = null;
function getStore() {
  if (!storePromise) {
    storePromise = openStore(DB_PATH, { seedSyncCode: SYNC_CODE_SEED })
      .then((s) => (storeReady = s))
      .catch((e) => {
        console.error(`[db] 開不了 ${DB_PATH}：${e.message}`);
        storePromise = null;
        throw new HttpError(503, 'Database unavailable');
      });
  }
  return storePromise;
}

/** 秘密比對：先 sha256 再 timingSafeEqual（長度也不洩漏） */
function secretEqual(a, b) {
  if (!a || !b) return false;
  const h = (x) => crypto.createHash('sha256').update(String(x), 'utf8').digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

/** 失敗次數鎖：連續失敗 maxFails 次 → 鎖 lockMs（全域；nginx 沒帶可信的來源 IP，X-Forwarded-For 可被偽造不能用） */
function makeLock(maxFails, lockMs) {
  let fails = 0;
  let lastFail = 0;
  let lockedUntil = 0;
  return {
    wait: (now) => Math.max(0, lockedUntil - now),
    fail(now) {
      if (now - lastFail > lockMs) fails = 0;
      lastFail = now;
      fails += 1;
      const n = fails;
      if (fails >= maxFails) {
        lockedUntil = now + lockMs;
        fails = 0;
      }
      return n;
    },
    ok() {
      fails = 0;
    },
  };
}
const LOCK_MS = 15 * 60_000;
const loginLock = makeLock(5, LOCK_MS);
const syncLock = makeLock(10, LOCK_MS);

const windows = new Map();
function windowAllow(key, limit, now) {
  let w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

function sendJson(res, status, obj, headers = {}) {
  const text = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function lockedError(waitMs, what) {
  const err = new HttpError(429, `${what}失敗太多次，請 ${Math.ceil(waitMs / 60_000)} 分鐘後再試`);
  err.headers = { 'retry-after': String(Math.ceil(waitMs / 1000)) };
  return err;
}

async function readJson(req, limit) {
  const body = await readBody(req, limit);
  try {
    return JSON.parse(body.toString('utf8') || 'null');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

const SYNC_MAX_BODY = 64 * 1024;
const SYNC_MAX_RECORDS = 300;
async function handleSync(req, res) {
  const store = await getStore();
  const now = Date.now();
  const wait = syncLock.wait(now);
  if (wait) throw lockedError(wait, '同步碼');
  if (!windowAllow('sync', SYNC_RATE_PER_MIN, now)) throw new HttpError(429, `Rate limit: ${SYNC_RATE_PER_MIN} syncs/min`);
  const given = req.headers['x-pt-sync'];
  if (!secretEqual(normalizeSyncCode(given), store.syncCode)) {
    // 沒帶碼不算猜錯（部署驗證、誤觸）；帶了錯的碼才計次
    if (given) {
      const n = syncLock.fail(now);
      console.warn(`[sync] 同步碼錯誤（${n}/10）`);
    }
    throw new HttpError(401, 'Bad sync code');
  }
  syncLock.ok();
  const body = await readJson(req, SYNC_MAX_BODY);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be an object');
  const ch = body.changes ?? {};
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) throw new HttpError(400, 'changes must be an object');
  const orders = ch.orders ?? [];
  const baselines = ch.baselines ?? [];
  if (!Array.isArray(orders) || !Array.isArray(baselines)) throw new HttpError(400, 'changes.orders/baselines must be arrays');
  if (orders.length + baselines.length > SYNC_MAX_RECORDS) throw new HttpError(413, `Too many records (> ${SYNC_MAX_RECORDS})`);
  const since = typeof body.since === 'number' && Number.isFinite(body.since) ? body.since : 0;
  const out = store.sync({ since, orders, baselines }, now);
  maybeBackup(store, now);
  sendJson(res, 200, out);
}

let lastBackupDay = '';
function maybeBackup(store, now) {
  const day = localDate(now);
  if (day === lastBackupDay) return;
  lastBackupDay = day;
  try {
    store.backup(path.join(DATA_DIR, 'backup'), day);
  } catch (e) {
    console.error(`[db] 備份失敗：${e.message}`);
  }
}

// ── 管理頁 session（簽章 cookie；金鑰＝資料庫裡的隨機 sessionKey × 管理密碼 → 改密碼即全部登出） ──
const SESSION_TTL_MS = 12 * 3_600_000;
const COOKIE = 'pt_admin';
const revoked = new Map(); // sid → exp（登出的 session，到期前拒收）
const adminConfigured = () => ADMIN_PASSWORD.length >= 12;
function sessionKey(store) {
  const pw = crypto.createHash('sha256').update(ADMIN_PASSWORD, 'utf8').digest();
  return crypto.createHmac('sha256', store.meta('sessionKey')).update('admin-session\0').update(pw).digest();
}
const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest('base64url');
function issueSession(store, now) {
  const sid = crypto.randomBytes(12).toString('base64url');
  const exp = now + SESSION_TTL_MS;
  const payload = `v1.${sid}.${exp}`;
  return { token: `${payload}.${hmac(sessionKey(store), payload)}`, sid, exp };
}
function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function verifySession(store, req, now) {
  const m = /^v1\.([A-Za-z0-9_-]{16})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(readCookie(req, COOKIE));
  if (!m || !adminConfigured()) return null;
  const exp = Number(m[2]);
  if (!(exp > now) || exp > now + SESSION_TTL_MS + 60_000) return null;
  if (!secretEqual(hmac(sessionKey(store), `v1.${m[1]}.${m[2]}`), m[3])) return null;
  if (revoked.has(m[1])) return null;
  return { sid: m[1], exp, csrf: hmac(sessionKey(store), `csrf.${m[1]}`) };
}
function cookieHeader(value, maxAgeSec) {
  return `${COOKIE}=${value}; Path=${ADMIN_COOKIE_PATH}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Strict${ADMIN_COOKIE_SECURE ? '; Secure' : ''}`;
}

/**
 * 管理 API 權限：
 *   write＝寫入：cookie session＋x-pt-csrf＋content-type JSON（有 Origin 時須同站）
 *   read＝讀取：cookie session 或 x-pt-read（讀取金鑰，主對話唯讀分析用）
 */
function requireAdmin(store, req, mode) {
  const now = Date.now();
  if (mode === 'read' && req.headers['x-pt-read'] != null) {
    if (TELEMETRY_READ_KEY && secretEqual(req.headers['x-pt-read'], TELEMETRY_READ_KEY)) return { via: 'key' };
    throw new HttpError(401, 'Bad key');
  }
  const s = verifySession(store, req, now);
  if (!s) throw new HttpError(401, 'Not logged in');
  if (mode === 'write') {
    if (!secretEqual(req.headers['x-pt-csrf'], s.csrf)) throw new HttpError(403, 'Bad CSRF token');
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'JSON only');
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch { /* 壞 Origin */ }
      if (host !== req.headers.host) throw new HttpError(403, 'Cross-origin request');
    }
  }
  return { via: 'session', ...s };
}

const TAIPEI_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
/** ?from=YYYY-MM-DD&to=YYYY-MM-DD（台北日期，兩端都含）→ [start, end)；預設最近 14 天；最多 400 天 */
function dateRange(url) {
  const parse = (s) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return NaN;
    return Date.parse(`${s}T00:00:00Z`) - TAIPEI_MS;
  };
  const f = url.searchParams.get('from');
  const t = url.searchParams.get('to');
  const todayStart = Math.floor((Date.now() + TAIPEI_MS) / DAY_MS) * DAY_MS - TAIPEI_MS;
  const end = t ? parse(t) + DAY_MS : todayStart + DAY_MS;
  const start = f ? parse(f) : end - 14 * DAY_MS;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new HttpError(400, 'Invalid from/to');
  if (end - start > 400 * DAY_MS) throw new HttpError(400, 'Range too long (> 400 days)');
  return { start, end };
}

function taipeiText(ms) {
  if (ms == null) return '';
  const d = new Date(ms + TAIPEI_MS);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // 擋試算表公式注入
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function ordersCsv(rows, graceFactor) {
  const head = ['id', '接單(台北)', '預估分', '送達(台北)', '實際分', '狀態', '準時', '金額', '夾單', '來源', '備註', '修改時間(台北)', '修改者', '已刪除'];
  const status = { active: '進行中', delivered: '已送達', canceled: '已取消' };
  const lines = [head.join(',')];
  for (const o of rows) {
    const act = o.deliveredAt != null ? Math.round(((o.deliveredAt - o.acceptedAt) / 60_000) * 10) / 10 : null;
    const ok = o.status === 'delivered' && act != null ? (act <= o.estimateMin * graceFactor + 1e-9 ? '準' : '超') : '';
    lines.push([
      o.id, taipeiText(o.acceptedAt), o.estimateMin, taipeiText(o.deliveredAt), act ?? '', status[o.status] ?? o.status, ok,
      o.amount ?? '', o.stacked ? '是' : '', o.source, o.note, taipeiText(o.updatedAt), o.editedBy, o.deleted ? '是' : '',
    ].map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}

let adminHtml = null;
function serveAdminPage(req, res) {
  if (adminHtml == null) adminHtml = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
  const nonce = crypto.randomBytes(16).toString('base64');
  const html = adminHtml.replaceAll('__NONCE__', nonce);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
    'content-security-policy':
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  if (req.method === 'HEAD') return res.end();
  res.end(html);
}

const ADMIN_MAX_BODY = 16 * 1024;
async function handleAdminApi(req, res, url) {
  const store = await getStore();
  const now = Date.now();
  if (!windowAllow('admin', 240, now)) throw new HttpError(429, 'Rate limit');
  const p = url.pathname.slice('/api/admin/'.length);
  const m = req.method;

  if (p === 'login' && m === 'POST') {
    if (!adminConfigured()) throw new HttpError(503, 'Admin password not configured');
    const wait = loginLock.wait(now);
    if (wait) throw lockedError(wait, '登入');
    const body = await readJson(req, 4096);
    const pw = body && typeof body.password === 'string' ? body.password : '';
    if (!secretEqual(pw, ADMIN_PASSWORD)) {
      const n = loginLock.fail(now);
      console.warn(`[admin] 登入失敗（${n}/5）${loginLock.wait(now) ? '，鎖 15 分鐘' : ''}`);
      throw new HttpError(401, '密碼錯誤');
    }
    loginLock.ok();
    const s = issueSession(store, now);
    console.log('[admin] 登入成功');
    return sendJson(res, 200, { ok: true, expiresAt: s.exp }, { 'set-cookie': cookieHeader(s.token, SESSION_TTL_MS / 1000) });
  }
  if (p === 'logout' && m === 'POST') {
    const s = verifySession(store, req, now);
    if (s) {
      revoked.set(s.sid, s.exp);
      for (const [sid, exp] of revoked) if (exp < now) revoked.delete(sid);
    }
    return sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader('', 0) });
  }
  if (p === 'session' && m === 'GET') {
    const s = requireAdmin(store, req, 'session');
    return sendJson(res, 200, { csrf: s.csrf, expiresAt: s.exp, syncCode: formatSyncCode(store.syncCode), dbId: store.dbId, counts: store.stats() });
  }
  if (p === 'sync-code/reset' && m === 'POST') {
    requireAdmin(store, req, 'write');
    const code = store.resetSyncCode();
    console.log('[admin] 已重設同步碼');
    return sendJson(res, 200, { syncCode: formatSyncCode(code) });
  }
  if (p === 'orders' && m === 'GET') {
    requireAdmin(store, req, 'read');
    const { start, end } = dateRange(url);
    const orders = store.listOrders(start, end, url.searchParams.get('deleted') === '1');
    return sendJson(res, 200, { from: start, to: end, count: orders.length, orders });
  }
  if (p === 'export.csv' && m === 'GET') {
    requireAdmin(store, req, 'read');
    const { start, end } = dateRange(url);
    const rows = store.listOrders(start, end, url.searchParams.get('deleted') === '1').reverse();
    const gf = Number(currentConfig().body?.stats?.graceFactor);
    const csv = ordersCsv(rows, Number.isFinite(gf) && gf >= 1 && gf <= 2 ? gf : 1.05);
    const name = `pandatimer-orders-${localDate(start)}_${localDate(end - 1)}.csv`;
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return res.end(csv);
  }
  if (p === 'orders' && m === 'POST') {
    requireAdmin(store, req, 'write');
    const body = await readJson(req, ADMIN_MAX_BODY);
    const r = store.createOrder(body && typeof body === 'object' && !Array.isArray(body) ? body : {});
    if (!r.ok) throw new HttpError(r.status ?? 400, r.error);
    return sendJson(res, 200, { order: r.value });
  }
  const om = /^orders\/([A-Za-z0-9._:-]{1,64})(\/restore)?$/.exec(p);
  if (om) {
    const id = om[1];
    let r;
    if (om[2] && m === 'POST') {
      requireAdmin(store, req, 'write');
      r = store.setOrderDeleted(id, false);
    } else if (!om[2] && m === 'PUT') {
      requireAdmin(store, req, 'write');
      const body = await readJson(req, ADMIN_MAX_BODY);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be an object');
      const fields = {};
      for (const k of ['acceptedAt', 'estimateMin', 'deliveredAt', 'status', 'amount', 'stacked', 'note']) if (k in body) fields[k] = body[k];
      r = store.updateOrder(id, fields);
    } else if (!om[2] && m === 'DELETE') {
      requireAdmin(store, req, 'write');
      r = store.setOrderDeleted(id, true);
    } else throw new HttpError(405, 'Method not allowed');
    if (!r.ok) throw new HttpError(r.status ?? 400, r.error);
    return sendJson(res, 200, { order: r.value });
  }
  if (p === 'baselines' && m === 'GET') {
    requireAdmin(store, req, 'read');
    return sendJson(res, 200, { baselines: store.listBaselines() });
  }
  const bm = /^baselines\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (bm) {
    let r;
    if (m === 'PUT') {
      requireAdmin(store, req, 'write');
      const body = await readJson(req, ADMIN_MAX_BODY);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body must be an object');
      r = store.putBaseline(bm[1], { orders: body.orders, onTimePct: body.onTimePct, overrunPct: body.overrunPct, income: body.income });
    } else if (m === 'DELETE') {
      requireAdmin(store, req, 'write');
      r = store.deleteBaseline(bm[1]);
    } else throw new HttpError(405, 'Method not allowed');
    if (!r.ok) throw new HttpError(r.status ?? 400, r.error);
    return sendJson(res, 200, { baseline: r.value });
  }
  throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  res.on('finish', () => {
    if (!url || url.pathname === '/api/health') return;
    if ((url.pathname === '/api/telemetry' || url.pathname === '/api/config' || url.pathname === '/api/sync') && res.statusCode < 400) return; // 很頻繁，成功的不寫 log
    if (url.pathname.startsWith('/api/admin/') && req.method === 'GET' && res.statusCode < 400) return;
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms rv=${req.headers['expo-runtime-version'] || url.searchParams.get('runtimeVersion') || '-'}`);
  });
  try {
    url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/api/telemetry') {
      if (req.method === 'POST') return await handleTelemetryPost(req, res);
      if (req.method === 'GET') return await handleTelemetryGet(req, res, url);
      throw new HttpError(405, 'Method not allowed');
    }
    if (url.pathname === '/api/sync') {
      if (req.method === 'POST') return await handleSync(req, res);
      throw new HttpError(405, 'Method not allowed');
    }
    if (url.pathname.startsWith('/api/admin/')) return await handleAdminApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    switch (url.pathname) {
      case '/admin':
      case '/admin/':
        return serveAdminPage(req, res);
      case '/api/health':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('ok');
      case '/api/config':
        return handleConfig(req, res);
      case '/api/manifest':
        return await handleManifest(req, res, url);
      case '/api/assets':
        return await handleAsset(req, res, url);
      default:
        throw new HttpError(404, 'Not found');
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(`[error] ${req.method} ${req.url}:`, err);
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(err.headers || {}) });
      res.end(JSON.stringify({ error: err.message }));
    } else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`pandatimer-updates listening on http://${HOST}:${port} updatesDir=${UPDATES_DIR} publicUrl=${PUBLIC_URL} signing=${fs.existsSync(PRIVATE_KEY_PATH) ? 'on' : 'OFF'} telemetry=${TELEMETRY_WRITE_KEY && TELEMETRY_READ_KEY ? TELEMETRY_DIR : 'OFF'} config=${currentConfig().source}:${currentConfig().body?.version}`);
  void pruneTelemetry(Date.now());
  // 資料庫：啟動就開一次（只印狀態，不印同步碼/密碼）；開不了 → /api/sync、/api/admin 回 503，其他端點照常
  getStore()
    .then((s) => {
      const c = s.stats();
      console.log(`[db] ${DB_PATH} ok orders=${c.orders} deleted=${c.deleted} admin=${adminConfigured() ? 'on' : 'OFF（ADMIN_PASSWORD 未設或太短）'}`);
      maybeBackup(s, Date.now());
    })
    .catch(() => undefined);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () =>
    server.close(() => {
      try { storeReady?.close(); } catch { /* 已關 */ }
      process.exit(0);
    }),
  );
}
