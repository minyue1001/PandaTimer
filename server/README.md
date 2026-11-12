# PandaTimer 自架 expo-updates 伺服器

**架構**：iPhone App（expo-updates）→ `https://wheat.yueshengift.xyz/pandatimer/`（wheat-new 的 nginx，`location ^~ /pandatimer/`）→ `127.0.0.1:3970` 的 `index.mjs`（零依賴 Node，systemd `pandatimer-updates`，帳號 `pandatimer`）。
實作 Expo Updates protocol v1：`GET /api/manifest`（multipart，RSA-SHA256 簽章，keyid `main`）、`GET /api/assets`、`GET /api/health`。只支援 iOS。
資料：`/opt/pandatimer-updates/updates/<runtimeVersion>/<timestamp>/`（`expo export -p ios` 的 dist＋`expoConfig.json`）取 timestamp 最大者；目錄內有 `rollback` 檔＝回 rollBackToEmbedded；無版本＝noUpdateAvailable。
金鑰：私鑰 `~/.config/pandatimer/keys/private-key.pem`（本機，600，**不進 repo**）→ 部署時複製到 `/opt/pandatimer-updates/keys/`；憑證 `server/certs/certificate.pem`（進 repo，App 內嵌，有效到 2036）。

## v0.6 遠端設定（不用重裝就能調偵測參數）
- `GET /api/config`（公開、無金鑰）：`CONFIG_PATH`＝`/opt/pandatimer-updates/config.json`，缺的欄位用內建預設 `server/config.default.json` 補齊；檔案不存在/壞掉＝回內建預設。ETag＋`Cache-Control: public, max-age=60`，改檔立即生效不用重啟。
- 參數：`picker`（分鐘/金額正則與範圍、關鍵字、費率 4.08355、最低價 45、短單 8 分）、`detector`（接單鈕正則、去重 90 秒、OCR 間隔、裁切比例、長邊、minimumTextHeight、雜湊門檻、心跳、重抓間隔）、`telemetry`（白名單關鍵字、批次秒數/筆數）、`app`（心跳逾時）。欄位範圍見 `src/remoteConfig.ts` 的 `RANGES`，App 端不合法的欄位一律改用預設。
- 改設定：編輯 `server/config.json`（**改 version**）→ `bash scripts/push-config.sh`（本機嚴格驗證→上傳→驗線上 version，失敗換回 `config.json.prev`）。部署腳本只在遠端沒有 config.json 時用預設建立，不會蓋掉。

## v0.6 遠端狀態回報（telemetry）
- `POST /api/telemetry`：header `x-pt-key: <寫入金鑰>`，body JSON 物件或陣列（≤64KB、每來源每分鐘 ≤120 筆，超過 413/429）。伺服器只留白名單欄位（`FIELD_RULES`）、`kw` 只留白名單關鍵字、字串截 80 字，附伺服器時間 `ts` → `/opt/pandatimer-updates/telemetry/YYYY-MM-DD.jsonl`（台北日期，保留 14 天、單日 ≤20MB）。
- `GET /api/telemetry?date=&since=<ISO>&limit=`：header `x-pt-read: <讀取金鑰>`。查詢用 `bash scripts/telemetry.sh [日期] [--since 10m] [--follow]`（唯讀，不經 ssh）。
- 兩把金鑰：寫入 `~/.config/pandatimer/telemetry-write-key`（＝app.json `extra.telemetryKey`，會進 App）、讀取 `~/.config/pandatimer/telemetry-read-key`（**只在本機與伺服器**）；部署時寫成遠端 `/opt/pandatimer-updates/server.env`（600），systemd `EnvironmentFile` 讀，`ReadWritePaths` 只開 telemetry 與 data（v0.11）目錄。
- **隱私鐵律：不收 OCR 原文、地址、店名、顧客資訊。**

