#!/usr/bin/env node
// 熊貓倒數 PandaTimer — 自架 expo-updates 伺服器（Expo Updates protocol v1，零依賴）
// 參考：https://docs.expo.dev/technical-specs/expo-updates-1/ 與 expo/custom-expo-updates-server
//
// 端點（nginx 把 https://wheat.yueshengift.xyz/pandatimer/ 轉到本服務根目錄）：
//   GET /api/manifest   header: expo-platform / expo-runtime-version / expo-protocol-version / expo-expect-signature
//   GET /api/assets?asset=<timestamp>/<相對路徑>&runtimeVersion=<rv>&platform=ios
//   GET /api/health     → "ok"
//
// 資料目錄：UPDATES_DIR/<runtimeVersion>/<timestamp>/ = `npx expo export -p ios` 的 dist + expoConfig.json
//   - 取數字最大的 timestamp；以 "." 開頭的目錄（上傳中）忽略
//   - 目錄內有 `rollback` 檔 → 回 rollBackToEmbedded directive（回到 App 內建版本）
//
// 環境變數：
//   HOST (127.0.0.1)  PORT (3970)  UPDATES_DIR (/opt/pandatimer-updates/updates)
//   PRIVATE_KEY_PATH (/opt/pandatimer-updates/keys/private-key.pem)
//   PUBLIC_URL (https://wheat.yueshengift.xyz/pandatimer)：manifest 內資產網址的前綴

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3970);
const UPDATES_DIR = path.resolve(process.env.UPDATES_DIR || '/opt/pandatimer-updates/updates');
const PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || '/opt/pandatimer-updates/keys/private-key.pem';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://wheat.yueshengift.xyz/pandatimer').replace(/\/+$/, '');
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

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  res.on('finish', () => {
    if (!url || url.pathname === '/api/health') return;
    console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms rv=${req.headers['expo-runtime-version'] || url.searchParams.get('runtimeVersion') || '-'}`);
  });
  try {
    url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    switch (url.pathname) {
      case '/api/health':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end('ok');
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
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: err.message }));
    } else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`pandatimer-updates listening on http://${HOST}:${PORT} updatesDir=${UPDATES_DIR} publicUrl=${PUBLIC_URL} signing=${fs.existsSync(PRIVATE_KEY_PATH) ? 'on' : 'OFF'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
