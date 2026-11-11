# 熊貓倒數 PandaTimer

foodpanda 外送員自用 iPhone App：接單時在動態島／鎖定畫面（Live Activity）顯示「預估送達」倒數，截止前 3 分與截止時本地通知，記錄每單預估/實際時間並算今日準時率、平均超出比例（foodpanda 超時率近似）。
Expo SDK 58 + TypeScript；使用者**無 Mac、無付費 Apple 開發者帳號** → GitHub Actions 編未簽章 .ipa → 免費 Apple ID 重簽側載到 iPhone 14 Pro Max（iOS 26）。
**現況（2026-11-11）**：SideStore 登入被 Apple 擋（-80045），改用 Windows **Sideloadly** 經 USB 簽裝；v0.1 實機驗收通過。CI 約 7 分鐘，取 IPA 一律用 `bash scripts/fetch-ipa.sh [run-id]`（使用者要求：只留一個資料夾 `C:\Users\minyue\Downloads\PandaTimer\`、舊版自動刪、檔名帶版本 `PandaTimer-v<rv>-<sha7>.ipa`）。v0.2（App Intents＋動態島送達按鈕）已過 CI。v0.3 實機：偵測（OCR/接單鈕/27 分）成功，但 extension 內 ActivityKit 完全不可用、記憶體峰值 44MB。v0.4 實機：偵測→Darwin 訊號→App 入帳/提醒 OK，但**音訊保活下背景更新動態島全部無效**、extension 峰值 43MB。v0.5 實機：定位保活下背景 update **有生效但動態島要關螢幕再開才重繪**；**只偵測得到第一單**（同一張 27 分圖：extension 180 秒＋App 90 秒「同分鐘數」去重，且同名 Darwin 通知在 App 暫停時會合併）。v0.6（多單＋alert 強制重繪＋遠端狀態回報＋遠端設定）寫好，**尚未 CI/實機驗收**。

## 目錄
- `App.tsx` 單頁 UI；`src/orders.ts` 純邏輯；`src/store.ts` AsyncStorage（key `pandatimer.orders.v1`，`mutate()` 序列化）
- `src/controller.ts` 開單/送達/取消、deep link、`initNativeBridge()`（原生同步）、孤兒 Live Activity 對帳
- `src/nativeEvents.ts` 原生事件解析/合併、進行中鏡像（純函式）；`src/ocrPick.ts` OCR 分鐘/金額規則 TS 版；`src/detector.ts` 訊號名稱/狀態解析；v0.6 `src/cardPlan.ts`（多單卡片）、`src/screenInfo.ts`（回報用畫面摘要/白名單關鍵字）、`src/remoteConfig.ts`（遠端設定預設/範圍/驗證）——都是 Swift 的測試替身
- `src/notify.ts` expo-notifications **本地**通知
- `modules/live-activity/` 本地 Expo module（pod `LiveActivity`）：`isSupported/start/end/endAll/activeIds/drainNativeEvents/syncActiveOrders`；v0.3 加 `startStandby/activitySummaries`、view `BroadcastPicker`（`ref.show()`）；v0.4 加 `DetectorHub.swift`（`armDetection/stopDetection/detectorStatus`、事件 `onDetectorSignal`）；v0.5 同檔加 `KeepAlive`（定位）/`AudioKeepAlive`（備援）；v0.6 加 `DetectorCardPlan.swift`、`PandaTelemetry.swift`、`RemoteConfig.swift`、`setTelemetryContext`
- `native/intents/*.swift` **主 App target** 的 App Intents（由 `plugins/withAppIntents.js` 加進 PandaTimer 的 Sources，並明確連結 AppIntents.framework）
- `targets/widget/` @bacons/apple-targets 的 widget（PandaWidget），資料夾同步：目錄內 .swift 全自動編進 widget
- `targets/broadcast/` 螢幕廣播 extension（apple-targets 型別 `broadcast-upload`，PandaBroadcast，`com.pandatimer.app.broadcast`）
- `plugins/withNoEntitlements.js` 清空 entitlements 安全網；`plugins/withTelemetry.js` 把 app.json `extra.telemetryKey/telemetryUrl`＋runtimeVersion 寫進主 App Info.plist（`PandaTelemetryKey/URL/PandaRuntimeVersion`）；`test/*.test.mjs` node 單元測試（含 test/server.test.mjs 本機起伺服器）
- `.github/workflows/ios-unsigned-ipa.yml` CI：共用檔 diff → prebuild → 無 entitlements → pod install → 未簽章 archive → 驗 PandaWidget＋PandaBroadcast 兩個 appex／**驗 Metadata.appintents 含四個 intent**、Info.plist 背景模式/定位字串、Expo.plist runtimeVersion → 打包 ipa
- `ios/` 由 prebuild 產生（gitignore，不要手改）

## 指令
- `npx tsc --noEmit`；`node --test`（不帶路徑；Node 22.18+ 直接載 .ts）
- `npx expo prebuild -p ios --clean --no-install`（Linux 可跑，不能編譯）；`npx expo export -p ios --output-dir <tmp>`
- 本機無法編 iOS；真正編譯只在 CI（push main/master 或 workflow_dispatch），artifact `PandaTimer-unsigned-ipa`

## 鐵律：零 entitlement
- 主 App、widget、PandaBroadcast 都**不得**有任何 entitlement（aps-environment、App Groups、iCloud、Siri、time-sensitive…），免費帳號簽不了。App Intents／App Shortcuts 不需要 entitlement。
- expo-notifications 保持 `enableRemoteNotifications: false`；`withNoEntitlements` 是第二道防線。
- `targets/*/expo-target.config.js` 不准加 `entitlements`；目錄內不准放 `*.entitlements`。
- Live Activity 只靠 `NSSupportsLiveActivities` + `Activity.request(pushType: nil)`；JS 端只能前景啟動，背景啟動只能走 LiveActivityIntent。
- 沒 App Group → widget 與 App 不共享資料；原生↔JS 只能用主 App 程序內的 `UserDefaults.standard`。
- 背景模式只用 Info.plist `UIBackgroundModes=[location,audio]`＋`NSLocationWhenInUse/AlwaysAndWhenInUseUsageDescription`（app.json；都不是 entitlement，CI 與 test 會驗）。
- 逐字相同的多份檔（改完必 `diff`，CI 也會擋）：`PandaTimerAttributes.swift`、`DetectorCardPlan.swift` 各 ×3（modules/live-activity/ios、native/intents、targets/widget）；`DeliverActivityIntent.swift` ×2、`StartDetectedCountdownIntent.swift` ×2（native/intents、targets/widget）；`MinutePicker.swift` ×2（native/intents、targets/broadcast）；`PandaTelemetry.swift`、`RemoteConfig.swift` 各 ×2（modules/live-activity/ios、targets/broadcast）。
- ContentState 加欄位一律 Optional＋預設 nil（舊資料可解碼、舊 init 可用）。

## v0.2 App Intents（背景執行、不開 App、不切走 pandarider）
- `StartFromScreenshotIntent`「從截圖開始」：參數 IntentFile（`supportedTypeIdentifiers`，iOS 17 不能用 supportedContentTypes）→ Vision OCR → `MinutePicker.pick`（規則與 `src/ocrPick.ts` 同一套，改一邊改兩邊）→ 開 Live Activity＋2 則通知＋寫事件。找不到分鐘數就丟可讀錯誤。
- `DeliveredIntent`「送達」：結**最早一筆**進行中（依 UserDefaults 鏡像）。
- `DeliverActivityIntent`：動態島展開版面／鎖定畫面的「送達」按鈕（`Button(intent:)`），結**該卡片 activityId 對應的單**（v0.6：同卡多單時結最早截止那單，卡片切下一單）；`isDiscoverable=false`。主 App 與 widget 都要有此型別，perform 由系統在 App 程序執行。
- `PandaShortcuts`（AppShortcutsProvider）讓前兩個出現在捷徑 App「熊貓倒數」底下。
- UserDefaults：`pandatimer.native.events.v1`（事件佇列：start/done）、`pandatimer.native.activeOrders.v1`（進行中鏡像）；讀改寫都在 `objc_sync(UserDefaults.standard)` 內。
- **同步順序（鐵律）**：App 啟動 → `drainNativeEvents` 合併進 AsyncStorage → **之後**才 `reconcileActivities()`（否則原生剛開的動態島被當孤兒關掉）→ 之後每次訂單變動 `syncActiveOrders` 寫鏡像；回前景再 drain。原生 `syncActiveOrders` 會把尚未 drain 的 start/done 事件併進鏡像。

## 捷徑設定（給使用者）
- 「熊貓接單」：① 擷取螢幕畫面 → ② 熊貓倒數：從截圖開始（截圖參數接上一步）→ 綁「背面輕點兩下」
- 送達：**直接按動態島（長按展開）或鎖定畫面卡片上的「送達」**；捷徑「熊貓送達」＝① 熊貓倒數：送達，綁背面輕點三下作備用
- 舊 deep link 仍保留：`pandatimer://start?min=18`、`pandatimer://done`（同 URL 3 秒內去重）

