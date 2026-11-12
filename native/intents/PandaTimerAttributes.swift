import ActivityKit
import Foundation

// ⚠️ 這個檔案有三份，必須逐字相同（同名、同欄位、同型別）：
//   modules/live-activity/ios/PandaTimerAttributes.swift（App 端 JS 呼叫啟動用，pod LiveActivity）
//   native/intents/PandaTimerAttributes.swift（主 App target，App Intents 背景啟動用）
//   targets/widget/PandaTimerAttributes.swift（widget 顯示用）
//   （v0.4 起 broadcast extension 不用 ActivityKit，剩三份；CI diff 擋）
// ActivityKit 以型別名稱與 Codable 結構比對各程序的定義。
// v0.3 新欄位一律 Optional＋預設 nil：舊資料解碼不會失敗、舊的 init(deadline:estimateMinutes:) 照常可用。
@available(iOS 16.2, *)
struct PandaTimerAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// 預估送達的截止時間
    var deadline: Date
    /// 預估分鐘數
    var estimateMinutes: Int
    /// nil 或 "countdown"＝倒數；"standby"＝螢幕廣播偵測待命；"stopped"＝偵測已停止；
    /// v1.0 "offer"＝偵測到邀請（動態島顯示「✓ 已偵測 N 分邀請・可以按接受」）
    var mode: String? = nil
    /// 偵測程式（螢幕廣播 extension）最後一次回報的時間；有值＝這張卡由偵測程式管理
    var heartbeat: Date? = nil
    /// 偵測診斷小字，例如「幀 812 · OCR 95 · 31/33MB」
    var diag: String? = nil
    /// v0.6 多單：卡片倒數顯示最早截止那單，其餘寫在這裡，例如「另 2 單：18:42、18:55 截止」
    var others: String? = nil
    /// v1.0 偵測到的邀請（分鐘、金額、偵測時間）：mode == "offer" 時是卡片主體；倒數中則只在副標顯示「＋偵測到 N 分邀請」。
    /// 判定接單/未接/逾 60 秒 → 清回 nil
    var offerMin: Int? = nil
    var offerAmount: Double? = nil
    var offerAt: Date? = nil
  }

  /// 接單時間
  var acceptedAt: Date
}
