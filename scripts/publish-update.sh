#!/usr/bin/env bash
# 熊貓倒數：發佈 OTA 更新到自架 expo-updates 伺服器（wheat-new:/opt/pandatimer-updates）
#
#   bash scripts/publish-update.sh <runtimeVersion>                          匯出目前程式碼並發佈
#   bash scripts/publish-update.sh <runtimeVersion> --list                   列出伺服器上該 runtimeVersion 的版本
#   bash scripts/publish-update.sh <runtimeVersion> --republish <timestamp>  回滾：把舊版以新 timestamp 重新發佈
#   bash scripts/publish-update.sh <runtimeVersion> --rollback-embedded      回滾：讓 App 改回安裝包內建的 JS
#
# 發佈後會從本機 curl 公開網址驗證：manifest 簽章可用 server/certs/certificate.pem 驗過、
# id/createdAt 是剛發的那版、launchAsset 與每個 asset 的 sha256 一致。
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${PANDATIMER_REMOTE:-wheat-new}"
BASE="${PANDATIMER_BASE:-/opt/pandatimer-updates}"
PUBLIC_URL="${PANDATIMER_PUBLIC_URL:-https://wheat.yueshengift.xyz/pandatimer}"
CERT="$REPO/server/certs/certificate.pem"

usage() { sed -n '2,7p' "${BASH_SOURCE[0]}"; exit 2; }
die() { echo "❌ $*" >&2; exit 1; }

RV="${1:-}"; MODE="${2:---publish}"; ARG="${3:-}"
[[ -n "$RV" && "$RV" != -* ]] || usage
[[ "$RV" =~ ^[A-Za-z0-9._-]+$ ]] || die "runtimeVersion 只能含英數 . _ -：$RV"
case "$MODE" in
  --publish|--list|--rollback-embedded) ;;
  --republish) [[ "$ARG" =~ ^[0-9]+$ ]] || die "--republish 需要舊版的數字 timestamp（先用 --list 查）" ;;
  *) usage ;;
esac

TS="$(date +%s%3N)"
D="$BASE/updates/$RV"
SSH=(ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$REMOTE")
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- 驗證器（Node，零依賴）
cat > "$WORK/verify.mjs" <<'JS'
import crypto from 'node:crypto';
import fs from 'node:fs';
const [publicUrl, certPath, rv, ts, kind, expectedId] = process.argv.slice(2);
const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
const iso = new Date(Number(ts)).toISOString();
function parts(ct, text) {
  const b = /boundary=([^;]+)/.exec(ct)?.[1];
  if (!b) throw new Error('不是 multipart 回應：' + ct);
  const out = {};
  for (const seg of text.split(`--${b}`).slice(1)) {
    if (seg.startsWith('--')) break;
    const s = seg.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const i = s.indexOf('\r\n\r\n');
    const h = Object.fromEntries(s.slice(0, i).split('\r\n').map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
    out[/name="([^"]+)"/.exec(h['content-disposition'])[1]] = { h, body: s.slice(i + 4) };
  }
  return out;
}
function sigOk(p) {
  const hdr = p.h['expo-signature'] || '';
  const sig = /sig="([^"]+)"/.exec(hdr)?.[1];
  if (!sig || !/keyid="main"/.test(hdr)) return false;
  return crypto.createVerify('RSA-SHA256').update(p.body, 'utf8').verify(cert.publicKey, sig, 'base64');
}
const res = await fetch(`${publicUrl}/api/manifest`, { headers: {
  'expo-platform': 'ios', 'expo-runtime-version': rv, 'expo-protocol-version': '1',
  'expo-expect-signature': 'sig, keyid="main", alg="rsa-v1_5-sha256"', accept: 'multipart/mixed' } });
if (res.status !== 200) throw new Error(`manifest HTTP ${res.status}: ${await res.text()}`);
const p = parts(res.headers.get('content-type') || '', await res.text());
if (kind === 'rollback') {
  const d = JSON.parse(p.directive?.body || '{}');
  if (d.type !== 'rollBackToEmbedded' || d.parameters?.commitTime !== iso) throw new Error('directive 不符：' + JSON.stringify(d));
  if (!sigOk(p.directive)) throw new Error('directive 簽章驗證失敗');
  console.log(`• directive = rollBackToEmbedded（commitTime ${iso}），簽章 OK`);
  process.exit(0);
}
if (!p.manifest) throw new Error('回應沒有 manifest part：' + Object.keys(p).join(','));
if (!sigOk(p.manifest)) throw new Error('manifest 簽章驗證失敗（私鑰與 App 內憑證不成對？）');
const m = JSON.parse(p.manifest.body);
if (m.createdAt !== iso) throw new Error(`最新版 createdAt=${m.createdAt}，不是剛發的 ${iso}`);
if (expectedId && m.id !== expectedId) throw new Error(`id=${m.id}，預期 ${expectedId}`);
for (const a of [m.launchAsset, ...m.assets]) {
  const r = await fetch(a.url);
  const buf = Buffer.from(await r.arrayBuffer());
  const h = crypto.createHash('sha256').update(buf).digest('base64url');
  if (r.status !== 200 || h !== a.hash) throw new Error(`asset 驗證失敗 ${a.url}（HTTP ${r.status}）`);
}
console.log(`• manifest 簽章 OK；id=${m.id}；createdAt=${m.createdAt}；launchAsset＋${m.assets.length} 個 asset 的 sha256 全部一致`);
JS

verify() { # $1 = update|rollback  $2 = expectedId(可空)
  local i
  for i in 1 2 3; do
    if node "$WORK/verify.mjs" "$PUBLIC_URL" "$CERT" "$RV" "$TS" "$1" "${2:-}"; then return 0; fi
    sleep 2
  done
  return 1
}

