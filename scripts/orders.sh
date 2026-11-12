#!/usr/bin/env bash
# 熊貓倒數：查詢雲端訂單資料庫（唯讀 GET /api/admin/orders，不經 ssh，不能改資料）。
#
#   bash scripts/orders.sh                              # 最近 14 天（台北日期），一單一行＋每日小計
#   bash scripts/orders.sh --from 2026-11-09 --to 2026-11-22
#   bash scripts/orders.sh --period                     # 本期（14 天一期，錨點 2026-09-28）
#   選項：--deleted（含已刪除）、--raw（原始 JSON 一行一筆）、--csv（CSV，Excel 可開）、--baselines（列補登）
#
# 讀取金鑰：~/.config/pandatimer/telemetry-read-key（600，不進 repo；與 telemetry.sh 同一把）；經 600 暫存檔交給 curl，不出現在指令列。
# 環境變數覆寫：PANDATIMER_ADMIN_URL（預設 https://wheat.yueshengift.xyz/pandatimer/api/admin）、PANDATIMER_TELEMETRY_READ_KEY（金鑰檔路徑）
set -euo pipefail

URL="${PANDATIMER_ADMIN_URL:-https://wheat.yueshengift.xyz/pandatimer/api/admin}"
KEY_FILE="${PANDATIMER_TELEMETRY_READ_KEY:-$HOME/.config/pandatimer/telemetry-read-key}"
FROM=""
TO=""
MODE="pretty"
DELETED=0
PERIOD=0

while (($#)); do
  case "$1" in
    --from) FROM="${2:?--from 需要 YYYY-MM-DD}"; shift 2 ;;
    --to) TO="${2:?--to 需要 YYYY-MM-DD}"; shift 2 ;;
    --period) PERIOD=1; shift ;;
    --deleted) DELETED=1; shift ;;
    --raw) MODE="raw"; shift ;;
    --csv) MODE="csv"; shift ;;
    --baselines) MODE="baselines"; shift ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知參數：$1（bash scripts/orders.sh --help）" >&2; exit 2 ;;
  esac
done
for d in "$FROM" "$TO"; do
  [[ -z "$d" || "$d" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "日期格式要 YYYY-MM-DD：$d" >&2; exit 2; }
done
[[ -f "$KEY_FILE" ]] || { echo "找不到讀取金鑰 $KEY_FILE" >&2; exit 1; }
[[ "$(stat -c %a "$KEY_FILE")" == "600" ]] || { echo "讀取金鑰權限應為 600：$KEY_FILE" >&2; exit 1; }

if (( PERIOD )); then
  read -r FROM TO < <(node -e '
    const A = Date.UTC(2026, 8, 27, 16), S = 14 * 864e5, i = Math.floor((Date.now() - A) / S);
    const d = (ms) => new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
    console.log(d(A + i * S), d(A + (i + 1) * S - 864e5));')
fi

WORK="$(umask 077; mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
HF="$WORK/header"
( umask 077; printf 'x-pt-read: %s\n' "$(tr -d '\n' < "$KEY_FILE")" > "$HF" )

q=""
[[ -n "$FROM" ]] && q+="&from=$FROM"
[[ -n "$TO" ]] && q+="&to=$TO"
(( DELETED )) && q+="&deleted=1"
q="${q#&}"

get() { # $1 = 路徑?查詢 → 檔案 $WORK/body；HTTP 非 200 → 錯誤
  local code
  code="$(curl -sS --max-time 20 -H @"$HF" -o "$WORK/body" -w '%{http_code}' "$URL/$1" || echo 000)"
  if [[ "$code" != "200" ]]; then
    echo "❌ HTTP $code：$(head -c 300 "$WORK/body" 2>/dev/null || true)" >&2
    exit 1
  fi
}

case "$MODE" in
  csv) get "export.csv?$q"; cat "$WORK/body"; exit 0 ;;
  baselines) get "baselines"; node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const b of d.baselines) console.log(`${b.period}${b.deleted ? "（已刪）" : ""} ${b.orders} 單 準時 ${b.onTimePct}% 超時 ${b.overrunPct}%${b.income != null ? ` 收入 $${b.income}` : ""}`);
    if (!d.baselines.length) console.log("（沒有補登）");' < "$WORK/body"; exit 0 ;;
esac

get "orders?$q"
read -r -d '' PRETTY <<'JS' || true
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const raw = process.argv[1] === 'raw';
const T = 8 * 36e5, G = 1.05;
const p = (n) => String(n).padStart(2, '0');
const hm = (ms) => { const d = new Date(ms + T); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const day = (ms) => new Date(ms + T).toISOString().slice(0, 10);
const list = data.orders.slice().sort((a, b) => a.acceptedAt - b.acceptedAt);
if (raw) { for (const o of list) console.log(JSON.stringify(o)); process.exit(0); }
const days = new Map();
for (const o of list) { const k = day(o.acceptedAt); if (!days.has(k)) days.set(k, []); days.get(k).push(o); }
let N = 0, OK = 0, AMT = 0;
for (const [k, os] of days) {
  let n = 0, ok = 0, amt = 0;
  console.log(`── ${k}`);
  for (const o of os) {
    const act = o.deliveredAt != null ? Math.round((o.deliveredAt - o.acceptedAt) / 6e3) / 10 : null;
    const done = o.status === 'delivered' && act != null && !o.deleted;
    const good = done && act <= o.estimateMin * G + 1e-9;
    if (done) { n++; if (good) ok++; amt += o.amount ?? 0; }
    const tags = [o.stacked && '夾單', o.source !== 'manual' && o.source, o.status !== 'delivered' && o.status, o.deleted && '已刪', o.editedBy === 'admin' && '管理頁改'].filter(Boolean);
    console.log(`  ${hm(o.acceptedAt)}→${o.deliveredAt != null ? hm(o.deliveredAt) : '--:--'} 預估 ${String(o.estimateMin).padStart(3)} 實際 ${act == null ? '   -' : String(act).padStart(4)} ${done ? (good ? '準' : '超') : '  '} ${o.amount != null ? `$${o.amount}` : ''} ${tags.join(',')}${o.note ? ` 「${o.note}」` : ''}  ${o.id}`);
  }
  console.log(`  小計 ${n} 單 準時 ${n ? Math.round((ok / n) * 1000) / 10 : '-'}%${amt ? ` 金額 $${Math.round(amt * 100) / 100}` : ''}`);
  N += n; OK += ok; AMT += amt;
}
console.log(`合計 ${N} 單 準時 ${N ? Math.round((OK / N) * 1000) / 10 : '-'}%${AMT ? ` 金額 $${Math.round(AMT * 100) / 100}` : ''}（${day(data.from)}～${day(data.to - 1)}，準時＝實際≤預估×${G}）`);
JS
node -e "$PRETTY" "$MODE" < "$WORK/body"
