import ActivityKit
import AppIntents
import Foundation
import UserNotifications

// ⚠️ 這個檔案有兩份，必須逐字相同：
//   native/intents/DeliverActivityIntent.swift（主 App target，由 plugins/withAppIntents.js 加入）
//   targets/widget/DeliverActivityIntent.swift（widget target，資料夾同步自動編入）
// 動態島/鎖定畫面的「送達」按鈕用 Button(intent:)：widget 要看得到型別才能畫按鈕；
// LiveActivityIntent 由系統在「App 程序」背景執行 perform（所以 UserDefaults.standard 是 App 的）。
// 這裡只能用兩個 target 都有的符號：PandaTimerAttributes、Foundation、ActivityKit、UserNotifications。

/// 原生 ↔ JS 共用的 UserDefaults 資料（沒有 App Group，只有同一個 App 程序讀得到）。
/// 鍵名與格式另見 modules/live-activity/ios/LiveActivityModule.swift、src/nativeEvents.ts。
///  - eventsKey：原生事件佇列（JSON 陣列字串），JS 用 drainNativeEvents() 取走
///      start: {type,id,acceptedAt,estimateMin,deadline,activityId?,notifIds}  done: {type,at,orderId?,activityId?}
///  - activeKey：進行中訂單鏡像（JSON 陣列字串），JS 每次變動用 syncActiveOrders() 覆寫，原生開單/結單也會更新
/// 所有讀改寫都在 objc_sync(UserDefaults.standard) 裡做，跨 module 同一把鎖。
enum PandaSharedStore {
  static let eventsKey = "pandatimer.native.events.v1"
  static let activeKey = "pandatimer.native.activeOrders.v1"

  struct ActiveOrder {
    let id: String
    let acceptedAt: Double
    let estimateMin: Int
    let activityId: String?
    let notifIds: [String]

    init?(_ dict: [String: Any]) {
      guard let id = dict["id"] as? String,
            let acceptedAt = (dict["acceptedAt"] as? NSNumber)?.doubleValue
      else { return nil }
      self.id = id
      self.acceptedAt = acceptedAt
      self.estimateMin = (dict["estimateMin"] as? NSNumber)?.intValue ?? 0
      self.activityId = dict["activityId"] as? String
      self.notifIds = (dict["notifIds"] as? [String]) ?? []
    }
  }

  static func withLock<T>(_ body: () -> T) -> T {
    let lockObject = UserDefaults.standard
    objc_sync_enter(lockObject)
    defer { objc_sync_exit(lockObject) }
    return body()
  }

  static func readArray(_ key: String) -> [[String: Any]] {
    guard let text = UserDefaults.standard.string(forKey: key),
          let data = text.data(using: .utf8),
          let array = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]]
    else { return [] }
    return array
  }

  static func writeArray(_ array: [[String: Any]], _ key: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: array, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return }
    UserDefaults.standard.set(text, forKey: key)
  }

  static func ms(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
  }

  /// 原生開單：同時寫入事件佇列與進行中鏡像
  static func recordStart(_ order: [String: Any]) {
    withLock { () -> Void in
      var event = order
      event["type"] = "start"
      var events = readArray(eventsKey)
      events.append(event)
      writeArray(events, eventsKey)
      var active = readArray(activeKey)
      active.append(order)
      writeArray(active, activeKey)
    }
    postDrain()
  }

  /// v0.4：事件佇列有新東西 → Darwin 通知「com.pandatimer.drain」。App 程序（保活中）的
  /// DetectorHub 收到就叫 JS 立刻 drain，自動偵測的單送達後不必等回前景才入帳。
  /// widget 端也編得過但不會執行（LiveActivityIntent 的 perform 在 App 程序跑）。
  static func postDrain() {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName("com.pandatimer.drain" as CFString), nil, nil, true)
  }

  /// 結單：activityId 有值 → 結對應那張動態島的單；nil → 結最早接單的一筆。
  /// 從鏡像移除並寫入 done 事件，回傳被結的單（鏡像裡找不到則 nil）。
  /// 指定 activityId 但鏡像沒有時，仍寫入只帶 activityId 的 done 事件，交給 JS 以 activityId 對應。
  static func finishOrder(activityId: String?, at date: Date) -> ActiveOrder? {
    let finished = finishOrderLocked(activityId: activityId, at: date)
    postDrain()
    return finished
  }

  private static func finishOrderLocked(activityId: String?, at date: Date) -> ActiveOrder? {
    withLock { () -> ActiveOrder? in
      var active = readArray(activeKey)
      var index: Int?
      if let activityId = activityId {
        index = active.firstIndex { ($0["activityId"] as? String) == activityId }
      } else {
        var bestTime = Double.greatestFiniteMagnitude
        for (i, item) in active.enumerated() {
          if let order = ActiveOrder(item), order.acceptedAt < bestTime {
            bestTime = order.acceptedAt
            index = i
          }
        }
      }
      var finished: ActiveOrder?
      if let i = index {
        finished = ActiveOrder(active[i])
        active.remove(at: i)
        writeArray(active, activeKey)
      }
      if finished == nil && activityId == nil { return nil }
      var event: [String: Any] = ["type": "done", "at": ms(date)]
      if let order = finished {
        event["orderId"] = order.id
        if let aid = order.activityId { event["activityId"] = aid }
      } else if let aid = activityId {
        event["activityId"] = aid
      }
      var events = readArray(eventsKey)
      events.append(event)
      writeArray(events, eventsKey)
      return finished
    }
  }

  /// 取消該單通知、結束對應的 Live Activity（找不到也算成功）。
  /// v0.3：由螢幕廣播偵測管理的卡（heartbeat 有值）不結束，改回「偵測中」待命，偵測程式下一張單還要用它。
  static func cleanup(activityId: String?, notifIds: [String]) async {
    if !notifIds.isEmpty {
      UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: notifIds)
    }
    guard let activityId = activityId else { return }
    for activity in Activity<PandaTimerAttributes>.activities where activity.id == activityId {
      var state = activity.content.state
      if state.heartbeat != nil {
        state.mode = "standby"
        state.diag = "已送達，回到偵測 · " + (state.diag ?? "")
        await activity.update(ActivityContent(state: state, staleDate: nil))
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }
}

/// 動態島展開版面 / 鎖定畫面的「送達」按鈕：結束「這張卡片」對應的那一單（以 activityId 對應）。
/// 不在捷徑 App 列出（isDiscoverable = false）；捷徑用的是 DeliveredIntent（最早一單）。
struct DeliverActivityIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "送達這一單"
  static let isDiscoverable: Bool = false
  static let openAppWhenRun: Bool = false

  @Parameter(title: "動態 ID")
  var activityId: String

  init() {}

  init(activityId: String) {
    self.activityId = activityId
  }

  func perform() async throws -> some IntentResult {
    let order = PandaSharedStore.finishOrder(activityId: activityId, at: Date())
    await PandaSharedStore.cleanup(activityId: activityId, notifIds: order?.notifIds ?? [])
    return .result()
  }
}
