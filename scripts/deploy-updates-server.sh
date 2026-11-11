#!/usr/bin/env bash
# 熊貓倒數：部署自架 expo-updates 伺服器到 wheat-new（可重複跑、冪等）
#
#   bash scripts/deploy-updates-server.sh --dry-run   # 只做遠端唯讀檢查＋印出將執行的動作與 nginx 預計 diff
#   bash scripts/deploy-updates-server.sh             # 正式部署
#
# 會做：上傳 server/ 與私鑰到 /opt/pandatimer-updates → 系統帳號 pandatimer → systemd pandatimer-updates
#       → v0.6：兩把回報金鑰（本機 ~/.config/pandatimer/telemetry-{write,read}-key）寫成遠端 server.env（600），
#         systemd 用 EnvironmentFile 讀；回報資料寫 /opt/pandatimer-updates/telemetry（ReadWritePaths）
#       → nginx 在 listen 443 的 wheat.yueshengift.xyz server 區塊插入 location ^~ /pandatimer/
#       → 驗證既有站台狀態碼不變、服務都 active、/api/telemetry 金鑰錯回 401／讀取金鑰回 200；
#         任一失敗自動回滾（還原 nginx；重跑時換回上一版程式＋server.env＋unit 並重啟，首次部署則停用服務）。
# 可用環境變數覆寫：PANDATIMER_REMOTE（預設 wheat-new）、REMOTE_NODE_BIN（遠端 node 絕對路徑）、PANDATIMER_KEY、
#   PANDATIMER_TELEMETRY_WRITE_KEY / PANDATIMER_TELEMETRY_READ_KEY（金鑰檔路徑）
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE="${PANDATIMER_REMOTE:-wheat-new}"
DOMAIN="wheat.yueshengift.xyz"
SITE_NAME="wheat.yueshengift.xyz"
BASE="${PANDATIMER_BASE:-/opt/pandatimer-updates}"
PORT="${PANDATIMER_PORT:-3970}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"   # 以上三個覆寫僅供本機模擬測試
SVC="pandatimer-updates"
PUBLIC_URL="https://${DOMAIN}/pandatimer"
NGINX_ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled/${SITE_NAME}}"
BACKUP_DIR="${BACKUP_DIR:-/root/nginx-backup}"
LOCAL_KEY="${PANDATIMER_KEY:-$HOME/.config/pandatimer/keys/private-key.pem}"
WRITE_KEY_FILE="${PANDATIMER_TELEMETRY_WRITE_KEY:-$HOME/.config/pandatimer/telemetry-write-key}"
READ_KEY_FILE="${PANDATIMER_TELEMETRY_READ_KEY:-$HOME/.config/pandatimer/telemetry-read-key}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-}"
TS="$(date +%Y%m%d-%H%M%S)"

DRY_RUN=0
PRINT_LIB=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --print-remote-lib) PRINT_LIB=1 ;;   # 除錯用：印出送到遠端執行的腳本
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知參數：$a" >&2; exit 2 ;;
  esac
done

WORK="$(mktemp -d)"
REMOTE_LIB="$WORK/remote-lib.sh"
PRE_OUT="$WORK/pre.out"
ENV_FILE="$WORK/server.env"
POST_OUT="$WORK/post.out"

