import ActivityKit
import AppIntents
import Foundation

// ⚠️ 這個檔案有兩份，必須逐字相同（CI diff 擋）：
//   native/intents/StartDetectedCountdownIntent.swift（主 App target，由 plugins/withAppIntents.js 加入）
//   targets/widget/StartDetectedCountdownIntent.swift（widget target，資料夾同步自動編入）
// v0.5 一鍵備援：偵測卡（standby）上的「開始倒數」按鈕。背景的 Activity.update 若被系統擋（卡還停在「偵測中」），
// 按這顆按鈕 → 系統在「App 程序」執行 perform（LiveActivityIntent，可更新動態島）→ 把卡套成正確的倒數。
// v0.6：不再只看「最近一次自動偵測」，改依進行中鏡像裡掛在這張偵測卡上的全部自動單（DetectorCardPlan）：
//   倒數＝最早截止那單、others＝其餘。訂單在 App 收到 order 訊號時已記錄（DetectorHub），這裡**只改卡、不記錄**。
// 只能用兩個 target 都有的符號：PandaTimerAttributes、DetectorCardPlan、Foundation、ActivityKit、AppIntents。
enum DetectedCountdownStore {
  /// 偵測卡：待命/已停止，或由偵測程式管理（heartbeat 有值）。同 DetectorHub.detectorCard 的挑法。
  static func detectorCard() -> Activity<PandaTimerAttributes>? {
    let all = Activity<PandaTimerAttributes>.activities.filter { activity in
      let state = activity.content.state
      return DetectorCardPlan.isAlive(activity)
        && (state.mode == "standby" || state.mode == "stopped" || state.heartbeat != nil)
    }
    return all.first { $0.content.state.mode == "standby" }
      ?? all.first { $0.content.state.mode == "countdown" }
      ?? all.first { $0.content.state.mode == "stopped" }
      ?? all.first
  }

  static func clock(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm:ss"
    return f.string(from: date)
  }

  /// 套用：成功回 nil；失敗回可讀錯誤文字（同時盡量寫進偵測卡的診斷字，讓使用者在動態島上看得到）
  static func apply(now: Date) async -> String? {
    guard let card = detectorCard() else { return "找不到動態島偵測卡" }
    let items = DetectorCardPlan.items(cardId: card.id)
    guard !items.isEmpty else {
      return await report(card, "沒有進行中的自動偵測單，請在 App 內手動開始")
    }
    await DetectorCardPlan.apply(
      to: card, items: items, note: "按鈕開始倒數 \(clock(now)) · 進行中 \(items.count) 單", alert: nil)
    return nil
  }

  private static func report(_ activity: Activity<PandaTimerAttributes>, _ message: String) async -> String {
    var state = activity.content.state
    state.diag = DetectorCardPlan.trimmed("⚠️ \(message)（\(clock(Date()))）")
    let staleDate = state.mode == "standby" || state.mode == "stopped" ? nil : activity.content.staleDate
    await activity.update(ActivityContent(state: state, staleDate: staleDate))
    return message
  }
}

struct DetectedCountdownError: Error, CustomLocalizedStringResourceConvertible {
  let message: String
  var localizedStringResource: LocalizedStringResource { "\(message)" }
}

/// 偵測卡（standby）動態島展開版面／鎖定畫面的「開始倒數」按鈕。不在捷徑 App 列出。
struct StartDetectedCountdownIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "開始偵測到的倒數"
  static let isDiscoverable: Bool = false
  static let openAppWhenRun: Bool = false

  init() {}

  func perform() async throws -> some IntentResult {
    if let error = await DetectedCountdownStore.apply(now: Date()) {
      throw DetectedCountdownError(message: error)
    }
    return .result()
  }
}