## 螢幕廣播自動偵測（v0.4 架構，v0.5 保活，v0.6 多單）
- **實測（v0.3）：ActivityKit 在 broadcast extension 內完全不可用** → extension 不准 import ActivityKit（CI 擋），只做 OCR＋發 Darwin 訊號。
- **實測（v0.4）：靜音音訊保活時背景 update 全部無效**（Apple 論壇 748569）。**v0.5 保活＝背景定位**（`KeepAlive`：WhenInUse、百米、`CLBackgroundActivitySession`；授權被拒/定位失敗才開靜音音訊備援）。Apple 官方立場：背景更新只支援推播（論壇 776031），本地背景 update 屬未文件化行為。
- 流程：App「開始偵測」→ `startStandby()` 偵測卡 → `armDetection()` 保活＋30 秒看門狗 → 等定位授權 → 系統廣播視窗「開始直播」。
- extension（`SampleHandler.swift`）：Y 平面、下方 50%、長邊≤640；OCR 1.5 秒（連 3 次無接單鈕 3 秒）；64×64 雜湊同畫面跳過（10 秒強制）。OCR 原文只在 `runOCR` 內轉成 `ScreenInfo.Summary`（接單鈕/分鐘/金額/公里/白名單關鍵字/畫面分類）。
- **v0.6 新單判定**（extension）：**邊緣觸發**——接單鈕出現一次只觸發一次（連 2 次 OCR 沒看到才算消失）；出現中分鐘數或金額變了也算新單；同一組（分鐘, 金額取整）**90 秒內不重複**。App 端**不再去重**。
- 訊號（三處一致：DetectorHub.parse / PandaSignal / `src/detector.ts`）：`com.pandatimer.order.<1-90>.<序號 mod 4>`（同名 Darwin 通知在 App 暫停時會合併，序號讓連續同分鐘單名稱不同；註冊 364 個；序號跳號＝遺失，記 telemetry `gap`）、`com.pandatimer.broadcast.started|stopped|heartbeat`（60 秒）、`com.pandatimer.drain`。
- **v0.6 多單共用偵測卡**（背景開不了新卡）：每張自動單寫進鏡像時 `activityId=偵測卡 id`（不再搶走舊單的 activityId）→ `DetectorCardPlan` 依鏡像排序：倒數＝**最早截止**、`ContentState.others`＝「另 2 單：18:42、18:55 截止」。送達（動態島按鈕/App/捷徑）→ `afterFinish`：還有單就切下一單，沒有就回 standby（一般卡結束）。
- 新單 → 排 2 則提醒 → 記錄（`source:'auto'`）→ 卡片 `update(_:alertConfiguration:)`（title「新單 N 分」、body 截止、sound default：強制展開＋重繪）；心跳 update 不帶 alert。1 秒後回讀（✓＝本程序狀態已改，不保證畫面；✗ 一定失敗）。App 曾被暫停 → 接單時間改用 extension 通知 userInfo 的 `detectedAt`（分鐘＋序號配對）。
- 備援①：點「偵測到新單」通知 → App 回前景 → 依鏡像重推偵測卡＋回讀。備援②：偵測卡 standby 時的「開始倒數」（`StartDetectedCountdownIntent`，App 程序）→ 依鏡像套用卡片。兩者都只改卡、不記錄。
- 「停止偵測」：停保活；卡上還有單 → 保留倒數（heartbeat=nil），否則結束。心跳 >150 秒沒來 → 通知「偵測沒有回應」。

