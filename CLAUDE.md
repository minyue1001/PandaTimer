# 熊貓倒數 PandaTimer

foodpanda 外送員自用 iPhone App：接單時在動態島／鎖定畫面（Live Activity）顯示「預估送達」倒數，截止前 3 分與截止時本地通知，記錄每單預估/實際時間並算今日準時率、平均超出比例（foodpanda 超時率近似）。
Expo SDK 58 + TypeScript；使用者**無 Mac、無付費 Apple 開發者帳號** → GitHub Actions 編未簽章 .ipa → 免費 Apple ID 重簽側載到 iPhone 14 Pro Max（iOS 26）。
**現況（2026-11-11）**：SideStore 登入被 Apple 擋（-80045），改用 Windows **Sideloadly** 經 USB 簽裝；v0.1 實機驗收通過。CI 約 7 分鐘，`gh run download` 取 IPA。v0.2（App Intents＋動態島送達按鈕）已過 CI。v0.3（螢幕廣播自動偵測，最小驗證版）寫好，**尚未 CI/實機驗收**。

## 目錄
- `App.tsx` 單頁 UI；`src/orders.ts` 純邏輯；`src/store.ts` AsyncStorage（key `pandatimer.orders.v1`，`mutate()` 序列化）
- `src/controller.ts` 開單/送達/取消、deep link、`initNativeBridge()`（原生同步）、孤兒 Live Activity 對帳
- `src/nativeEvents.ts` 原生事件解析/合併、進行中鏡像（純函式）；`src/ocrPick.ts` OCR 分鐘挑選規則 TS 版
- `src/notify.ts` expo-notifications **本地**通知
- `modules/live-activity/` 本地 Expo module（pod `LiveActivity`）：`isSupported/start/end/endAll/activeIds/drainNativeEvents/syncActiveOrders`；v0.3 加 `startStandby/activitySummaries` 與原生 view `BroadcastPicker`（`ref.show()`）
- `native/intents/*.swift` **主 App target** 的 App Intents（由 `plugins/withAppIntents.js` 加進 PandaTimer 的 Sources，並明確連結 AppIntents.framework）
- `targets/widget/` @bacons/apple-targets 的 widget（PandaWidget），資料夾同步：目錄內 .swift 全自動編進 widget
- `targets/broadcast/` v0.3 螢幕廣播 extension（apple-targets 型別 `broadcast-upload`，PandaBroadcast，`com.pandatimer.app.broadcast`）
- `plugins/withNoEntitlements.js` 清空 entitlements 安全網；`test/*.test.mjs` node 單元測試
- `.github/workflows/ios-unsigned-ipa.yml` CI：共用檔 diff → prebuild → 無 entitlements → pod install → 未簽章 archive → 驗 PandaWidget＋PandaBroadcast 兩個 appex／**驗 Metadata.appintents 含三個 intent** → 打包 ipa
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
- 逐字相同的多份檔（改完必 `diff`，CI 也會擋）：`PandaTimerAttributes.swift` ×4（modules/live-activity/ios、native/intents、targets/widget、targets/broadcast）；`DeliverActivityIntent.swift` ×2（native/intents、targets/widget）；`MinutePicker.swift` ×2（native/intents、targets/broadcast）。
- ContentState 加欄位一律 Optional＋預設 nil（舊資料可解碼、舊 init 可用）。

## v0.2 App Intents（背景執行、不開 App、不切走 pandarider）
- `StartFromScreenshotIntent`「從截圖開始」：參數 IntentFile（`supportedTypeIdentifiers`，iOS 17 不能用 supportedContentTypes）→ Vision OCR → `MinutePicker.pick`（規則與 `src/ocrPick.ts` 同一套，改一邊改兩邊）→ 開 Live Activity＋2 則通知＋寫事件。找不到分鐘數就丟可讀錯誤。
- `DeliveredIntent`「送達」：結**最早一筆**進行中（依 UserDefaults 鏡像）。
- `DeliverActivityIntent`：動態島展開版面／鎖定畫面的「送達」按鈕（`Button(intent:)`），結**該卡片 activityId 對應的單**；`isDiscoverable=false`。主 App 與 widget 都要有此型別，perform 由系統在 App 程序執行。
- `PandaShortcuts`（AppShortcutsProvider）讓前兩個出現在捷徑 App「熊貓倒數」底下。
- UserDefaults：`pandatimer.native.events.v1`（事件佇列：start/done）、`pandatimer.native.activeOrders.v1`（進行中鏡像）；讀改寫都在 `objc_sync(UserDefaults.standard)` 內。
- **同步順序（鐵律）**：App 啟動 → `drainNativeEvents` 合併進 AsyncStorage → **之後**才 `reconcileActivities()`（否則原生剛開的動態島被當孤兒關掉）→ 之後每次訂單變動 `syncActiveOrders` 寫鏡像；回前景再 drain。原生 `syncActiveOrders` 會把尚未 drain 的 start/done 事件併進鏡像。

