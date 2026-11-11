import ActivityKit
import AppIntents
import Foundation

// ⚠️ 這個檔案有兩份，必須逐字相同（CI diff 擋）：
//   native/intents/StartDetectedCountdownIntent.swift（主 App target，由 plugins/withAppIntents.js 加入）
//   targets/widget/StartDetectedCountdownIntent.swift（widget target，資料夾同步自動編入）
// v0.5 一鍵備援：偵測卡（standby）上的「開始倒數」按鈕。背景定位保活下的 Activity.update 若仍被系統擋，
// 按這顆按鈕 → 系統在「App 程序」執行 perform（LiveActivityIntent，可更新動態島）→ 把偵測卡改成
// 最近一次自動偵測那單的倒數（deadline＝偵測時間＋分鐘數，不是按下時間）。
// 訂單在 App 收到 order 訊號時已記錄（DetectorHub → NativeSync.recordStart），這裡**只改卡、不記錄**。
// 只能用兩個 target 都有的符號：PandaTimerAttributes、Foundation、ActivityKit、AppIntents。

/// 「最近一次自動偵測」：App（modules/live-activity 的 DetectorHub / LastAutoStore）收到 order 訊號時寫入。
/// ⚠️ 鍵名與 JSON 格式和 LastAutoStore 一致：{"orderId","minutes","detectedAt"(ms),"deadline"(ms),"activityId"?}
enum DetectedCountdownStore {
  static let key = "pandatimer.detector.lastAuto.v1"
  static let activeKey = "pandatimer.native.activeOrders.v1"
  /// 按鈕只接受 10 分鐘內的偵測
  static let maxAge: TimeInterval = 10 * 60
  /// 剛偵測到、記錄還沒寫進進行中鏡像的寬限時間
  static let recordingGrace: TimeInterval = 30

  struct Record {
    let orderId: String
    let minutes: Int
    let detectedAt: Date
    let activityId: String?

    var deadline: Date { detectedAt.addingTimeInterval(Double(minutes) * 60) }
  }

  static func read() -> Record? {
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    guard let text = defaults.string(forKey: key), let data = text.data(using: .utf8),
          let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
          let orderId = dict["orderId"] as? String,
          let minutes = (dict["minutes"] as? NSNumber)?.intValue,
          let detectedMs = (dict["detectedAt"] as? NSNumber)?.doubleValue
    else { return nil }
    return Record(
      orderId: orderId, minutes: minutes, detectedAt: Date(timeIntervalSince1970: detectedMs / 1000),
      activityId: dict["activityId"] as? String)
  }

  /// 該單仍在進行中（進行中鏡像有它的 id），或剛偵測到（寬限內）
  static func isActive(_ record: Record, now: Date) -> Bool {
    if now.timeIntervalSince(record.detectedAt) < recordingGrace { return true }
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    guard let text = defaults.string(forKey: activeKey), let data = text.data(using: .utf8),
          let list = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]]
    else { return false }
    return list.contains { ($0["id"] as? String) == record.orderId }
  }

  static func clock(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm:ss"
    return f.string(from: date)
  }

  static func isAlive(_ activity: Activity<PandaTimerAttributes>) -> Bool {
    activity.activityState != .ended && activity.activityState != .dismissed
  }

  /// 偵測卡：待命/已停止，或由偵測程式管理（heartbeat 有值）。同 DetectorHub.detectorCard 的挑法。
  static func detectorCard() -> Activity<PandaTimerAttributes>? {
    let all = Activity<PandaTimerAttributes>.activities.filter { activity in
      let state = activity.content.state
      return isAlive(activity) && (state.mode == "standby" || state.mode == "stopped" || state.heartbeat != nil)
    }
    return all.first { $0.content.state.mode == "standby" }
      ?? all.first { $0.content.state.mode == "stopped" }
      ?? all.first
  }

  /// 套用：成功回 nil；失敗回可讀錯誤文字（同時盡量寫進偵測卡的診斷字，讓使用者在動態島上看得到）
  static func apply(now: Date) async -> String? {
    guard let record = read(), now.timeIntervalSince(record.detectedAt) < maxAge,
          now.timeIntervalSince(record.detectedAt) > -60
    else {
      return await report("沒有 10 分鐘內的自動偵測，請在 App 內手動開始")
    }
    guard isActive(record, now: now) else {
      return await report("最近的自動單（\(record.minutes) 分）已送達或取消")
    }
    let card = record.activityId.flatMap { id in
      Activity<PandaTimerAttributes>.activities.first { $0.id == id && isAlive($0) }
    } ?? detectorCard()
    guard let activity = card else { return "找不到動態島卡片" }
    var state = activity.content.state
    state.mode = "countdown"
    state.deadline = record.deadline
    state.estimateMinutes = record.minutes
    state.diag = "按鈕開始倒數 \(clock(now)) · 偵測 \(record.minutes) 分 @\(clock(record.detectedAt))"
    await activity.update(ActivityContent(state: state, staleDate: record.deadline))
    return nil
  }

  private static func report(_ message: String) async -> String {
    if let activity = detectorCard() {
      var state = activity.content.state
      state.diag = "⚠️ \(message)（\(clock(Date()))）"
      let staleDate = state.mode == "standby" || state.mode == "stopped" ? nil : activity.content.staleDate
      await activity.update(ActivityContent(state: state, staleDate: staleDate))
    }
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
