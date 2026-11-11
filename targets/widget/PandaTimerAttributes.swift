import ActivityKit
import Foundation

// ⚠️ 這個檔案有兩份，必須逐字相同（同名、同欄位、同型別）：
//   modules/live-activity/ios/PandaTimerAttributes.swift（App 端啟動用）
//   targets/widget/PandaTimerAttributes.swift（widget 顯示用）
// ActivityKit 以型別名稱與 Codable 結構比對 App 與 widget 兩邊的定義。
@available(iOS 16.2, *)
struct PandaTimerAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// 預估送達的截止時間
    var deadline: Date
    /// 預估分鐘數
    var estimateMinutes: Int
  }

  /// 接單時間
  var acceptedAt: Date
}
