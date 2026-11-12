# 熊貓倒數 PandaTimer

foodpanda 外送員自用 iPhone App：接單時在動態島／鎖定畫面（Live Activity）顯示「預估送達」倒數，截止前 3 分與截止時本地通知，記錄每單預估/實際時間並算今日準時率、平均超出比例（foodpanda 超時率近似）。
Expo SDK 58 + TypeScript；使用者**無 Mac、無付費 Apple 開發者帳號** → GitHub Actions 編未簽章 .ipa → 免費 Apple ID 重簽側載到 iPhone 14 Pro Max（iOS 26）。
**現況**：SideStore 被 Apple 擋（-80045）→ Windows **Sideloadly** USB 簽裝。CI 約 7 分鐘，取 IPA 一律 `bash scripts/fetch-ipa.sh [run-id]`（只留 `C:\Users\minyue\Downloads\PandaTimer\`、舊版自動刪、檔名 `PandaTimer-v<rv>-<sha7>.ipa`）。實機史：v0.3 extension 內 ActivityKit 不可用；v0.4 音訊保活下背景 update 無效；v0.5 定位保活可 update（要關螢幕再開才重繪）、只抓到第一單；v0.6 多單/遠端設定；v0.7 首日見下節；v0.8（runtime 0.8）已裝實機。**v0.9（runtime 0.9：省電量測＋away 模式＋省電倍率＋卡片 update 節流）寫好，尚未 CI/實機驗收**。
## 目錄
- `App.tsx` 只管狀態/原生與通知接線/分頁切換；畫面在 `src/ui/`（見「UI」節）；`src/orders.ts` 純邏輯；`src/store.ts` AsyncStorage（key `pandatimer.orders.v1`，`mutate()` 序列化）
- `src/controller.ts` 開單/送達/取消、deep link、`initNativeBridge()`（原生同步）、孤兒 Live Activity 對帳
- `src/nativeEvents.ts` 原生事件解析/合併、進行中鏡像（純函式）；`src/ocrPick.ts` OCR 分鐘/金額規則 TS 版；`src/detector.ts` 訊號名稱/狀態解析；v0.6 `src/cardPlan.ts`（多單卡片）、`src/screenInfo.ts`（回報用畫面摘要/白名單關鍵字）、`src/remoteConfig.ts`（遠端設定預設/範圍/驗證）、v0.7 `src/offerTracker.ts`（接單判定狀態機，樣本 `test/fixtures/offer-cases.json`）——都是 Swift 的測試替身；v0.7 `src/stats.ts`（本期統計/目標/補登，純 JS）＋`src/statsConfig.ts`（AsyncStorage/遠端 stats）
- v0.8 `src/frameTrigger.ts`（綠色金額/畫面變化/OCR 排程）、`src/importLink.ts`（匯入 deep link，`scripts/make-import-link.mjs <json>` 產生連結）；v0.9 `src/powerSaver.ts`（away 狀態機/省電倍率/有效排程）；v0.11 `src/sync.ts`＋`src/syncClient.ts`（雲端同步，見下節）；`src/notify.ts` expo-notifications **本地**通知
- `modules/live-activity/` 本地 Expo module（pod `LiveActivity`）：`isSupported/start/end/endAll/activeIds/drainNativeEvents/syncActiveOrders`；v0.3 加 `startStandby/activitySummaries`、view `BroadcastPicker`（`ref.show()`）；v0.4 加 `DetectorHub.swift`（`armDetection/stopDetection/detectorStatus`、事件 `onDetectorSignal`）；v0.5 同檔加 `KeepAlive`（定位）/`AudioKeepAlive`（備援）；v0.6 加 `DetectorCardPlan.swift`、`PandaTelemetry.swift`、`RemoteConfig.swift`、`setTelemetryContext`
- `native/intents/*.swift` **主 App target** 的 App Intents（由 `plugins/withAppIntents.js` 加進 PandaTimer 的 Sources，並明確連結 AppIntents.framework）；`targets/widget/` @bacons/apple-targets 的 widget（PandaWidget），資料夾同步：目錄內 .swift 全自動編進 widget；`targets/broadcast/` 螢幕廣播 extension（apple-targets 型別 `broadcast-upload`，PandaBroadcast，`com.pandatimer.app.broadcast`）
- `plugins/withNoEntitlements.js` 清空 entitlements 安全網；`plugins/withTelemetry.js` 把 app.json `extra.telemetryKey/telemetryUrl`＋runtimeVersion 寫進主 App Info.plist（`PandaTelemetryKey/URL/PandaRuntimeVersion`）；`test/*.test.mjs` node 單元測試（含 test/server.test.mjs 本機起伺服器）
- `.github/workflows/ios-unsigned-ipa.yml` CI：共用檔 diff → prebuild → 無 entitlements → pod install → 未簽章 archive → 驗 PandaWidget＋PandaBroadcast 兩個 appex／**驗 Metadata.appintents 含四個 intent**、Info.plist 背景模式/定位字串、Expo.plist runtimeVersion → 打包 ipa
- `ios/` 由 prebuild 產生（gitignore，不要手改）
## 指令
- `npx tsc --noEmit`；`node --test`（不帶路徑；Node 22.18+ 直接載 .ts）
- `npx expo prebuild -p ios --clean --no-install`（Linux 可跑，不能編譯）；`npx expo export -p ios --output-dir <tmp>`；本機無法編 iOS；真正編譯只在 CI（push main/master 或 workflow_dispatch），artifact `PandaTimer-unsigned-ipa`
## 鐵律：零 entitlement
- 主 App、widget、PandaBroadcast 都**不得**有任何 entitlement（aps-environment、App Groups、iCloud、Siri、time-sensitive…），免費帳號簽不了。App Intents／App Shortcuts 不需要 entitlement。
- expo-notifications 保持 `enableRemoteNotifications: false`；`withNoEntitlements` 是第二道防線。`targets/*/expo-target.config.js` 不准加 `entitlements`；目錄內不准放 `*.entitlements`。
- Live Activity 只靠 `NSSupportsLiveActivities` + `Activity.request(pushType: nil)`；JS 端只能前景啟動，背景啟動只能走 LiveActivityIntent。
- 沒 App Group → widget 與 App 不共享資料；原生↔JS 只能用主 App 程序內的 `UserDefaults.standard`。
- 背景模式只用 Info.plist `UIBackgroundModes=[location,audio]`＋`NSLocationWhenInUse/AlwaysAndWhenInUseUsageDescription`（app.json；都不是 entitlement，CI 與 test 會驗）。
- 逐字相同的多份檔（改完必 `diff`，CI 也會擋）：`PandaTimerAttributes.swift`、`DetectorCardPlan.swift` 各 ×3（modules/live-activity/ios、native/intents、targets/widget）；`DeliverActivityIntent.swift` ×2、`StartDetectedCountdownIntent.swift` ×2（native/intents、targets/widget）；`MinutePicker.swift` ×2（native/intents、targets/broadcast）；`PandaTelemetry.swift`、`RemoteConfig.swift` 各 ×2（modules/live-activity/ios、targets/broadcast）。
- ContentState 加欄位一律 Optional＋預設 nil（舊資料可解碼、舊 init 可用）。動態島 `Text(deadline, style: .timer)`、`staleDate=deadline` → 「已超時」。
## v0.2 App Intents（背景執行、不開 App、不切走 pandarider）
- `StartFromScreenshotIntent`「從截圖開始」：參數 IntentFile（`supportedTypeIdentifiers`，iOS 17 不能用 supportedContentTypes）→ Vision OCR → `MinutePicker.pick`（規則與 `src/ocrPick.ts` 同一套，改一邊改兩邊）→ 開 Live Activity＋2 則通知＋寫事件。找不到分鐘數就丟可讀錯誤。
- `DeliveredIntent`「送達」：結最早一筆進行中（依鏡像）。`DeliverActivityIntent`：動態島/鎖定畫面「送達」按鈕（`Button(intent:)`），結該卡片的單（同卡多單結最早截止、切下一單）；`isDiscoverable=false`，主 App 與 widget 都要有此型別。`PandaShortcuts` 讓前兩個出現在捷徑 App。UserDefaults：`pandatimer.native.events.v1`（事件佇列：start/done）、`pandatimer.native.activeOrders.v1`（進行中鏡像）；讀改寫都在 `objc_sync(UserDefaults.standard)` 內。
- **同步順序（鐵律）**：App 啟動 → `drainNativeEvents` 合併進 AsyncStorage → **之後**才 `reconcileActivities()`（否則原生剛開的動態島被當孤兒關掉）→ 之後每次訂單變動 `syncActiveOrders` 寫鏡像；回前景再 drain。原生 `syncActiveOrders` 會把尚未 drain 的 start/done 事件併進鏡像。
- 捷徑：「熊貓接單」＝擷取螢幕畫面→從截圖開始（背面輕點兩下）；「熊貓送達」備用（輕點三下）。deep link `pandatimer://start?min=18`、`pandatimer://done`、v0.8 `pandatimer://import?d=…`（同 URL 3 秒內去重）。
## 螢幕廣播自動偵測（v0.4 架構，v0.5 保活，v0.6 多單）
- v0.7 首日實測（11/12）邀請（暗色）：下半部「每單收入／85.76 $（亮綠大字）／(5.8 公里)／21 分鐘」…底部白色「接受訂單」；夾單邀請上方「夾單訂單依系統顯示金額為主」、金額「+49.01 $」。金額＝分鐘×4.08355。接單後「預計N分鐘後抵達店家・1筆訂單」「再 N 分鐘即將準備完成」「取餐體驗如何呢?」；取餐/送達確認「…是否已取餐/已送達?」「確認已取餐/已送達」；送達後彈窗「訂單完成」；拍照「上傳照片」。
- broadcast 常停（2/4 次緊接送達確認對話框後，疑拍照）；邀請只在畫面 1~3 秒 → v0.7 閒置 3 秒一次常漏。記憶體平時 27MB、OCR 瞬間 +15~20MB，曾到 70MB 未被殺。
- **實測（v0.3）：ActivityKit 在 broadcast extension 內完全不可用** → extension 不准 import ActivityKit（CI 擋），只做 OCR＋發 Darwin 訊號。
- **實測（v0.4）：靜音音訊保活時背景 update 全部無效**（Apple 論壇 748569）。**v0.5 保活＝背景定位**（`KeepAlive`：WhenInUse、百米、`CLBackgroundActivitySession`；授權被拒/定位失敗才開靜音音訊備援）。Apple 官方立場：背景更新只支援推播（論壇 776031），本地背景 update 屬未文件化行為。
- 流程：App「開始偵測」→ `startStandby()` 偵測卡 → `armDetection()` 保活＋30 秒看門狗 → 等定位授權 → 系統廣播視窗「開始直播」。
- extension（`SampleHandler.swift`）：OCR 用 Y 平面下方 50%、長邊≤640（排程見 v0.8 節）。OCR 原文只在 `runOCR` 內轉成 `ScreenInfo.Summary`（接單鈕/分鐘/金額/公里/白名單關鍵字/畫面分類/夾單/送達）。
- **v0.7 接單後才倒數**（`targets/broadcast/OfferTracker.swift`＝`src/offerTracker.ts`，以 TS 測試為準）：邀請（接單鈕＋分鐘）→ `offered`（只送 `offer.pending.<分>`＋telemetry `offer_seen`）→ 連 `offer.goneAfterMisses` 次沒接單鈕＝`deciding(goneAt)` → `decideWindowSec` 內只命中 `acceptedKeywords`＝接單、只命中 `rejectedKeywords`＝未接（兩邊都中/都沒中＝繼續看）、到期依 `ambiguousAs`；同一張回來＝resumed、另一張＝前一張依 ambiguousAs；接過的（分鐘, 金額）90 秒內再出現＝dup。畫面靜止時靠 workQueue 計時器推進；停止廣播先結案再送 stopped。每次決策送 `offer_decided`（result/reason/wait/kw/hit）。同一張＝分鐘相同且金額相同或任一方沒抓到（後抓到的金額補進 offered，不算新單）。
- **v0.7 自動送達**（`src/deliveryDetector.ts`＝extension `DeliveryEdge`＋App `AutoDelivery`）：命中 `delivery.completedKeywords`（非邀請畫面）邊緣觸發送 `com.pandatimer.delivered`（60 秒不重送，telemetry `delivered_seen`）→ App 結「接單 ≥minOrderAgeSec 的最早單」（鏡像/done 事件/取消提醒/偵測卡切單，同送達按鈕）。互斥：90 秒內有手動結單不自動結；自動結後 20 秒內送達按鈕/捷徑不結（UserDefaults `lastManualDoneAt/lastAutoDoneAt`）。
- **v0.7 記憶體保護**：OCR 前 >`ocr.memSkipMB` 跳幀；辨識當下 >`memHighMB`(44) → 120 秒只認大字。公里：數字間全形句點當小數點、兩位整數 > 預估分鐘 → ÷10。v0.8 送達/挑單改動見下節。
- 訊號（三處一致：DetectorHub.parse / PandaSignal / `src/detector.ts`）：`com.pandatimer.order.<1-90>.<序號 mod 4>`（序號跳號＝遺失，telemetry `gap`）、v0.7 `offer.pending.<1-90>`／`offer.cleared`／`accept.delay.<0-60>`（**接單先送 delay 再送 order**；App 2 秒內配對 → acceptedAt＝收到−delay＝goneAt；App 曾暫停則用通知 userInfo `detectedAt`＝goneAt）、`broadcast.started|stopped|heartbeat`、`drain`、`delivered`；v0.8 `offer.stacked`（在 accept.delay 前）、`delivered.delay.<0-60>`（在 delivered 前）。註冊共 579 個（<1000）。
## v0.8 偵測更快／停止補救／記憶體／夾單／送達（以 TS 測試為準）
- 每 0.2 秒點取樣原始幀（`FrameProbe`：64×64 亮度雜湊＋下方 55% 96×160 色彩點，YUV 多讀 CbCr、不建圖）→ `OcrPlanner`：亮綠色比例 ≥ `greenTrigger.minRatio`（邊緣觸發）或「畫面變了 >changeMinBits 且已靜止」→ 立刻 OCR（距上次 ≥0.6 秒）；疑似邀請（綠色 hold 10 秒/判定中/有接單鈕）0.6 秒、閒置 1.5 秒；同畫面跳過（疑似邀請 2 秒、平時 10 秒強制）。
- OCR 同時最多一個（busy）；每 `ocr.rebuildEvery`（30）次或 memHigh 時重建 request；只 zh-Hant（`ocr.englishToo` 可加回）；memSkip 36MB；beat 帶 `dMB`（OCR 前後差最大）/`green`/`trig`。
- 停止：App 監聽鎖屏/解鎖（telemetry `lock`/`unlock`、stopped 帶 `locked/lockAge/reason`）；ext `pause`/`resume`、stop 帶最後畫面。偵測中（沒按停止偵測）收到 stopped → 通知「偵測停止了，點我重新開始」（userInfo `pandatimer=redetect`，60 秒不重複；心跳逾時通知也帶）→ JS 點擊自動走「開始偵測」叫出廣播視窗；偵測區顯示「⏹ 偵測已停止」。
- 夾單：邀請命中 `offer.stackedKeywords` → 訂單 `stacked:true`；統計另列「不含夾單」（App 紀錄，不併補登）。
- 送達：`delivery.finalKeywords`（訂單完成）優先；只看到確認對話框 → 待定 `pendingSec`（30）秒等訂單完成，否則以對話框時間（delay）結；廣播停止時待定照送。App 結**截止最早**的單。
- 匯入：`pandatimer://import?d=<base64url JSON>`（v1、≤200 筆、無時區＝台北、±90 秒同分鐘＝重複）→ 確認視窗 → `source:'import'` 已送達單，不開動態島/通知。
- **v0.6 多單共用偵測卡**（背景開不了新卡）：每張自動單寫進鏡像時 `activityId=偵測卡 id`（不再搶走舊單的 activityId）→ `DetectorCardPlan` 依鏡像排序：倒數＝**最早截止**、`ContentState.others`＝「另 2 單：18:42、18:55 截止」。送達（動態島按鈕/App/捷徑）→ `afterFinish`：還有單就切下一單，沒有就回 standby（一般卡結束）。
- 新單 → 排 2 則提醒 → 記錄（`source:'auto'`）→ 卡片 `update(_:alertConfiguration:)`（title「新單 N 分」、body 截止、sound default：強制展開＋重繪）；心跳 update 不帶 alert。1 秒後回讀（✓＝本程序狀態已改，不保證畫面；✗ 一定失敗）。App 曾被暫停 → 接單時間改用 extension 通知 userInfo 的 `detectedAt`（分鐘＋序號配對）。
- 備援①：點「偵測到新單」通知 → App 回前景 → 依鏡像重推偵測卡＋回讀。備援②：偵測卡 standby 時的「開始倒數」（`StartDetectedCountdownIntent`，App 程序）→ 依鏡像套用卡片。兩者都只改卡、不記錄。
- 「停止偵測」：停保活；卡上還有單 → 保留倒數（heartbeat=nil），否則結束。心跳 >150 秒沒來 → 通知「偵測沒有回應」。
## v0.9 省電（以 `test/powerSaver.test.mjs` 為準；遠端設定 2026-11-14.1）
- **量測先行**：app beat/arm/disarm/sig 帶 `batt/charging/thermal(0~3)/lowPower`（`DevicePower`：UIDevice 只在主執行緒讀進快取）＋`cardSkip`；ext beat 帶 `ocrMin`（每分鐘 OCR 次數）/`probes`/`mode`/`awaySec`/`saver`/`lowPower/thermal`＋既有 `trig`；ext 事件 `mode`（away 進出＋reason）、`power`（省電開關）。新欄位要**伺服器重新部署**才收得到。
- **away 模式**（`AwayTracker`＝TS 同名類）：連 `away.afterMisses`(5) 次 OCR 沒有 `away.keywords` 特徵詞（去空白比對）也沒接單鈕、沒在判定邀請/等送達 → 取消畫面變化觸發、固定間隔 `away.intervalSec`(6)、取樣 `away.probeIntervalSec`(0.5)；看到特徵詞或綠色觸發立刻回正常。判定用 `ScreenInfo.analyzeWithPresence`（原文不離開 runOCR）。
- **省電倍率**：`ProcessInfo` 低電量模式（`power.onLowPower`）或 thermalState ≥ `power.thermalLevel`(2＝serious；4＝不看)→ 取樣/一般/閒置/快速/變化最小間隔/同畫面強制全部 ×`power.saverFactor`(1.5)（`PowerTiming`＝TS `effectiveTiming`）；偵測卡與 ext 診斷字顯示「省電中」。
- **保活**：`keepAlive.locationAccuracy` hundred|kilometer|threeKilometers、`distanceFilterM`(0＝None)，預設 hundred/50（＝v0.5 實測）。Apple 論壇 727015：iOS 16.4 起「低精度＋距離過濾」背景可能被暫停，`showsBackgroundLocationIndicator=true`（本 App 有開）可避免——未實測，切低精度前先看 telemetry。
- **動態島**：倒數是 `Text(style: .timer)`（系統畫，無每秒 update）；心跳的卡片 update 只在診斷字去掉心跳時間後有變、模式要變、或滿 `app.cardRefreshSeconds`(300) 才做（其他事件照舊立即）。telemetry 批次 `telemetry.flushSeconds` 預設 30→60（beat 仍 60 秒）。
## 遠端設定（v0.6：原生不能 OTA，參數改由伺服器下發）
- **調偵測參數 → 改 `server/config.json`（記得改 `version`）跑 `bash scripts/push-config.sh`，不用重裝。** 公開 `GET /api/config`；內容：`picker`（分鐘/金額規則）、`detector`（接單鈕正則、去重秒數、OCR/裁切/雜湊/心跳；`goneAfterMisses` 只剩 v0.6 用）、`telemetry`（白名單、批次）、`app`（心跳逾時）、v0.7 `offer`（goneAfterMisses、decideWindowSec 5~60、accepted/rejectedKeywords 正則（去空白文字比對、不得命中空字串）、ambiguousAs accept|reject）、`stats`（JS 讀：graceFactor 1.05、overrunCap 1）、`delivery`（enabled、minOrderAgeSec 120、completedKeywords；v0.8 finalKeywords/pendingSec）、`ocr`（memSkipMB、memHighMB；v0.8 rebuildEvery/englishToo）；v0.8 `detector.fastOcrIntervalSeconds/changeMinBits/changeMinGapSeconds/probeIntervalSeconds/greenTrigger{…}`、`offer.stackedKeywords`、telemetry.keywords ≤60 列。伺服器以 config.default.json 補齊缺漏區塊。
- extension：broadcastStarted 與每 `configRefreshSeconds`（600）抓；App（DetectorHub）：開始偵測、回前景（60 秒節流）、看門狗到期時抓。逾時 3 秒，失敗用各程序 UserDefaults 快取（`pandatimer.remoteConfig.v1`）或內建預設；**欄位缺漏/不合法 → 該欄位用預設**（範圍＝`src/remoteConfig.ts` RANGES，test 比對 Swift）。主 App 的「從截圖開始」用 `PickerConfig.cached()`。
- 預設值四處一致：`server/config.default.json`＝`DEFAULT_CONFIG`（TS）＝Swift（`PickerConfig`、`DetectorSettings`、`RemoteConfig`）。version 寫進 telemetry（`cfg`）、偵測卡 diag、App「回報」那行。`picker.maxMinutes` 上限 90（App 只註冊 1~90 分訊號）。
- 部署腳本只在遠端沒有 `config.json` 時用預設建立，不會蓋掉。
## 遠端狀態回報（v0.6 telemetry，取代截圖回報）
- **隱私鐵律：不得上傳 OCR 原文、地址、店名、顧客資訊。** 只送結構化欄位：時間、來源 ext/app、事件、幀/OCR 次數/記憶體、接單鈕、分鐘、金額、公里、**白名單 UI 關鍵字命中**（`ScreenInfo.keywords`＝`src/screenInfo.ts`＝server `TELEMETRY_KEYWORDS`，test 比對）、畫面分類、動態島回讀 ✓/✗、保活模式、定位授權、前景/背景、版本/OTA id。client 與 server 各擋一次欄位白名單（`allowedKeys`＝`FIELD_RULES`）。
- 原生送（`PandaTelemetry`：10 筆或 60 秒（v0.9）一批、新單/錯誤立即送、失敗暫存 200 筆、每分鐘 ≤100 筆）；extension 讀所屬 App 的 Info.plist 拿金鑰/網址。JS 只顯示「回報：最後成功 HH:mm:ss」。
- 查詢：`bash scripts/telemetry.sh [YYYY-MM-DD] [--since 10m] [--follow] [--raw]`（唯讀 GET，讀取金鑰 `~/.config/pandatimer/telemetry-read-key`）。事件：ext `start/beat/screen/order/dup/stop/crashPrev/config`；app `arm/disarm/sig/beat/order/restore/keep/beatTimeout/fg/bg/config`。伺服器白名單關鍵字＝內建 ∪ 遠端設定 `telemetry.keywords`。
- 金鑰：寫入＝app.json `extra.telemetryKey`＝`~/.config/pandatimer/telemetry-write-key`；讀取只在本機與伺服器 `server.env`。換金鑰＝改兩個本機檔＋app.json → 部署＋重編 App。
## OTA 更新（expo-updates，自架伺服器見 `server/README.md`）
- app.json：`runtimeVersion:"0.9"`（固定字串）、`updates.url=https://wheat.yueshengift.xyz/pandatimer/api/manifest`、code signing 憑證 `server/certs/certificate.pem`（keyid main, rsa-v1_5-sha256）；`src/OtaBox.tsx` 在 App 底部顯示版本/更新 id/時間，回前景自動檢查＋下載，**不自動 reload**，出現「有新版，點此套用」按鈕才 `reloadAsync()`（`__DEV__` 或未啟用時隱藏）。
- 純 JS 改動 → `bash scripts/publish-update.sh 0.9`（`--list`；`--republish <ts>` 回滾；`--rollback-embedded`）。原生改動（Swift、plugin、原生套件、app.json 原生設定）→ 升 runtimeVersion（app.json＋OtaBox APP_VERSION＋發佈參數）＋CI 編 ipa＋Sideloadly 重裝。
- 憑證換了＝已裝 App 拒收舊簽章更新，需重裝；私鑰在 `~/.config/pandatimer/keys/`，不進 repo。
## 純 JS 功能（可 OTA）
- **本期統計**（v0.7，`src/stats.ts`）：彈性線 L＝預估×graceFactor；準時＝實際≤L；超時率＝平均 min(cap, max(0,(實際−L)/L))；取消不計（三期實單驗算 43/19、45/19、40/21，官方 44/19、47/14、39/20）。每 14 天一期，錨點 2026-09-28 00:00 台北。目標（準時目標 50%/底線 40%/超時 ≤20%）與本期補登（N0/P0/T0，綁期別）存 AsyncStorage，本期＝加權合併。
- **收入／補錢**（v0.8，`src/earnings.ts`）：預估報酬＝max(45, 預估分×4.08355)；補錢＝max(0, 實際報酬−預估報酬)（實際分鐘四捨五入）；被打星的晚到單不補。App 不知道誰被打星 → 顯示樂觀（全補）／保守（晚到全不補）兩情境，`pay.assumeStarredLate`（預設 true＝保守）決定「預計發放」採哪個。三期 1,109 單對帳誤差 <1 元（test/earnings.test.mjs，orders.json 在 scratchpad 不進 repo）。
- 參數走遠端設定 `pay.ratePerMinute/minFare/assumeStarredLate`（`src/remoteConfig.ts` 驗證，server config*.json 有 `pay` 區塊）；補登多一欄選填「前幾天收入」（`Baseline.income`，同時加進兩情境）。Order 沒存 OCR 金額，`PaySample.estAmount` 是預留欄位。
- **未確認邀請**（v0.10，`src/unconfirmedOffers.ts`＋`UnconfirmedCards.tsx`）：收原生 `offer` 事件（minutes）→ decideWindowSec+10 秒（預設 35）內沒有同分鐘 `order` 事件就在首頁膠囊下問「你有接嗎？」（最多 3 張、30 分鐘消失、存 `pandatimer.unconfirmedOffers.v1`）；有接＝`startOrder(min,…,{acceptedAt:邀請+5秒, source:'confirm'})`；延遲入帳的同分鐘 order 自動移除卡片。
- **刪除紀錄**（`src/prune.ts`）：歷史列長按＝單筆刪、進行中卡片的接單文字長按＝刪進行中單；「管理紀錄」＝今天（台北）／某時間以前（輸入台北 YYYY-MM-DD HH:mm）／全部（二次確認＋輸入「刪除」）；`controller.pruneOrders`：先寫墓碑（`pandatimer.tombstones.v1`，7 天）→ drain（`dropTombstonedEvents` 擋復活）→ 刪 → 進行中單走 `cleanup`（偵測卡走 afterFinish）；補登不受影響。已配對雲端同步時，沒上傳的墓碑不過期。
## 訂單雲端同步（v0.11：伺服器 DB＋管理網頁；App 純 JS 可 OTA）
- 伺服器 `server/orders.mjs`（`node:sqlite`，Node ≥22.13；`DATA_DIR/orders.db`＋每日 `backup/`）＋`index.mjs` 路由。`POST /api/sync`（header `x-pt-sync` 同步碼）：updatedAt 較新者勝（同時間＝伺服器）、刪除＝`deleted` 墓碑、游標＝伺服器遞增 `syncAt`、`dbId` 變或 `reset` → App 全部重傳；≤64KB/300 筆/60 次每分。
- 管理頁 `https://wheat.yueshengift.xyz/pandatimer/admin`（`server/admin.html`，CSP nonce、textContent 防 XSS）＋`/api/admin/*`：cookie（HttpOnly+Secure+SameSite=Strict，12h，金鑰＝DB sessionKey×密碼）＋`x-pt-csrf`＋JSON；GET orders/baselines/export.csv 也收 `x-pt-read`。登入錯 5 次／同步碼錯 10 次 → 全域鎖 15 分（nginx 沒帶可信 IP）。管理頁修改 updatedAt＝max(現在, 原本+1)。
- App：`src/sync.ts`（純，`test/sync.test.mjs` 含端到端）＋`src/syncClient.ts`（啟動/回前景/變動後 5 秒/前景每 2 分；設定頁「雲端同步」配對）。`store.mutate` 對同步欄位有變的單自動蓋 `updatedAt`（`fromSync` 合併不蓋、不觸發）；待上傳＝`updatedAt ≠ pushed[id]`（`pandatimer.sync.state.v1`）＋未上傳墓碑；伺服器結掉進行中單 → `controller.cleanupEnded`；補登槽可存刪除標記（`saveBaseline(b, periodId)`）。同步碼存 `pandatimer.sync.code.v1`。
- 秘密：`~/.config/pandatimer/admin-password`、`sync-code`（deploy 首次產生、600、不覆蓋）→ server.env `ADMIN_PASSWORD`/`SYNC_CODE`（同步碼只是初值，之後以管理頁顯示/重設的為準）。唯讀查詢 `bash scripts/orders.sh [--period|--from D --to D] [--csv|--raw|--baselines|--deleted]`。
## UI（v0.9 OTA 改版：暗色三分頁，純 JS，不得加原生套件）
- 底部自製分頁列（`TabBar`，不用 react-navigation）：**首頁**（騎車用：偵測膠囊 `StatusPill`→進行中卡 `OrderCard`（最早截止在上、長按刪、取消、大送達）→本期大卡/今日小卡 `StatCard`→手動開始（折疊））／**紀錄**（收入摘要→管理紀錄（折疊，三種批次刪除）→依台北日分組歷史＋日小計，60 筆一頁）／**設定**（目標→補登→偵測診斷→OTA→說明與捷徑）。
- 三頁都掛著、非目前頁 `display:'none'`（保留捲動/草稿）；**BroadcastPicker 只在首頁膠囊裡** → `onStartDetect`/redetect 通知流程一律先 `setTab('home')`。上次分頁存 `pandatimer.ui.tab.v1`；膠囊「變成」🔴/🟡或進行中單數變多 → 自動切回首頁（`shouldJumpHome`，邊緣觸發）。
- 純函式在 `src/ui/logic.ts`（`detectPill`/`actionHint`/`groupHistory`/`orderCountdown`…，測試 `test/uiLogic.test.mjs`）；顏色字級在 `src/ui/theme.ts`（暗底 #121212、卡 #1E1E1E、粉 #FF2B85；最小字 16、按鈕高 ≥56）；Alert 流程在 `src/ui/actions.ts`。OTA 狀態 `useOtaUpdate()` 掛在 App 頂層（首頁有新版橫條、設定頁有檢查/套用按鈕）。
- 膠囊「省電中」與診斷「省電/記憶體」讀 `DetectorStatus.power`（`parseDetectorStatus` 只在原生 statusJSON 帶 `lowPower/thermal/saver/memMB` 時才有）；**v0.9 原生沒帶** → 要顯示得等下次原生版把這幾個 key 加進 `DetectorHub.statusJSON()`。
- app.json `userInterfaceStyle` 仍是 light（原生設定，改了要升 runtime）→ 系統 Alert/鍵盤以外的畫面都是 App 自畫的暗色；TextInput 用 `keyboardAppearance="dark"`。
## 已知風險
- Swift 只在 CI 編譯；CI 失敗先看 `xcodebuild.log` 的 error 行。runner `macos-26`（fileSystemSynchronizedGroups 需 Xcode 16+）。定位保活下背景 update、alertConfiguration 本地 update 都**沒有官方文件**，以實機為準。
- v0.9 Swift 未經編譯。最不確定：`DevicePower`（`Task { @MainActor }` 讀 UIDevice）、`PowerTiming.make` 回傳具名 tuple、`NSProcessInfoPowerStateDidChange`/`thermalStateDidChangeNotification` 觀察者。telemetry.keywords >40 列時 v0.7 App 整份改用內建白名單。
- 免費帳號：每 7 天重簽、App ID 佔 **3** 個（主 App＋widget＋broadcast；免費帳號 7 天最多 10 個新 App ID）。動態島/通知權限需在 iPhone 允許。