## 遠端設定（v0.6：原生不能 OTA，參數改由伺服器下發）
- **調偵測參數 → 改 `server/config.json`（記得改 `version`）跑 `bash scripts/push-config.sh`，不用重裝。** 公開 `GET /api/config`；內容：`picker`（分鐘/金額正則與範圍、關鍵字、費率、最低價、短單分鐘）、`detector`（接單鈕正則、去重秒數、OCR 間隔、裁切比例、長邊、minimumTextHeight、雜湊門檻、心跳、重抓間隔）、`telemetry`（白名單關鍵字、批次）、`app`（心跳逾時）。
- extension：broadcastStarted 與每 `configRefreshSeconds`（600）抓；App（DetectorHub）：開始偵測、回前景（60 秒節流）、看門狗到期時抓。逾時 3 秒，失敗用各程序 UserDefaults 快取（`pandatimer.remoteConfig.v1`）或內建預設；**欄位缺漏/不合法 → 該欄位用預設**（範圍＝`src/remoteConfig.ts` RANGES，test 比對 Swift）。主 App 的「從截圖開始」用 `PickerConfig.cached()`。
- 預設值四處一致：`server/config.default.json`＝`DEFAULT_CONFIG`（TS）＝Swift（`PickerConfig`、`DetectorSettings`、`RemoteConfig`）。version 寫進 telemetry（`cfg`）、偵測卡 diag、App「回報」那行。`picker.maxMinutes` 上限 90（App 只註冊 1~90 分訊號）。
- 部署腳本只在遠端沒有 `config.json` 時用預設建立，不會蓋掉。

