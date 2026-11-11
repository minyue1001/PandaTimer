# 熊貓倒數 PandaTimer

foodpanda 外送員自用 iPhone App：接單時在動態島／鎖定畫面（Live Activity）顯示「預估送達」倒數，截止前 3 分與截止時本地通知，記錄每單預估/實際時間並算今日準時率、平均超出比例（foodpanda 超時率近似）。
Expo SDK 58 + TypeScript；使用者**無 Mac、無付費 Apple 開發者帳號** → GitHub Actions 編未簽章 .ipa → SideStore（免費 Apple ID）重簽側載到 iPhone 14 Pro Max。

## 目錄
- `App.tsx` 單頁 UI（開始倒數／進行中卡片／今日統計／最近 50 筆）
- `src/orders.ts` 純邏輯：Order 型別、統計、deep link 解析、時間格式
- `src/store.ts` AsyncStorage 持久化（key `pandatimer.orders.v1`），`mutate()` 序列化寫入
- `src/controller.ts` 開單/送達/取消、deep link 監聽、啟動時結束孤兒 Live Activity
- `src/notify.ts` expo-notifications **本地**通知（不註冊推播）
- `modules/live-activity/` 本地 Expo module（Swift, pod `LiveActivity`）：`isSupported/start/end/endAll/activeIds`
- `targets/widget/` @bacons/apple-targets 的 widget extension（PandaWidget, `com.pandatimer.app.widget`），SwiftUI Live Activity UI
- `plugins/withNoEntitlements.js` 清空主 App entitlements 的安全網（finalized mod，與 plugin 順序無關）
- `.github/workflows/ios-unsigned-ipa.yml` CI：prebuild → pod install → 未簽章 archive → 驗 appex → 打包 ipa
- `ios/` 由 prebuild 產生（已 gitignore，不要手改）

## 指令
- `npx tsc --noEmit` 型別檢查
- `npx expo prebuild -p ios --clean --no-install` 產生 ios/（Linux 可跑，不能編譯）
- `npx expo export -p ios --output-dir <tmp>` 驗 JS bundle
- 本機無法編 iOS；真正編譯只在 CI（push main/master 或 Actions 頁手動 workflow_dispatch），下載 artifact `PandaTimer-unsigned-ipa`

## 鐵律：零 entitlement
- 主 App 與 widget 都**不得**有任何 entitlement（`aps-environment`、App Groups、iCloud、Associated Domains、time-sensitive 通知…），SideStore 免費帳號簽不了。
- expo-notifications 必須保持 `enableRemoteNotifications: false`；`withNoEntitlements` 是第二道防線（已實測：拿掉它＋開 remote 時會冒出 aps-environment）。
- `targets/widget/expo-target.config.js` 不准加 `entitlements`；目錄內不准放 `*.entitlements`。
- Live Activity 只靠 Info.plist `NSSupportsLiveActivities` + `Activity.request(pushType: nil)` 本地啟動；必須 App 在前景時呼叫（controller 會等 AppState active）。
- widget 與 App 無法共享資料（沒 App Group）→ 所有顯示資料放 ActivityAttributes/ContentState。
- `PandaTimerAttributes.swift` 有兩份（modules/live-activity/ios/ 與 targets/widget/），必須逐字相同：改完跑 `diff` 確認。

## Deep link（給 iOS 捷徑：背面輕點→截圖→OCR→打開 URL）
- `pandatimer://start?min=18` 開新單（疊單照開；min 取第一個數字，1–180；缺省用畫面上的預估值）
- `pandatimer://done` 最早一筆進行中的單標記送達
- 冷啟動走 `Linking.getInitialURL()`，執行中走 `url` 事件；同 URL 3 秒內去重

## 動態島顯示
`Text(deadline, style: .timer)` 倒數，過截止自動往上數；`staleDate = deadline` → 過截止系統重繪、`context.isStale` 顯示「已超時」（紅）。

## 已知未驗證風險（CI 首跑前沒有任何一次真編譯）
- Swift 未經編譯：`modules/live-activity/ios/LiveActivityModule.swift`、`targets/widget/*.swift`
- runner 用 `macos-26`（expo-modules-jsi 要 swift-tools 6.2 = Xcode 26）；若該 label 不存在改 `macos-latest` 再看 Xcode 版本
- pbxproj objectVersion 54 但含 fileSystemSynchronizedGroups（apple-targets 產物），需 Xcode 16+
- SideStore 免費帳號：每週 7 天要重簽、最多 3 個 App／每週 10 個 App ID（本 App 佔 2 個：主 App＋widget）
- 動態島／通知權限需使用者在 iPhone 允許；「設定 › 熊貓倒數 › 即時動態」要開
