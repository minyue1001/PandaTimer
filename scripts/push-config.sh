#!/usr/bin/env bash
# 熊貓倒數：推遠端設定（v0.6）。調偵測參數（接單鈕/分鐘/金額正則、費率、去重秒數、OCR 間隔、裁切、回報關鍵字…）
# 不用重裝 App：改 server/config.json（記得改 "version"）→ 跑這支 → App 下次開始偵測/回前景、extension 下次開始廣播或
# 每 10 分鐘（detector.configRefreshSeconds）自動套用。
#
#   bash scripts/push-config.sh             # 驗證 → 上傳 → 驗證線上 version
#   bash scripts/push-config.sh --dry-run   # 只做本機驗證＋讀線上目前 version（不改遠端）
#   bash scripts/push-config.sh --force     # version 與線上相同也推
#
# 會做：本機嚴格驗證（src/remoteConfig.ts 的 validateConfig：任何欄位不合法就停）→ ssh 上傳到
#   $BASE/config.json.new → 遠端 python3 驗 JSON → 舊檔留成 config.json.prev → 換上 → curl 公開網址確認 version；
#   線上 version 不對 → 自動換回 config.json.prev。
# 環境變數：PANDATIMER_REMOTE（預設 wheat-new）、PANDATIMER_BASE（預設 /opt/pandatimer-updates）、PANDATIMER_CONFIG（預設 server/config.json）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${PANDATIMER_REMOTE:-wheat-new}"
BASE="${PANDATIMER_BASE:-/opt/pandatimer-updates}"
FILE="${PANDATIMER_CONFIG:-$REPO/server/config.json}"
PUBLIC="https://wheat.yueshengift.xyz/pandatimer/api/config"
DRY=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知參數：$a" >&2; exit 2 ;;
  esac
done

# 本機嚴格驗證：任何欄位缺漏/不合法就停（App 端會默默改用預設，推之前要先知道）
read -r -d '' VALIDATE_JS <<'JS' || true
import fs from "node:fs";
const { validateConfig } = await import("./src/remoteConfig.ts");
let raw;
try { raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { console.error("❌ 不是合法 JSON：" + e.message); process.exit(1); }
const { config, problems } = validateConfig(raw);
if (problems.length) { console.error("❌ 設定有問題（App 會對這些欄位改用預設）：\n  - " + problems.join("\n  - ")); process.exit(1); }
process.stdout.write(config.version);
JS

echo "== 1/3 本機驗證 $FILE"
[[ -f "$FILE" ]] || { echo "❌ 找不到 $FILE" >&2; exit 1; }
VERSION="$(cd "$REPO" && node --no-warnings --input-type=module -e "$VALIDATE_JS" "$FILE")" || exit 1
[[ -n "$VERSION" ]] || { echo "❌ 驗證失敗（沒有 version）" >&2; exit 1; }
echo "• 驗證通過，version=$VERSION"

ONLINE="$(curl -s --max-time 15 "$PUBLIC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version??""))}catch{}})' || true)"
echo "• 線上目前 version：${ONLINE:-（讀不到）}"
if [[ "$ONLINE" == "$VERSION" && $FORCE -eq 0 ]]; then
  echo "❌ version 與線上相同——改了內容請一併改 \"version\"（追蹤用），或加 --force" >&2
  exit 1
fi
if (( DRY )); then
  echo "✅ dry-run 完成（未改動遠端）"
  exit 0
fi

SSH=(ssh -T -o BatchMode=yes -o ConnectTimeout=15 "$REMOTE")
echo "== 2/3 上傳到 $REMOTE:$BASE/config.json"
"${SSH[@]}" "set -euo pipefail; umask 022; cat > $BASE/config.json.new" < "$FILE"
"${SSH[@]}" "set -euo pipefail
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d, dict) and isinstance(d.get(\"version\"), str)' $BASE/config.json.new
  if [ -f $BASE/config.json ]; then cp -a $BASE/config.json $BASE/config.json.prev; fi
  chown root:root $BASE/config.json.new; chmod 644 $BASE/config.json.new
  mv -f $BASE/config.json.new $BASE/config.json
  echo '• 已換上（舊檔在 config.json.prev）'"

echo "== 3/3 驗證線上 version"
got=""
for i in 1 2 3 4 5; do
  got="$(curl -s --max-time 15 -H 'cache-control: no-cache' "$PUBLIC" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version??""))}catch{}})' || true)"
  [[ "$got" == "$VERSION" ]] && break
  sleep 2
done
if [[ "$got" != "$VERSION" ]]; then
  echo "❌ 線上 version='$got'，預期 '$VERSION' → 換回 config.json.prev" >&2
  "${SSH[@]}" "set -e; if [ -f $BASE/config.json.prev ]; then cp -a $BASE/config.json.prev $BASE/config.json; echo '• 已換回'; fi"
  exit 1
fi
echo "✅ 已上線：$PUBLIC version=$VERSION（App/extension 會在下次開始偵測、回前景或 10 分鐘內套用）"