## 遠端狀態回報（v0.6 telemetry，取代截圖回報）
- **隱私鐵律：不得上傳 OCR 原文、地址、店名、顧客資訊。** 只送結構化欄位：時間、來源 ext/app、事件、幀/OCR 次數/記憶體、接單鈕、分鐘、金額、公里、**白名單 UI 關鍵字命中**（`ScreenInfo.keywords`＝`src/screenInfo.ts`＝server `TELEMETRY_KEYWORDS`，test 比對）、畫面分類、動態島回讀 ✓/✗、保活模式、定位授權、前景/背景、版本/OTA id。client 與 server 各擋一次欄位白名單（`allowedKeys`＝`FIELD_RULES`）。
- 原生送（`PandaTelemetry`：10 筆或 30 秒一批、新單/錯誤立即送、失敗暫存 200 筆、每分鐘 ≤100 筆）；extension 讀所屬 App 的 Info.plist 拿金鑰/網址。JS 只顯示「回報：最後成功 HH:mm:ss」。
- 查詢：`bash scripts/telemetry.sh [YYYY-MM-DD] [--since 10m] [--follow] [--raw]`（唯讀 GET，讀取金鑰 `~/.config/pandatimer/telemetry-read-key`）。事件：ext `start/beat/screen/order/dup/stop/crashPrev/config`；app `arm/disarm/sig/beat/order/restore/keep/beatTimeout/fg/bg/config`。伺服器白名單關鍵字＝內建 ∪ 遠端設定 `telemetry.keywords`。
- 金鑰：寫入＝app.json `extra.telemetryKey`＝`~/.config/pandatimer/telemetry-write-key`；讀取只在本機與伺服器 `server.env`。換金鑰＝改兩個本機檔＋app.json → 部署＋重編 App。

