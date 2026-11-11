# 熊貓倒數 PandaTimer

foodpanda 外送員自用 iPhone App：接單時在動態島／鎖定畫面（Live Activity）顯示「預估送達」倒數，截止前 3 分與截止時本地通知，記錄每單預估/實際時間並算今日準時率、平均超出比例（foodpanda 超時率近似）。
Expo SDK 58 + TypeScript；使用者**無 Mac、無付費 Apple 開發者帳號** → GitHub Actions 編未簽章 .ipa → 免費 Apple ID 重簽側載到 iPhone 14 Pro Max（iOS 26）。
**現況（2026-11-11）**：SideStore 登入被 Apple 擋（-80045），改用 Windows **Sideloadly** 經 USB 簽裝；v0.1 實機驗收通過。CI 約 7 分鐘，`gh run download` 取 IPA。v0.2（App Intents＋動態島送達按鈕）已過 CI。v0.3 實機：偵測（OCR/接單鈕/27 分）成功，但 extension 內 ActivityKit 完全不可用、記憶體峰值 44MB。v0.4（extension→Darwin 訊號→App 保活自己更新動態島＋入帳）寫好，**尚未 CI/實機驗收**。

## 目錄
- `App.tsx` 單頁 UI；`src/orders.ts` 純邏輯；`src/store.ts` AsyncStorage（key `pandatimer.orders.v1`，`mutate()` 序列化）
- `src/controller.ts` 開單/送達/取消、deep link、`initNativeBridge()`（原生同步）、孤兒 Live Activity 對帳
- `src/nativeEvents.ts` 原生事件解析/合併、進行中鏡像（純函式）；`src/ocrPick.ts` OCR 分鐘挑選規則 TS 版；`src/detector.ts` v0.4 訊號名稱/狀態解析（純函式）
- `src/notify.ts` expo-notifications **本地**通知
- `modules/live-activity/` 本地 Expo module（pod `LiveActivity`）：`isSupported/start/end/endAll/activeIds/drainNativeEvents/syncActiveOrders`；v0.3 加 `startStandby/activitySummaries`、view `BroadcastPicker`（`ref.show()`）；v0.4 加 `DetectorHub.swift`（`armDetection/stopDetection/detectorStatus`、事件 `onDetectorSignal`）
- `native/intents/*.swift` **主 App target** 的 App Intents（由 `plugins/withAppIntents.js` 加進 PandaTimer 的 Sources，並明確連結 AppIntents.framework）
- `targets/widget/` @bacons/apple-targets 的 widget（PandaWidget），資料夾同步：目錄內 .swift 全自動編進 widget
- `targets/broadcast/` 螢幕廣播 extension（apple-targets 型別 `broadcast-upload`，PandaBroadcast，`com.pandatimer.app.broadcast`）
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
- 背景模式只用 Info.plist `UIBackgroundModes=[audio]`（app.json；不是 entitlement，CI 會驗）。
- 逐字相同的多份檔（改完必 `diff`，CI 也會擋）：`PandaTimerAttributes.swift` ×3（modules/live-activity/ios、native/intents、targets/widget）；`DeliverActivityIntent.swift` ×2（native/intents、targets/widget）；`MinutePicker.swift` ×2（native/intents、targets/broadcast）。
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

## v0.4 螢幕廣播自動偵測（extension 偵測 → App 保活更新動態島＋入帳）
- **實測結論（v0.3, iOS 26.6.2）：ActivityKit 在 broadcast extension 內完全不可用**（看不到 App 的卡、自己 request 報「Target does not include NSSupportsLiveActivities」，即使 appex plist 有該鍵）。extension 不准 import ActivityKit（CI 擋）。
- 流程：App「開始偵測」→ `startStandby()` 偵測卡 → `armDetection()` 靜音 `AVAudioPlayer`（`.playback`＋`.mixWithOthers`，不打斷 pandarider/音樂）保活＋30 秒看門狗 → 系統廣播視窗「開始直播」。
- extension（`SampleHandler.swift`）：直接讀 Y 平面、只取下方 55%、整數倍平均縮到長邊≤800 → 灰階 CGImage；1.5 秒最多一次，64×64 平均雜湊與上次 OCR 幾乎相同就跳過（10 秒強制一次）；request 重用、`minimumTextHeight 0.018`。偵測規則 `OrderDetector`＋`MinutePicker`（TS 版有測試）；同分鐘 3 分內去重。
- 訊號（Darwin notification，名稱編碼資料；三處一致：DetectorHub.parse / PandaSignal / `src/detector.ts`）：`com.pandatimer.order.<1-90>`、`com.pandatimer.broadcast.started|stopped|heartbeat`（心跳 60 秒）、`com.pandatimer.drain`（PandaSharedStore 寫事件後發）。
- App 收到新單（原生 `DetectorHub`，不依賴 JS）：先試背景 `Activity.request` 新卡（官方：背景不能開，預期失敗）→ 失敗則把偵測卡 update 成倒數（疊單會覆蓋前一張自動單，舊單讓出 activityId）→ 原生排 2 則提醒 → 寫 start 事件（`source:'auto'`）進 UserDefaults 佇列 → 發 `onDetectorSignal` 叫 JS drain 入帳；並發 passive 通知寫結果。90 秒內同分鐘去重。
- 送達：動態島按鈕 → PandaSharedStore 結單＋偵測卡回 standby＋發 drain → App 立刻入帳。App 內送達 → `LiveActivity.end` 對偵測卡改回 standby（不結束）。「停止偵測」：停保活，偵測卡結束（倒數中則交還給那單）。
- 診斷：偵測卡 diag 由 App 寫（App 已收到心跳/保活狀態/最近新單）；extension 的幀/OCR/MB 只在「偵測到新單」通知、峰值>40MB（passive）、停止摘要（passive）、上次異常中止時發通知。心跳 >150 秒沒來 → App 通知「偵測沒有回應」。
- 已知限制：背景只播音訊的程序**鎖屏時**更新動態島可能被系統拒（liveactivitiesd「only playing background media」，未鎖屏回報可行）→ 回前景會補推；mixable session 被電話中斷後不保證收到 ended → 看門狗/回前景補播，但 App 若已被暫停就要使用者回 App。

## 動態島顯示
`Text(deadline, style: .timer)` 倒數，過截止自動往上數；`staleDate = deadline` → `context.isStale` 顯示「已超時」（紅）。

## 已知風險
- v0.2 Swift 未經編譯；CI 失敗先看 `xcodebuild.log` 的 error 行。最不確定：IntentFile 的 `supportedTypeIdentifiers` 參數 init、`MainActor.run` 包 `Activity.request`、widget 端 `Button(intent:)`。
- ActivityKit 以型別名對應：pod 的 `activeIds()/end()` 是否看得到 intent 開的動態島需實機確認（看不到時 App 內按送達關不掉該動態島）。
- runner `macos-26`；pbxproj 含 fileSystemSynchronizedGroups 需 Xcode 16+。
- v0.4 Swift 未經編譯。最不確定：`CFNotificationCenterAddObserver` 的 C 回呼閉包、`OnAppBecomesActive`、`AsyncFunction("stopDetection")` 的 async Void、extension 的 `GrayFrame` 指標運算。
- 免費帳號：每 7 天重簽、App ID 佔 **3** 個（主 App＋widget＋broadcast；免費帳號 7 天最多 10 個新 App ID）。動態島/通知權限需在 iPhone 允許。