# ---------------------------------------------------------------- 遠端腳本（單引號 heredoc：本機零展開）
{
  printf 'DOMAIN=%q\nSITE_NAME=%q\nBASE=%q\nPORT=%q\nSVC=%q\nPUBLIC_URL=%q\nNGINX_ENABLED=%q\nBACKUP_DIR=%q\nREMOTE_NODE_BIN=%q\nSYSTEMD_DIR=%q\n' \
    "$DOMAIN" "$SITE_NAME" "$BASE" "$PORT" "$SVC" "$PUBLIC_URL" "$NGINX_ENABLED" "$BACKUP_DIR" "$REMOTE_NODE_BIN" "$SYSTEMD_DIR"
  cat <<'REMOTE_EOF'
set -euo pipefail
CMD="${1:-}"; shift || true
say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

resolve_node() {
  local bin="${REMOTE_NODE_BIN:-}"
  [[ -n "$bin" ]] || bin="$(command -v node 2>/dev/null || true)"
  [[ -n "$bin" && -x "$bin" ]] || die "遠端找不到 node。請先安裝 Node ≥18（系統層，例如 /usr/bin/node），或以 REMOTE_NODE_BIN=/絕對路徑 重跑。本腳本不自動安裝。"
  NODE_BIN="$(readlink -f "$bin")"
  case "$NODE_BIN" in
    /root/*|/home/*) die "node 位於 $NODE_BIN（家目錄內），系統帳號 pandatimer 無法執行。請安裝系統層 node，或以 REMOTE_NODE_BIN 指定 /usr 下的 node。" ;;
  esac
  NODE_VER="$("$NODE_BIN" -v </dev/null)"
  local major="${NODE_VER#v}"; major="${major%%.*}"
  (( major >= 18 )) || die "遠端 node $NODE_VER < 18，請先升級（本腳本不自動安裝）。"
}

nginx_real() {
  [[ -e "$NGINX_ENABLED" ]] || die "找不到 $NGINX_ENABLED"
  NGINX_REAL="$(readlink -f "$NGINX_ENABLED")"
}

http_codes() {
  local p
  for p in / /wheat/ /wheat/admin/; do
    printf '@@code %s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN$p" </dev/null || true)"
  done
}

svc_states() {
  local s
  for s in nginx wheat-server@a wheat-tw-tunnel "$SVC"; do
    printf '@@svc %s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || true)"
  done
}

# python3 精準插入 location：找「listen 443 且 server_name 含網域」的唯一 server 區塊，插在它的結尾 } 之前
nginx_py() { # $1 = check|apply  $2 = 檔案
  python3 - "$1" "$2" "$DOMAIN" "$PORT" <<'PY'
import re, sys, difflib
mode, path, domain, port = sys.argv[1:5]
with open(path, encoding='utf-8') as f:
    src = f.read()

def strip_comments(s):
    out, i, n, q = [], 0, len(s), None
    while i < n:
        c = s[i]
        if q:
            out.append(c)
            if c == '\\' and i + 1 < n:
                out.append(s[i + 1]); i += 2; continue
            if c == q: q = None
            i += 1; continue
        if c in '"\'':
            q = c; out.append(c); i += 1; continue
        if c == '#':
            j = s.find('\n', i); i = n if j < 0 else j; continue
        out.append(c); i += 1
    return ''.join(out)

if re.search(r'location\s+\^~\s+/pandatimer/', strip_comments(src)):
    print('@@nginx already'); sys.exit(0)

stack, buf, blocks, i, n, q = [], [], [], 0, len(src), None
while i < n:
    c = src[i]
    if q:
        if c == '\\': i += 2; continue
        if c == q: q = None
        i += 1; continue
    if c in '"\'':
        q = c; buf.append(' x '); i += 1; continue
    if c == '#':
        j = src.find('\n', i); i = n if j < 0 else j; continue
    if c == ';':
        buf = []
    elif c == '{':
        head = ''.join(buf).split()
        stack.append((head[0] if head else '', i)); buf = []
    elif c == '}':
        if not stack: sys.exit('nginx 設定大括號不平衡，放棄')
        name, start = stack.pop(); buf = []
        if name == 'server': blocks.append((start, i))
    else:
        buf.append(c)
    i += 1
if stack or q: sys.exit('nginx 設定大括號/引號不平衡，放棄')

dom = re.escape(domain)
cands = []
for start, end in blocks:
    body = strip_comments(src[start + 1:end])
    if re.search(r'(^|[\s;{])listen\s+(\S+:)?443(\s|;)', body) and \
       re.search(r'server_name\s[^;]*(?<![\w.-])' + dom + r'(?![\w.-])', body):
        cands.append((start, end))
if len(cands) != 1:
    print(f'• nginx：符合「listen 443 + server_name {domain}」的 server 區塊有 {len(cands)} 個（全檔 server 區塊 {len(blocks)} 個），需要剛好 1 個')
    sys.exit(3)

start, end = cands[0]
m = re.search(r'^([ \t]*)listen\b', src[start + 1:end], re.M)
ind = m.group(1) if m and m.group(1) else '    '
inner = ind + ('\t' if '\t' in ind else '    ')
ls = src.rfind('\n', 0, end)
if src[ls + 1:end].strip() == '':
    pos, prefix = ls + 1, ''
else:
    pos, prefix = end, '\n'
snippet = (prefix + '\n'
    + f'{ind}# PandaTimer expo-updates（由 PandaTimer/scripts/deploy-updates-server.sh 加入）\n'
    + f'{ind}location ^~ /pandatimer/ {{\n'
    + f'{inner}proxy_pass http://127.0.0.1:{port}/;\n'
    + f'{inner}proxy_set_header Host $host;\n'
    + f'{inner}proxy_set_header X-Forwarded-Proto $scheme;\n'
    + f'{ind}}}\n')
new = src[:pos] + snippet + src[pos:]
if mode == 'check':
    sys.stdout.writelines(difflib.unified_diff(src.splitlines(True), new.splitlines(True), path, path + '（預計）'))
    print('@@nginx planned')
elif mode == 'apply':
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new)
    print('@@nginx applied')
else:
    sys.exit('bad mode')
PY
}

cmd_preflight() {
  say "• 遠端主機：$(hostname) / $(uname -sr)"
  local c
  for c in curl python3 nginx systemctl ss tar useradd; do
    command -v "$c" >/dev/null 2>&1 || die "遠端缺少指令 $c"
  done
  resolve_node
  say "• node：$NODE_BIN（$NODE_VER）"
  local lines mpid
  lines="$(ss -Hltnp "sport = :$PORT" 2>/dev/null || true)"
  if [[ -n "$lines" ]]; then
    mpid="$(systemctl show -p MainPID --value "$SVC" 2>/dev/null || echo 0)"
    if [[ "$mpid" != "0" && "$lines" == *"pid=$mpid,"* ]]; then
      say "• 埠 $PORT：已由 $SVC 使用（重跑，OK）"
    else
      die "埠 $PORT 已被其他程式占用：$lines"
    fi
  else
    say "• 埠 $PORT：空閒"
  fi
  for c in nginx wheat-server@a; do
    systemctl is-active --quiet "$c" || die "$c 目前不是 active——現況就不健康，請先處理再部署"
  done
  svc_states
  nginx_real
  say "• nginx 站台實體檔：$NGINX_REAL（$NGINX_ENABLED 是$([[ -L "$NGINX_ENABLED" ]] && echo ' symlink' || echo '一般檔')）"
  nginx -t >/dev/null 2>&1 || die "目前的 nginx 設定 nginx -t 就不通過，請先處理"
  say "• 目前 nginx -t：通過"
  nginx_py check "$NGINX_REAL" || die "找不到唯一一個「listen 443 + server_name $DOMAIN」的 server 區塊，不自動改 nginx"
  if [[ -d "$BASE" ]]; then say "• $BASE 已存在（重跑）：$(ls -1 "$BASE" | tr '\n' ' ')"; else say "• $BASE 尚不存在（首次部署）"; fi
  http_codes
}

cmd_install() {
  local ts="${1:-manual}"
  resolve_node
  if ! id -u pandatimer >/dev/null 2>&1; then
    useradd --system --no-create-home --home-dir "$BASE" --shell /usr/sbin/nologin pandatimer
    say "• 已建立系統帳號 pandatimer"
  else
    say "• 系統帳號 pandatimer 已存在"
  fi
  install -d -m 755 -o root -g root "$BASE"
  install -d -m 755 -o pandatimer -g pandatimer "$BASE/updates"
  install -d -m 700 -o pandatimer -g pandatimer "$BASE/keys"
  install -d -m 750 -o pandatimer -g pandatimer "$BASE/telemetry"
  [[ -f "$BASE/server.incoming/index.mjs" ]] || die "找不到剛上傳的 $BASE/server.incoming/index.mjs"
  [[ -s "$BASE/server.env.new" ]] || die "找不到剛上傳的 $BASE/server.env.new"
  grep -q '^TELEMETRY_WRITE_KEY=..*' "$BASE/server.env.new" && grep -q '^TELEMETRY_READ_KEY=..*' "$BASE/server.env.new" \
    || die "server.env.new 缺 TELEMETRY_WRITE_KEY / TELEMETRY_READ_KEY"
  "$NODE_BIN" --check "$BASE/server.incoming/index.mjs"
  # 換版前留一份「上一版」（程式、server.env、unit），回滾時換回來；.last-swap 記這次部署的時間戳
  if [[ -d "$BASE/server" ]]; then rm -rf "$BASE/server.prev"; mv "$BASE/server" "$BASE/server.prev"; fi
  rm -f "$BASE/server.env.prev" "$BASE/unit.prev"
  if [[ -f "$BASE/server.env" ]]; then cp -a "$BASE/server.env" "$BASE/server.env.prev"; fi
  if [[ -f "$SYSTEMD_DIR/$SVC.service" ]]; then cp -a "$SYSTEMD_DIR/$SVC.service" "$BASE/unit.prev"; fi
  printf '%s\n' "$ts" > "$BASE/.last-swap"
  mv "$BASE/server.incoming" "$BASE/server"
  mv -f "$BASE/server.env.new" "$BASE/server.env"
  chown root:root "$BASE/server.env"
  chmod 600 "$BASE/server.env"
  chown -R root:root "$BASE/server"
  chmod -R u=rwX,go=rX "$BASE/server"
  if [[ -s "$BASE/keys/private-key.pem.new" ]]; then mv -f "$BASE/keys/private-key.pem.new" "$BASE/keys/private-key.pem"; fi
  [[ -s "$BASE/keys/private-key.pem" ]] || die "私鑰 $BASE/keys/private-key.pem 不存在"
  chown pandatimer:pandatimer "$BASE/keys/private-key.pem"
  chmod 600 "$BASE/keys/private-key.pem"
  say "• 程式已放到 $BASE/server，私鑰 $(stat -c '%a %U' "$BASE/keys/private-key.pem")，server.env $(stat -c '%a %U' "$BASE/server.env")"

  local unit="$SYSTEMD_DIR/$SVC.service" tmp
  tmp="$(mktemp)"
  cat > "$tmp" <<UNIT
[Unit]
Description=PandaTimer expo-updates server
After=network.target

[Service]
Type=simple
User=pandatimer
Group=pandatimer
Environment=HOST=127.0.0.1
Environment=PORT=$PORT
Environment=UPDATES_DIR=$BASE/updates
Environment=PRIVATE_KEY_PATH=$BASE/keys/private-key.pem
Environment=PUBLIC_URL=$PUBLIC_URL
Environment=TELEMETRY_DIR=$BASE/telemetry
EnvironmentFile=$BASE/server.env
ExecStart=$NODE_BIN $BASE/server/index.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$BASE/telemetry

[Install]
WantedBy=multi-user.target
UNIT
  if ! cmp -s "$tmp" "$unit"; then
    install -m 644 "$tmp" "$unit"
    systemctl daemon-reload
    say "• 已寫入 $unit"
  else
    say "• $unit 無變更"
  fi
  rm -f "$tmp"
  systemctl enable "$SVC" >/dev/null 2>&1
  systemctl restart "$SVC"
  local i ok=0
  for i in $(seq 1 20); do
    if [[ "$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/health" </dev/null || true)" == "ok" ]]; then ok=1; break; fi
    sleep 0.5
  done
  if (( ok == 0 )); then
    journalctl -u "$SVC" -n 30 --no-pager 2>&1 || true
    die "$SVC 起不來（127.0.0.1:$PORT/api/health 無回應）"
  fi
  say "• $SVC 已啟動，127.0.0.1:$PORT/api/health = ok"
  local bind
  bind="$(ss -Hltn "sport = :$PORT" | awk '{print $4}' | sort -u | tr '\n' ' ')"
  [[ "$bind" == "127.0.0.1:$PORT " ]] || die "綁定位址不對：$bind（應只有 127.0.0.1:$PORT）"
  say "• 綁定位址：$bind"
  local tc
  tc="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'x-pt-key: deploy-check-wrong-key' \
    -H 'content-type: application/json' --data '{"ev":"deploy-check"}' "http://127.0.0.1:$PORT/api/telemetry" </dev/null || true)"
  [[ "$tc" == "401" ]] || die "127.0.0.1:$PORT/api/telemetry 金鑰錯應回 401，實際 $tc（server.env 沒被讀到？）"
  say "• /api/telemetry 已啟用（錯誤金鑰 → 401）"
}

# 回滾用：這次部署（.last-swap == $1）換過版 → 換回上一版程式／server.env／unit 並重啟；健康就印 @@restored ok
cmd_restore_prev() {
  local ts="$1" i ok=0
  if [[ "$(cat "$BASE/.last-swap" 2>/dev/null || true)" != "$ts" || ! -d "$BASE/server.prev" ]]; then
    say "• 這次沒有換過版（或沒有上一版），無法換回"
    return 0
  fi
  rm -rf "$BASE/server.failed"; mv "$BASE/server" "$BASE/server.failed"; mv "$BASE/server.prev" "$BASE/server"
  if [[ -f "$BASE/server.env.prev" ]]; then mv -f "$BASE/server.env.prev" "$BASE/server.env"; fi
  if [[ -f "$BASE/unit.prev" ]]; then install -m 644 "$BASE/unit.prev" "$SYSTEMD_DIR/$SVC.service"; rm -f "$BASE/unit.prev"; fi
  rm -f "$BASE/.last-swap"
  systemctl daemon-reload
  systemctl restart "$SVC" || true
  for i in $(seq 1 20); do
    if [[ "$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/health" </dev/null || true)" == "ok" ]]; then ok=1; break; fi
    sleep 0.5
  done
  if (( ok )); then say "• 已換回上一版並重啟（失敗的版本留在 $BASE/server.failed）"; say "@@restored ok"; else say "• 換回上一版後仍起不來"; fi
}

cmd_nginx_apply() {
  local ts="$1" bk out
  nginx_real
  if grep -Eq '^[[:space:]]*location[[:space:]]+\^~[[:space:]]+/pandatimer/' "$NGINX_REAL"; then
    say "• nginx 已含 location ^~ /pandatimer/，不改動"
    return 0
  fi
  install -d -m 700 "$BACKUP_DIR"
  bk="$BACKUP_DIR/$SITE_NAME.$ts"
  cp -a "$NGINX_REAL" "$bk"
  say "• 已備份 $NGINX_REAL → $bk"
  nginx_py apply "$NGINX_REAL" || { cat "$bk" > "$NGINX_REAL"; die "插入 location 失敗，已還原"; }
  say "• diff："
  diff -u "$bk" "$NGINX_REAL" || true
  if ! out="$(nginx -t 2>&1)"; then
    cat "$bk" > "$NGINX_REAL"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
    printf '%s\n' "$out" >&2
    die "nginx -t 失敗，已還原備份並 reload"
  fi
  systemctl reload nginx
  say "• nginx -t 通過，已 reload"
}

cmd_nginx_restore() {
  local ts="$1" bk
  nginx_real
  bk="$BACKUP_DIR/$SITE_NAME.$ts"
  if [[ ! -f "$bk" ]]; then say "• 本次沒有改 nginx（無 $bk），略過還原"; return 0; fi
  if cmp -s "$bk" "$NGINX_REAL"; then say "• nginx 已與備份一致"; return 0; fi
  cat "$bk" > "$NGINX_REAL"
  nginx -t && systemctl reload nginx
  say "• 已還原 nginx ← $bk 並 reload"
}

cmd_service_disable() {
  systemctl disable --now "$SVC" 2>&1 || true
  say "• 已停用 $SVC（程式與資料仍在 $BASE$([[ -d "$BASE/server.prev" ]] && echo "；上一版程式在 $BASE/server.prev，可手動換回後 systemctl enable --now $SVC")）"
}

cmd_verify() {
  sleep 2
  http_codes
  svc_states
  printf '@@health %s\n' "$(curl -s --max-time 15 "https://$DOMAIN/pandatimer/api/health" </dev/null || true)"
  local m
  m="$(curl -s --max-time 15 -H 'expo-platform: ios' -H 'expo-runtime-version: deploy-check' -H 'expo-protocol-version: 1' "https://$DOMAIN/pandatimer/api/manifest" </dev/null || true)"
  if [[ "$m" == *'"noUpdateAvailable"'* ]]; then say '@@manifest ok'; else say '@@manifest bad'; fi
  # v0.6 回報端點（經 nginx）：錯誤寫入金鑰 → 401；讀取金鑰（從 server.env 讀，經 600 暫存檔給 curl，不進指令列）→ 200
  printf '@@tele_bad %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H 'x-pt-key: deploy-check-wrong-key' \
    -H 'content-type: application/json' --data '{"ev":"deploy-check"}' "https://$DOMAIN/pandatimer/api/telemetry" </dev/null || true)"
  local hf
  hf="$(umask 077; mktemp)"
  printf 'x-pt-read: %s\n' "$(sed -n 's/^TELEMETRY_READ_KEY=//p' "$BASE/server.env" | head -1)" > "$hf"
  printf '@@tele_read %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -H @"$hf" "https://$DOMAIN/pandatimer/api/telemetry?limit=1" </dev/null || true)"
  rm -f "$hf"
}

case "$CMD" in
  preflight) cmd_preflight ;;
  install) cmd_install "${1:-manual}" ;;
  restore-prev) cmd_restore_prev "$1" ;;
  nginx-apply) cmd_nginx_apply "$1" ;;
  nginx-restore) cmd_nginx_restore "$1" ;;
  nginx-plan) nginx_real; nginx_py check "$NGINX_REAL" ;;
  service-disable) cmd_service_disable ;;
  verify) cmd_verify ;;
  *) die "未知遠端指令：$CMD" ;;
esac
REMOTE_EOF
} > "$REMOTE_LIB"

if (( PRINT_LIB )); then cat "$REMOTE_LIB"; rm -rf "$WORK"; exit 0; fi

SSH=(ssh -T -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 "$REMOTE")
remote() { "${SSH[@]}" bash -s -- "$@" < "$REMOTE_LIB"; }
show() { awk '!/^@@[a-z]/'; }   # 隱藏 @@key 機器輸出（保留 diff 的 @@ -x,y 行）
field() { awk -v k="$2" -v p="$3" '$1==k && $2==p {print $3}' "$1"; }
fail() { echo "❌ $*" >&2; exit 1; }

STAGE="preflight"
rollback() {
  set +e
  echo ""
  echo "↩️  回滾中（失敗階段：$STAGE）…"
  remote nginx-restore "$TS"
  # 重跑部署（遠端已有上一版）→ 換回上一版並重啟，OTA 不中斷；首次部署或換回失敗 → 停用服務（同舊行為）
  if remote restore-prev "$TS" | tee "$WORK/restore.out" | show && grep -q '^@@restored ok' "$WORK/restore.out"; then
    echo "• 已換回上一版，$SVC 繼續服務"
  else
    remote service-disable
  fi
}
on_exit() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    case "$STAGE" in
      preflight) echo "❌ 前置檢查未通過，沒有改動遠端任何東西。" ;;
      upload) echo "❌ 上傳失敗，線上服務與 nginx 未改動（暫存檔在 $BASE/server.incoming）。" ;;
      *) rollback; echo "❌ 已回滾" ;;
    esac
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap on_exit EXIT

# ---------------------------------------------------------------- 1. 本機檢查
echo "== 1/5 本機檢查"
cd "$REPO"
[[ -f "$REPO/server/index.mjs" && -f "$REPO/server/certs/certificate.pem" ]] || fail "缺 server/index.mjs 或 server/certs/certificate.pem"
node --check "$REPO/server/index.mjs" || fail "server/index.mjs 語法錯誤"
[[ -f "$LOCAL_KEY" ]] || fail "找不到私鑰 $LOCAL_KEY"
[[ "$(stat -c %a "$LOCAL_KEY")" == "600" ]] || fail "私鑰權限應為 600：$LOCAL_KEY"
# 私鑰與憑證必須成對
[[ "$(openssl pkey -in "$LOCAL_KEY" -pubout 2>/dev/null)" == "$(openssl x509 -in "$REPO/server/certs/certificate.pem" -noout -pubkey 2>/dev/null)" ]] \
  || fail "私鑰與 server/certs/certificate.pem 不成對"
echo "• server 程式語法 OK、私鑰 600 且與憑證成對"
# v0.6 回報金鑰：兩個本機檔（600、base64url ≥32 字、兩把不同），寫入金鑰必須等於 app.json 的 extra.telemetryKey
for f in "$WRITE_KEY_FILE" "$READ_KEY_FILE"; do
  [[ -f "$f" ]] || fail "找不到回報金鑰 $f"
  [[ "$(stat -c %a "$f")" == "600" ]] || fail "回報金鑰權限應為 600：$f"
  [[ "$(tr -d '\n' < "$f")" =~ ^[A-Za-z0-9_-]{32,}$ ]] || fail "回報金鑰格式不對（base64url、至少 32 字）：$f"
done
WRITE_KEY="$(tr -d '\n' < "$WRITE_KEY_FILE")"
READ_KEY="$(tr -d '\n' < "$READ_KEY_FILE")"
[[ "$WRITE_KEY" != "$READ_KEY" ]] || fail "寫入金鑰與讀取金鑰不可相同"
APP_KEY="$(node -p "require('$REPO/app.json').expo.extra?.telemetryKey ?? ''")"
[[ "$APP_KEY" == "$WRITE_KEY" ]] || fail "app.json 的 extra.telemetryKey 與 $WRITE_KEY_FILE 不一致（App 送的回報會被拒）"
( umask 077; printf 'TELEMETRY_WRITE_KEY=%s\nTELEMETRY_READ_KEY=%s\n' "$WRITE_KEY" "$READ_KEY" > "$ENV_FILE" )
unset WRITE_KEY READ_KEY APP_KEY
echo "• 回報金鑰 600、格式 OK、寫入金鑰與 app.json 一致"

# ---------------------------------------------------------------- 2. 遠端前置檢查（唯讀）
echo "== 2/5 遠端前置檢查（唯讀，$REMOTE）"
remote preflight | tee "$PRE_OUT" | show
for p in / /wheat/ /wheat/admin/; do
  c="$(field "$PRE_OUT" @@code "$p")"
  echo "• 改前 https://$DOMAIN$p → $c"
  [[ -n "$c" && "$c" != "000" ]] || fail "改前就連不到 https://$DOMAIN$p，無法做前後比對，停止"
done
TUNNEL_BEFORE="$(field "$PRE_OUT" @@svc wheat-tw-tunnel)"
NGINX_STATE="$(awk '$1=="@@nginx"{print $2}' "$PRE_OUT")"

if (( DRY_RUN )); then
  cat <<EOF

== DRY RUN：以下動作「不會」執行，只是預告 ==
  1. 打包 $REPO/server/{index.mjs,certs/certificate.pem,README.md} → $REMOTE:$BASE/server（舊版移到 server.prev）
  2. 上傳私鑰 $LOCAL_KEY → $REMOTE:$BASE/keys/private-key.pem（600，owner pandatimer）
     上傳回報金鑰（$WRITE_KEY_FILE、$READ_KEY_FILE）→ $REMOTE:$BASE/server.env（600，root）
  3. 若無則建立系統帳號 pandatimer；$BASE/updates、$BASE/keys、$BASE/telemetry 給 pandatimer；上一版程式/server.env/unit 留作回滾
  4. 寫 $SYSTEMD_DIR/$SVC.service（User=pandatimer、127.0.0.1:$PORT、EnvironmentFile=$BASE/server.env、
     ReadWritePaths=$BASE/telemetry、Restart=on-failure）→ enable + restart → 驗 /api/health、/api/telemetry 錯誤金鑰 401
  5. nginx：$( [[ "$NGINX_STATE" == "already" ]] && echo "已含 /pandatimer/，不改" || echo "備份到 $BACKUP_DIR/$SITE_NAME.$TS → 插入上方 diff 的 location → nginx -t → reload（失敗即還原）" )
  6. 驗證：/、/wheat/、/wheat/admin/ 狀態碼與改前一致；$PUBLIC_URL/api/health = ok；
     manifest 經 nginx 回 noUpdateAvailable；/api/telemetry 經 nginx：錯誤金鑰 401、讀取金鑰 200；
     nginx / wheat-server@a / $SVC 皆 active；wheat-tw-tunnel 狀態不變
     任一失敗 → 還原 nginx；有上一版就換回並重啟，否則停用 $SVC；非零退出
✅ dry-run 完成（未改動任何東西）
EOF
  exit 0
fi

# ---------------------------------------------------------------- 3. 上傳
STAGE="upload"
echo "== 3/5 上傳程式與私鑰"
tar -C "$REPO/server" --owner=0 --group=0 -czf - index.mjs certs/certificate.pem README.md \
  | "${SSH[@]}" "set -euo pipefail; install -d -m 755 $BASE; rm -rf $BASE/server.incoming; install -d -m 755 $BASE/server.incoming; tar -xzf - -C $BASE/server.incoming --no-same-owner"
"${SSH[@]}" "set -euo pipefail; umask 077; install -d -m 700 $BASE/keys; cat > $BASE/keys/private-key.pem.new" < "$LOCAL_KEY"
"${SSH[@]}" "set -euo pipefail; umask 077; cat > $BASE/server.env.new" < "$ENV_FILE"
echo "• 已上傳到 $BASE/server.incoming、keys/private-key.pem.new、server.env.new"

# ---------------------------------------------------------------- 4. 安裝服務 + nginx
STAGE="install"
echo "== 4/5 安裝 systemd 服務"
remote install "$TS"
STAGE="nginx"
echo "== 4/5 nginx"
remote nginx-apply "$TS"

# ---------------------------------------------------------------- 5. 改後驗證
STAGE="verify"
echo "== 5/5 改後驗證"
remote verify | tee "$POST_OUT" | show
bad=0
for p in / /wheat/ /wheat/admin/; do
  b="$(field "$PRE_OUT" @@code "$p")"; a="$(field "$POST_OUT" @@code "$p")"
  if [[ "$a" == "$b" ]]; then echo "• https://$DOMAIN$p：$b → $a ✓"; else echo "• https://$DOMAIN$p：$b → $a ✗"; bad=1; fi
done
for s in nginx wheat-server@a "$SVC"; do
  st="$(field "$POST_OUT" @@svc "$s")"
  if [[ "$st" == "active" ]]; then echo "• $s：active ✓"; else echo "• $s：$st ✗"; bad=1; fi
done
st="$(field "$POST_OUT" @@svc wheat-tw-tunnel)"
if [[ "$st" == "$TUNNEL_BEFORE" ]]; then echo "• wheat-tw-tunnel：$TUNNEL_BEFORE → $st ✓"; else echo "• wheat-tw-tunnel：$TUNNEL_BEFORE → $st ✗"; bad=1; fi
h="$(awk '$1=="@@health"{print $2}' "$POST_OUT")"
if [[ "$h" == "ok" ]]; then echo "• $PUBLIC_URL/api/health = ok ✓"; else echo "• $PUBLIC_URL/api/health = '$h' ✗"; bad=1; fi
if grep -q '^@@manifest ok' "$POST_OUT"; then echo "• manifest 經 nginx → noUpdateAvailable ✓"; else echo "• manifest 經 nginx 異常 ✗"; bad=1; fi
tb="$(awk '$1=="@@tele_bad"{print $2}' "$POST_OUT")"; tr_="$(awk '$1=="@@tele_read"{print $2}' "$POST_OUT")"
if [[ "$tb" == "401" ]]; then echo "• /api/telemetry 錯誤金鑰 → 401 ✓"; else echo "• /api/telemetry 錯誤金鑰 → '$tb' ✗"; bad=1; fi
if [[ "$tr_" == "200" ]]; then echo "• /api/telemetry 讀取金鑰 → 200 ✓"; else echo "• /api/telemetry 讀取金鑰 → '$tr_' ✗"; bad=1; fi
lh="$(curl -s --max-time 15 "$PUBLIC_URL/api/health" || true)"
echo "• （本機視角，僅參考）$PUBLIC_URL/api/health = '${lh}'"
(( bad == 0 )) || fail "改後驗證未通過"

STAGE="done"
echo ""
echo "✅ 部署成功：$PUBLIC_URL/api/manifest（nginx 備份：$BACKUP_DIR/$SITE_NAME.$TS，若本次有改）"