## OTA 更新（expo-updates，自架伺服器見 `server/README.md`）
- app.json：`runtimeVersion:"0.6"`（固定字串）、`updates.url=https://wheat.yueshengift.xyz/pandatimer/api/manifest`、code signing 憑證 `server/certs/certificate.pem`（keyid main, rsa-v1_5-sha256）；`src/OtaBox.tsx` 在 App 底部顯示版本/更新 id/時間，回前景自動檢查＋下載，**不自動 reload**，出現「有新版，點此套用」按鈕才 `reloadAsync()`（`__DEV__` 或未啟用時隱藏）。
- 純 JS 改動 → `bash scripts/publish-update.sh 0.6`（`--list` 看版本；`--republish <ts>` 回滾；`--rollback-embedded` 回內建）。
- 原生改動（Swift、plugin、原生套件、app.json 原生設定）→ 升 runtimeVersion（app.json＋OtaBox 的 APP_VERSION＋發佈參數）＋CI 編 ipa＋Sideloadly 重裝。
- 憑證換了＝所有已裝 App 拒收舊簽章更新，需重裝；私鑰在 `~/.config/pandatimer/keys/`，不進 repo。

## 動態島顯示
`Text(deadline, style: .timer)` 倒數，過截止自動往上數；`staleDate = deadline` → `context.isStale` 顯示「已超時」（紅）。

## 已知風險
- v0.2 Swift 未經編譯；CI 失敗先看 `xcodebuild.log` 的 error 行。最不確定：IntentFile 的 `supportedTypeIdentifiers` 參數 init、`MainActor.run` 包 `Activity.request`、widget 端 `Button(intent:)`。
- ActivityKit 以型別名對應：pod 的 `activeIds()/end()` 是否看得到 intent 開的動態島需實機確認（看不到時 App 內按送達關不掉該動態島）。
- runner `macos-26`；pbxproj 含 fileSystemSynchronizedGroups 需 Xcode 16+。
- v0.4 Swift 未經編譯。最不確定：`CFNotificationCenterAddObserver` 的 C 回呼閉包、`OnAppBecomesActive`、`AsyncFunction("stopDetection")` 的 async Void、extension 的 `GrayFrame` 指標運算。
- v0.5 Swift 未經編譯。最不確定：`CLBackgroundActivitySession()`（pod 平台 16.4，用 `#available` 包）、widget 端 `StartDetectedCountdownIntent` 的 metadata 擷取、`UIApplication.shared`（pod 內）。定位保活下背景 update 是否被允許**沒有官方文件**（論壇開發者實測可行），以實機為準。
- v0.6 Swift 未經編譯。最不確定：`CFGetTypeID(NSNumber)` 排除布林、`AlertConfiguration`/`LocalizedStringResource(stringLiteral:)`、`placeOrder(&order)` 的 inout＋async、extension 讀所屬 App 的 Info.plist（`Bundle(url:)`；讀不到則回報停用、偵測照常）。alertConfiguration 的本地 update **沒有官方文件化的次數預算**（推播才有每小時預算），論壇有鎖屏時延遲約 1 分鐘的回報；alert 只是提示，不保證背景 update 被套用。
- 免費帳號：每 7 天重簽、App ID 佔 **3** 個（主 App＋widget＋broadcast；免費帳號 7 天最多 10 個新 App ID）。動態島/通知權限需在 iPhone 允許。
