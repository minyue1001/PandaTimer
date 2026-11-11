# PandaTimer 自架 expo-updates 伺服器

**架構**：iPhone App（expo-updates）→ `https://wheat.yueshengift.xyz/pandatimer/`（wheat-new 的 nginx，`location ^~ /pandatimer/`）→ `127.0.0.1:3970` 的 `index.mjs`（零依賴 Node，systemd `pandatimer-updates`，帳號 `pandatimer`）。
實作 Expo Updates protocol v1：`GET /api/manifest`（multipart，RSA-SHA256 簽章，keyid `main`）、`GET /api/assets`、`GET /api/health`。只支援 iOS。
資料：`/opt/pandatimer-updates/updates/<runtimeVersion>/<timestamp>/`（`expo export -p ios` 的 dist＋`expoConfig.json`）取 timestamp 最大者；目錄內有 `rollback` 檔＝回 rollBackToEmbedded；無版本＝noUpdateAvailable。
金鑰：私鑰 `~/.config/pandatimer/keys/private-key.pem`（本機，600，**不進 repo**）→ 部署時複製到 `/opt/pandatimer-updates/keys/`；憑證 `server/certs/certificate.pem`（進 repo，App 內嵌，有效到 2036）。

## v0.6 遠端狀態回報（telemetry）
- `POST /api/telemetry`：header `x-pt-key: <寫入金鑰>`，body JSON 物件或陣列（≤64KB、每來源每分鐘 ≤120 筆，超過 413/429）。伺服器只留白名單欄位（`FIELD_RULES`）、`kw` 只留白名單關鍵字、字串截 80 字，附伺服器時間 `ts` → `/opt/pandatimer-updates/telemetry/YYYY-MM-DD.jsonl`（台北日期，保留 14 天、單日 ≤20MB）。
- `GET /api/telemetry?date=&since=<ISO>&limit=`：header `x-pt-read: <讀取金鑰>`。查詢用 `bash scripts/telemetry.sh [日期] [--since 10m] [--follow]`（唯讀，不經 ssh）。
- 兩把金鑰：寫入 `~/.config/pandatimer/telemetry-write-key`（＝app.json `extra.telemetryKey`，會進 App）、讀取 `~/.config/pandatimer/telemetry-read-key`（**只在本機與伺服器**）；部署時寫成遠端 `/opt/pandatimer-updates/server.env`（600），systemd `EnvironmentFile` 讀，`ReadWritePaths` 只開 telemetry 目錄。
- **隱私鐵律：不收 OCR 原文、地址、店名、顧客資訊。**

## 指令（在 /home/minyue/PandaTimer）
- 部署前預覽（遠端唯讀）：`bash scripts/deploy-updates-server.sh --dry-run`
- 部署／更新伺服器程式（冪等，失敗自動回滾：重跑時換回上一版程式＋server.env＋unit，首次部署則停用服務）：`bash scripts/deploy-updates-server.sh`
- 發佈 OTA：`bash scripts/publish-update.sh 0.6`
- 看版本：`bash scripts/publish-update.sh 0.6 --list`
- 回滾到舊 JS：`bash scripts/publish-update.sh 0.6 --republish <舊timestamp>`（舊內容以新 timestamp 重發；**只刪最新目錄沒用**，已更新的 App 不會降回較舊的 createdAt）
- 回滾到安裝包內建 JS：`bash scripts/publish-update.sh 0.6 --rollback-embedded`
- 本機測試：`node --test`（test/server.test.mjs 會在隨機埠起一份伺服器測 OTA＋telemetry）；手動：`PORT=3971 UPDATES_DIR=/tmp/u PRIVATE_KEY_PATH=~/.config/pandatimer/keys/private-key.pem PUBLIC_URL=http://127.0.0.1:3971 TELEMETRY_DIR=/tmp/t TELEMETRY_WRITE_KEY=w TELEMETRY_READ_KEY=r node server/index.mjs`

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