## 捷徑設定（給使用者）
- 「熊貓接單」：① 擷取螢幕畫面 → ② 熊貓倒數：從截圖開始（截圖參數接上一步）→ 綁「背面輕點兩下」
- 送達：**直接按動態島（長按展開）或鎖定畫面卡片上的「送達」**；捷徑「熊貓送達」＝① 熊貓倒數：送達，綁背面輕點三下作備用
- 舊 deep link 仍保留：`pandatimer://start?min=18`、`pandatimer://done`（同 URL 3 秒內去重）

## v0.3 螢幕廣播自動偵測（最小驗證版）
- 流程：App「開始偵測」→ `startStandby()` 前景開一張 mode=`standby` 的卡（已有偵測卡就沿用）→ `BroadcastPicker.show()` 叫出系統廣播視窗 → 使用者按「開始直播」→ extension 每 1 秒最多 OCR 一幀（裁下方 60%、長邊≤1000px、CPU CIContext、`.accurate` zh-Hant）。
- 觸發：`OrderDetector.detect`（含「接受訂單」且前面不是「已」→ `MinutePicker.pick`）；TS 版 `src/ocrPick.ts` 的 `detectNewOrderMinutes` 有 node 測試。同分鐘數 3 分鐘內去重；觸發就把**同一張**偵測卡 update 成 mode=`countdown`（測試版只有一張卡）。
- 心跳：每 60 秒 update `heartbeat`/`diag`（幀數·OCR 次數·目前/峰值 MB·末次是否看到接單鈕·觸發次數）。停止時 mode=`stopped`（倒數中則保留倒數）。
- 通道：extension 只用 `Activity<PandaTimerAttributes>.activities` 找偵測卡（mode standby/stopped 或 heartbeat≠nil），**不碰一般倒數卡**。找不到→本地通知「結果 B」（10 分鐘一次），偵測到新單時另試 extension 自己 `Activity.request`（成功＝結果 C）；每次觸發都發「偵測到新單：N 分鐘」通知。
- extension 自己的 UserDefaults 記上一輪；上輪沒走到 `broadcastFinished`（被 jetsam 殺）→ 下次開始時通知「上次偵測異常中止」附最後診斷。
- 對帳：`reconcileActivities` 用 `activitySummaries`，`detector=true` 的卡一律保留（`orphanActivityIds`，寧可多留）。動態島「送達」按在偵測卡上＝改回 standby，不結束、不記帳。
- 實機驗證看：心跳每分鐘變、diag 的 MB 峰值（>45 危險）、鎖屏 30 分鐘後心跳是否還在走、開一張含「接受訂單 27 分鐘」的圖看是否變倒數。
- 限制：偵測到的單不進 App 訂單紀錄/統計；只有一張卡；extension 的 ActivityKit/通知能力未經實機證實。

## 動態島顯示
`Text(deadline, style: .timer)` 倒數，過截止自動往上數；`staleDate = deadline` → `context.isStale` 顯示「已超時」（紅）。

## 已知風險
- v0.2 Swift 未經編譯；CI 失敗先看 `xcodebuild.log` 的 error 行。最不確定：IntentFile 的 `supportedTypeIdentifiers` 參數 init、`MainActor.run` 包 `Activity.request`、widget 端 `Button(intent:)`。
- ActivityKit 以型別名對應：pod 的 `activeIds()/end()` 是否看得到 intent 開的動態島需實機確認（看不到時 App 內按送達關不掉該動態島）。
- runner `macos-26`；pbxproj 含 fileSystemSynchronizedGroups 需 Xcode 16+。
- v0.3 Swift 未經編譯。最不確定：extension 內 `Activity.activities` 是否看得到 App 的卡（可編譯，能否運作要實機）、`task_vm_info.ledger_phys_footprint_peak`、view AsyncFunction `show`。
- 免費帳號：每 7 天重簽、App ID 佔 **3** 個（主 App＋widget＋broadcast；免費帳號 7 天最多 10 個新 App ID）。動態島/通知權限需在 iPhone 允許。
