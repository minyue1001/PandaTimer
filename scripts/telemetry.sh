#!/usr/bin/env bash
# 熊貓倒數：查詢遠端狀態回報（v0.6 telemetry）。唯讀 GET，不經 ssh。
#
#   bash scripts/telemetry.sh                    # 今天（台北日期）最後 500 筆
#   bash scripts/telemetry.sh --since 10m        # 最近 10 分鐘（s/m/h/d，或 ISO 時間）
#   bash scripts/telemetry.sh 2026-11-12 --since 2h
#   bash scripts/telemetry.sh --since 5m --follow   # 每 5 秒追新資料（Ctrl+C 結束）
#   選項：--limit N（預設 500）、--raw（原始 JSON 一行一筆）、--interval 秒（follow 間隔，預設 5）
#
# 讀取金鑰：~/.config/pandatimer/telemetry-read-key（600，不進 repo）；經 600 暫存檔交給 curl，不出現在指令列。
# 環境變數覆寫：PANDATIMER_TELEMETRY_URL（預設 https://wheat.yueshengift.xyz/pandatimer/api/telemetry）、
#              PANDATIMER_TELEMETRY_READ_KEY（金鑰檔路徑）
set -euo pipefail

URL="${PANDATIMER_TELEMETRY_URL:-https://wheat.yueshengift.xyz/pandatimer/api/telemetry}"
KEY_FILE="${PANDATIMER_TELEMETRY_READ_KEY:-$HOME/.config/pandatimer/telemetry-read-key}"
DATE=""
SINCE=""
FOLLOW=0
LIMIT=500
RAW=0
INTERVAL=5

while (($#)); do
  case "$1" in
    --since) SINCE="${2:?--since 需要值，例如 10m}"; shift 2 ;;
    --follow|-f) FOLLOW=1; shift ;;
    --limit) LIMIT="${2:?--limit 需要數字}"; shift 2 ;;
    --raw) RAW=1; shift ;;
    --interval) INTERVAL="${2:?--interval 需要秒數}"; shift 2 ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) DATE="$1"; shift ;;
    *) echo "未知參數：$1（bash scripts/telemetry.sh --help）" >&2; exit 2 ;;
  esac
done
[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "--limit 要是數字" >&2; exit 2; }
[[ "$INTERVAL" =~ ^[0-9]+$ && "$INTERVAL" -ge 1 ]] || { echo "--interval 要是 ≥1 的整數" >&2; exit 2; }
[[ -f "$KEY_FILE" ]] || { echo "找不到讀取金鑰 $KEY_FILE" >&2; exit 1; }
[[ "$(stat -c %a "$KEY_FILE")" == "600" ]] || { echo "讀取金鑰權限應為 600：$KEY_FILE" >&2; exit 1; }

FIXED_DATE="$DATE"
today() { TZ=Asia/Taipei date +%F; }

# --since：10m / 2h / 30s / 1d → ISO；其他當成 ISO 原樣傳
since_iso() {
  local v="$1"
  if [[ "$v" =~ ^([0-9]+)([smhd])$ ]]; then
    local n="${BASH_REMATCH[1]}" unit
    case "${BASH_REMATCH[2]}" in s) unit=seconds ;; m) unit=minutes ;; h) unit=hours ;; d) unit=days ;; esac
    date -u -d "-$n $unit" +%Y-%m-%dT%H:%M:%S.000Z
  else
    date -u -d "$v" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || { echo "看不懂 --since $v" >&2; exit 2; }
  fi
}

WORK="$(umask 077; mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HF="$WORK/header"
( umask 077; printf 'x-pt-read: %s\n' "$(tr -d '\n' < "$KEY_FILE")" > "$HF" )

# 美化：一筆一行「時:分:秒 來源 事件 欄位=值…」（台北時間）；next 寫到 $1
read -r -d '' PRETTY <<'JS' || true
const fs = require('fs');
const [nextFile, raw] = process.argv.slice(1);
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
const fmt = new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const order = ['min', 'amt', 'km', 'seq', 'gap', 'result', 'wait', 'delay', 'hit', 'screen', 'accept', 'kw', 'island', 'islandErr', 'orders', 'others',
  'keep', 'auth', 'fg', 'susp', 'frames', 'ocr', 'skip', 'fails', 'errs', 'interval', 'triggers', 'dups', 'beatAge',
  'dMB', 'green', 'trig', 'stacked', 'locked', 'lockAge',
  'batt', 'charging', 'lowPower', 'thermal', 'saver', 'mode', 'awaySec', 'ocrMin', 'probes', 'cardSkip',
  'note', 'reason', 'code', 'cfg', 'ver', 'rv', 'upd', 'dev'];
for (const r of data.records || []) {
  if (raw === '1') { console.log(JSON.stringify(r)); continue; }
  const parts = [fmt.format(new Date(r.ts)), String(r.src || '?').padEnd(3), String(r.ev || '?').padEnd(11)];
  if (r.memMB != null || r.peakMB != null) parts.push(`mem=${Math.round(r.memMB ?? 0)}/${Math.round(r.peakMB ?? 0)}MB`);
  for (const k of order) {
    if (r[k] == null) continue;
    const v = Array.isArray(r[k]) ? r[k].join(',') : r[k];
    if (v === '') continue;
    parts.push(`${k}=${v}`);
  }
  console.log(parts.join(' '));
}
if (data.truncated) console.error(`（只顯示 ${data.count}／${data.total} 筆；加 --limit 或縮小 --since）`);
fs.writeFileSync(nextFile, data.next || '');
JS

fetch_once() { # $1 = since（可空）→ 印出；回傳碼非 0＝HTTP 錯誤
  local date="${FIXED_DATE:-$(today)}" q code body
  q="date=$date&limit=$LIMIT"
  [[ -n "$1" ]] && q+="&since=$(node -p 'encodeURIComponent(process.argv[1])' "$1")"
  body="$WORK/body.json"
  code="$(curl -sS --max-time 20 -H @"$HF" -o "$body" -w '%{http_code}' "$URL?$q" || echo 000)"
  if [[ "$code" != "200" ]]; then
    echo "❌ HTTP $code：$(head -c 300 "$body" 2>/dev/null || true)" >&2
    return 1
  fi
  node -e "$PRETTY" "$WORK/next" "$RAW" < "$body"
}

since=""
[[ -n "$SINCE" ]] && since="$(since_iso "$SINCE")"
fetch_once "$since"
(( FOLLOW )) || exit 0
next="$(cat "$WORK/next" 2>/dev/null || true)"
[[ -n "$next" ]] || next="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
echo "── 追蹤中（每 ${INTERVAL} 秒，Ctrl+C 結束）──" >&2
while true; do
  sleep "$INTERVAL"
  if fetch_once "$next"; then
    n="$(cat "$WORK/next" 2>/dev/null || true)"
    [[ -n "$n" ]] && next="$n"
  fi
done