# ---------------------------------------------------------------- --list
if [[ "$MODE" == "--list" ]]; then
  "${SSH[@]}" "set -euo pipefail; [[ -d $D ]] || { echo '（$D 不存在：尚未發佈過）'; exit 0; }; cd $D && for t in \$(ls -1 | grep -E '^[0-9]+\$' | sort -n); do if [[ -f \$t/rollback ]]; then k='rollBackToEmbedded'; else k=\"\$(du -sh \$t | cut -f1)\"; fi; echo \"\$t \$(date -u -d @\${t:0:10} '+%F %T') UTC  \$k\"; done | tail -n 20"
  echo "（最後一行＝目前生效的版本）"
  exit 0
fi

# ---------------------------------------------------------------- --rollback-embedded
if [[ "$MODE" == "--rollback-embedded" ]]; then
  echo "== 建立 rollBackToEmbedded 指令（$RV/$TS）"
  "${SSH[@]}" "set -euo pipefail; [[ -d $D ]] || { echo '❌ $D 不存在' >&2; exit 1; }; mkdir $D/.$TS; touch $D/.$TS/rollback; chown -R pandatimer:pandatimer $D/.$TS; mv $D/.$TS $D/$TS"
  verify rollback || die "驗證失敗（伺服器上 $D/$TS 已建立，可用 --list 檢查）"
  echo "✅ 已發佈回滾指令：App 下次檢查更新會改回安裝包內建的 JS"
  exit 0
fi

# ---------------------------------------------------------------- --republish
if [[ "$MODE" == "--republish" ]]; then
  echo "== 以新 timestamp $TS 重新發佈舊版 $ARG"
  "${SSH[@]}" "set -euo pipefail; [[ -f $D/$ARG/metadata.json ]] || { echo '❌ 找不到 $D/$ARG/metadata.json' >&2; exit 1; }; rm -rf $D/.$TS; cp -a $D/$ARG $D/.$TS; rm -f $D/.$TS/rollback; chown -R pandatimer:pandatimer $D/.$TS; mv $D/.$TS $D/$TS"
  verify update || die "驗證失敗（伺服器上 $D/$TS 已建立，可用 --list 檢查）"
  echo "✅ 已重新發佈舊版 $ARG（新版號 $TS）"
  exit 0
fi

# ---------------------------------------------------------------- --publish
cd "$REPO"
[[ -f "$CERT" ]] || die "缺 $CERT"
echo "== 1/4 讀取 App 設定"
npx expo config --json --type public > "$WORK/expoConfig.json"
node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const [rv, url] = process.argv.slice(2);
const cfg = c.ios?.runtimeVersion ?? c.runtimeVersion;
if (typeof cfg === "string" && cfg !== rv) { console.error(`❌ App 的 runtimeVersion 是 "${cfg}"，但你要發佈到 "${rv}"——裝著 ${cfg} 的 App 收不到，停止。`); process.exit(1); }
if (cfg === undefined) console.warn("⚠️  app 設定沒有 runtimeVersion（App 端還沒整合 expo-updates？）——照常上傳，但請確認 App 的 runtimeVersion 會是 " + rv);
else if (typeof cfg !== "string") console.warn("⚠️  runtimeVersion 是 policy 物件 " + JSON.stringify(cfg) + "，請自行確認算出來等於 " + rv);
if (c.updates?.url && c.updates.url !== url) console.warn(`⚠️  updates.url=${c.updates.url}，與 ${url} 不同`);
' "$WORK/expoConfig.json" "$RV" "$PUBLIC_URL/api/manifest"
[[ -d "$REPO/node_modules/expo-updates" ]] || echo "⚠️  node_modules 沒有 expo-updates：App 端尚未安裝，裝著的 App 不會來拿更新"

echo "== 2/4 匯出 iOS bundle"
npx expo export -p ios --output-dir "$WORK/$TS"
cp "$WORK/expoConfig.json" "$WORK/$TS/expoConfig.json"
EXPECTED_ID="$(node -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const [dir, rv, ts] = process.argv.slice(1);
const buf = fs.readFileSync(path.join(dir, "metadata.json"));
const m = JSON.parse(buf);
const b = m.fileMetadata?.ios?.bundle;
if (!b || !fs.existsSync(path.join(dir, b))) { console.error("metadata.json 沒有 iOS bundle"); process.exit(1); }
const h = crypto.createHash("sha256").update(buf).update("\0").update(rv).update("\0").update(ts).digest("hex");
console.log(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`);
' "$WORK/$TS" "$RV" "$TS")"
echo "• 版本 $RV/$TS，預期 update id $EXPECTED_ID，大小 $(du -sh "$WORK/$TS" | cut -f1)"

echo "== 3/4 上傳到 $REMOTE:$D/$TS"
tar -C "$WORK" --owner=0 --group=0 -czf - "$TS" \
  | "${SSH[@]}" "set -euo pipefail; [[ -d $BASE/updates ]] || { echo '❌ $BASE/updates 不存在：先跑 scripts/deploy-updates-server.sh' >&2; exit 1; }; install -d -m 755 $D; rm -rf $D/.$TS; mkdir $D/.$TS; tar -xzf - -C $D/.$TS --strip-components=1 --no-same-owner; chown -R pandatimer:pandatimer $D/.$TS; chown pandatimer:pandatimer $D; mv $D/.$TS $D/$TS"

echo "== 4/4 從公開網址驗證"
verify update "$EXPECTED_ID" || die "驗證失敗（伺服器上 $D/$TS 已上傳；可用 --list 檢查、或刪掉該目錄）"
echo "✅ 發佈成功：$RV/$TS（id $EXPECTED_ID）"