## v0.11 訂單雲端同步＋管理網頁
- **資料庫**：`orders.mjs`（Node 內建 `node:sqlite`，**Node ≥22.13** 免旗標；部署腳本 preflight 會驗）→ `/opt/pandatimer-updates/data/orders.db`（WAL；owner pandatimer；systemd `ReadWritePaths` 含 data）。表 `orders`、`baselines`（百分比 0~100）、`meta`（dbId、同步碼、session 金鑰）。每天第一次寫入/啟動時 `VACUUM INTO data/backup/orders-YYYY-MM-DD.db`，留 14 份。開不了 → `/api/sync`、`/api/admin/*` 回 503，OTA/設定/回報照常。
- **`POST /api/sync`**：header `x-pt-sync: <同步碼>`（大小寫/空白/連字號不拘）；body `{since, changes:{orders:[…], baselines:[…]}}`（≤64KB、≤300 筆、全域 60 次/分）。每筆白名單驗證（id、時間範圍、預估 1~180、status、金額、note ≤100 字、source、updatedAt ≤ 伺服器時間+10 分）；不合法的列在 `invalid`、其餘照收。LWW：updatedAt 較新才寫（同時間＝伺服器為準）；刪除墓碑可只帶 `{id, updatedAt, deleted:true}`。回 `{now, more, dbId, reset, changes, accepted, invalid}`：changes＝游標 since 之後的變動（不含本次被採用的；被拒的一定附伺服器版），一頁 500，`more:true` 用 now 續拉。
- **管理頁** `GET /admin`（經 nginx＝`https://wheat.yueshengift.xyz/pandatimer/admin`）：依日期列訂單、日小計、本期（14 天，錨點 2026-09-28）準時率/超時率/收入（含補登加權；沒金額的單以 max(45, 預估×4.08355) 估）、編輯/刪除/還原/新增、補登、同步碼顯示/重設、匯出 CSV。
- **`/api/admin/*`**：`login`/`logout`/`session`、`orders`（GET ?from&to&deleted=1、POST 新增）、`orders/<id>`（PUT/DELETE）、`orders/<id>/restore`、`baselines`、`baselines/<期別>`（PUT/DELETE）、`sync-code/reset`、`export.csv`。寫入要 cookie＋`x-pt-csrf`＋`content-type: application/json`（有 Origin 時須同站）；GET orders/baselines/export.csv 也接受 `x-pt-read`（＝telemetry 讀取金鑰）→ `bash scripts/orders.sh`。
- **安全**：密碼/同步碼以 sha256＋timingSafeEqual 比對；登入錯 5 次鎖 15 分、同步碼錯 10 次鎖 15 分（**全域**：nginx 沒帶可信來源 IP、X-Forwarded-For 可偽造 → 代價是攻擊者能暫時鎖住登入）；cookie `pt_admin` HttpOnly+Secure+SameSite=Strict、Path=/pandatimer、12 小時，簽章金鑰＝DB 隨機 sessionKey×管理密碼（改密碼＝全部登出）；頁面 CSP nonce、frame-ancestors none、no-store；CSV 擋公式注入；log 不印密碼/同步碼。
- **秘密**：`ADMIN_PASSWORD`、`SYNC_CODE`（server.env；部署腳本由本機 `~/.config/pandatimer/admin-password`、`sync-code` 帶上，不存在才產生）。`SYNC_CODE` 只在資料庫還沒有同步碼時當初值；管理頁重設後以資料庫為準（本機檔不會跟著變）。

## 指令（在 /home/minyue/PandaTimer）
- 部署前預覽（遠端唯讀）：`bash scripts/deploy-updates-server.sh --dry-run`
- 部署／更新伺服器程式（冪等，失敗自動回滾：重跑時換回上一版程式＋server.env＋unit，首次部署則停用服務）：`bash scripts/deploy-updates-server.sh`
- 發佈 OTA：`bash scripts/publish-update.sh 0.6`
- 看版本：`bash scripts/publish-update.sh 0.6 --list`
- 回滾到舊 JS：`bash scripts/publish-update.sh 0.6 --republish <舊timestamp>`（舊內容以新 timestamp 重發；**只刪最新目錄沒用**，已更新的 App 不會降回較舊的 createdAt）
- 回滾到安裝包內建 JS：`bash scripts/publish-update.sh 0.6 --rollback-embedded`
- 查雲端訂單（唯讀）：`bash scripts/orders.sh --period`（`--from/--to`、`--csv`、`--raw`、`--baselines`、`--deleted`）
- 本機測試：`node --test`（test/server.test.mjs 測 OTA＋telemetry；test/syncServer.test.mjs 測同步/管理頁；test/sync.test.mjs 端到端）；手動（加 `DATA_DIR=/tmp/d ADMIN_PASSWORD=至少12字 ADMIN_COOKIE_SECURE=0 ADMIN_COOKIE_PATH=/` 可在 http://127.0.0.1:3971/admin 登入）：`PORT=3971 UPDATES_DIR=/tmp/u PRIVATE_KEY_PATH=~/.config/pandatimer/keys/private-key.pem PUBLIC_URL=http://127.0.0.1:3971 TELEMETRY_DIR=/tmp/t TELEMETRY_WRITE_KEY=w TELEMETRY_READ_KEY=r node server/index.mjs`

## 拆掉伺服器（整個撤掉）
`ssh wheat-new` 後：`systemctl disable --now pandatimer-updates`；把 `/root/nginx-backup/wheat.yueshengift.xyz.<時間戳>`（部署時那份）蓋回 sites-enabled 指向的實體檔 → `nginx -t && systemctl reload nginx`。

## App 端整合（app.json → expo）
```json
"runtimeVersion": "0.6",
"updates": {
  "url": "https://wheat.yueshengift.xyz/pandatimer/api/manifest",
  "enabled": true,
  "checkAutomatically": "ON_LOAD",
  "fallbackToCacheTimeout": 0,
  "codeSigningCertificate": "./server/certs/certificate.pem",
  "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
}
```
- `runtimeVersion` 用固定字串；**只有原生改動（Swift、plugin、原生套件、app.json 原生設定）才升版並重新 CI＋側載**，純 JS 改動用 `publish-update.sh` 發同一版號。
- `checkAutomatically: "ON_LOAD"`＋`fallbackToCacheTimeout: 0`：冷啟動背景下載，下次冷啟動生效（不擋開機畫面）。
- 根目錄 `.gitignore` 有 `*.pem`，`server/.gitignore` 以 `!certs/certificate.pem` 放行憑證，CI 才拿得到。
