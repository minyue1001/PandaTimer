import ActivityKit
import ExpoModulesCore
import Foundation

final class LiveActivityUnsupportedException: GenericException<String> {
  override var reason: String {
    "Live Activity 不可用：\(param)"
  }
}

final class LiveActivityStartException: GenericException<String> {
  override var reason: String {
    "Live Activity 啟動失敗：\(param)"
  }
}

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    // v0.4：extension → App 的 Darwin 訊號（新單/心跳/開始/停止/drain）轉成 JS 事件
    Events("onDetectorSignal")

    OnCreate {
      DetectorHub.shared.attach { [weak self] body in
        self?.sendEvent("onDetectorSignal", body)
      }
      DetectorHub.shared.registerIfNeeded()
    }

    OnAppBecomesActive {
      DetectorHub.shared.appBecameActive()
    }

    // 系統版本夠新、且使用者沒在設定裡關掉「即時動態」
    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    // 本地啟動 Live Activity（pushType: nil → 不需要 aps-environment）
    // 必須在 App 位於前景時呼叫，否則 ActivityKit 會拒絕。
    AsyncFunction("start") { (estimateMinutes: Double, deadlineMs: Double) throws -> String in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException("需要 iOS 16.2 以上")
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw LiveActivityUnsupportedException("設定 > 熊貓倒數 > 即時動態 已關閉")
      }
      let deadline = Date(timeIntervalSince1970: deadlineMs / 1000.0)
      let attributes = PandaTimerAttributes(acceptedAt: Date())
      let state = PandaTimerAttributes.ContentState(
        deadline: deadline,
        estimateMinutes: Int(estimateMinutes.rounded())
      )
      // staleDate = 截止時間：過了截止系統會重繪，widget 用 context.isStale 顯示「已超時」
      let content = ActivityContent(state: state, staleDate: deadline)
      do {
        let activity = try Activity<PandaTimerAttributes>.request(
          attributes: attributes,
          content: content,
          pushType: nil
        )
        return activity.id
      } catch {
        throw LiveActivityStartException(error.localizedDescription)
      }
    }.runOnQueue(.main)

    // 結束指定 id 的 Live Activity（找不到也算成功）。
    // v0.4：由偵測程式管理的卡（heartbeat 有值）不結束，改回「偵測中」待命（同 PandaSharedStore.cleanup）。
    AsyncFunction("end") { (id: String, promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      let targets = Activity<PandaTimerAttributes>.activities.filter { $0.id == id }
      Task {
        for activity in targets {
          var state = activity.content.state
          if state.heartbeat != nil {
            state.mode = "standby"
            state.diag = "已送達，回到偵測 · " + (state.diag ?? "")
            await activity.update(ActivityContent(state: state, staleDate: nil))
          } else {
            await activity.end(nil, dismissalPolicy: .immediate)
          }
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("endAll") { (promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      let targets = Activity<PandaTimerAttributes>.activities
      Task {
        for activity in targets {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        promise.resolve(nil)
      }
    }

    // 目前系統裡還活著的 activity id（App 重開後用來對帳）
    Function("activeIds") { () -> [String] in
      guard #available(iOS 16.2, *) else { return [] }
      return Activity<PandaTimerAttributes>.activities.map { $0.id }
    }

    // v0.3：每張卡的 id／mode／是否由螢幕廣播偵測管理（heartbeat 有值）。JSON 陣列字串。
    // 對帳時 detector == true 的卡一律保留（JS 不知道它們的存在，不能當孤兒結束）。
    Function("activitySummaries") { () -> String in
      guard #available(iOS 16.2, *) else { return "[]" }
      let list: [[String: Any]] = Activity<PandaTimerAttributes>.activities.map { activity -> [String: Any] in
        let state = activity.content.state
        let detector = state.heartbeat != nil || state.mode == "standby" || state.mode == "stopped"
        return ["id": activity.id, "mode": state.mode ?? "countdown", "detector": detector]
      }
      guard let data = try? JSONSerialization.data(withJSONObject: list, options: []),
            let text = String(data: data, encoding: .utf8)
      else { return "[]" }
      return text
    }

    // v0.3 螢幕廣播偵測：前景開一張「偵測待命」卡給 extension 找（已有偵測卡就沿用、只更新心跳）。
    AsyncFunction("startStandby") { () async throws -> String in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException("需要 iOS 16.2 以上")
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw LiveActivityUnsupportedException("設定 > 熊貓倒數 > 即時動態 已關閉")
      }
      let now = Date()
      let existing = Activity<PandaTimerAttributes>.activities.first { activity in
        let state = activity.content.state
        return activity.activityState == .active
          && (state.mode == "standby" || state.mode == "stopped" || state.heartbeat != nil)
      }
      if let activity = existing {
        var state = activity.content.state
        if state.mode == "stopped" { state.mode = "standby" }
        state.heartbeat = now
        state.diag = "App 已就緒，等待廣播…"
        let staleDate = state.mode == "countdown" ? activity.content.staleDate : nil
        await activity.update(ActivityContent(state: state, staleDate: staleDate))
        return activity.id
      }
      do {
        // 與 native/intents 的 IntentLiveActivity.start 同寫法：MainActor 上 request，只把 id（String）帶出來
        return try await MainActor.run { () throws -> String in
          let state = PandaTimerAttributes.ContentState(
            deadline: now, estimateMinutes: 0, mode: "standby", heartbeat: now, diag: "App 已就緒，等待廣播…")
          let activity = try Activity<PandaTimerAttributes>.request(
            attributes: PandaTimerAttributes(acceptedAt: now),
            content: ActivityContent(state: state, staleDate: nil),
            pushType: nil)
          return activity.id
        }
      } catch {
        throw LiveActivityStartException(error.localizedDescription)
      }
    }

    // v0.4：App「開始偵測」（前景）→ 背景音訊保活＋看門狗。回傳 detectorStatus 的 JSON。
    Function("armDetection") { () -> String in
      DetectorHub.shared.registerIfNeeded()
      DetectorHub.shared.arm()
      return DetectorHub.shared.statusJSON()
    }

    // v0.4：App「停止偵測」→ 停保活、偵測卡結束（倒數中的卡交還給那張單）
    AsyncFunction("stopDetection") { () async -> Void in
      await DetectorHub.shared.disarm()
    }

    // v0.4：偵測狀態 JSON（armed/keepAlive/lastBeatAt/lastOrderMinutes/lastOrderAt/lastOrderHow/autoCountSinceLaunch）
    Function("detectorStatus") { () -> String in
      return DetectorHub.shared.statusJSON()
    }

    // 系統「螢幕廣播」選擇器（RPSystemBroadcastPickerView）。JS 用 ref.show() 程式觸發，
    // 觸發不了（回傳 false）時使用者可直接點這個 view 本身。
    View(BroadcastPickerView.self) {
      AsyncFunction("show") { (view: BroadcastPickerView) -> Bool in
        return triggerBroadcastPicker(view)
      }.runOnQueue(.main)
    }

    // ── App Intents（主 App target，背景不跑 JS）↔ JS 的資料同步，全走 UserDefaults.standard ──
    // 鍵名/格式必須與 native/intents/DeliverActivityIntent.swift 的 PandaSharedStore 一致。
    // 鎖：objc_sync(UserDefaults.standard)，與主 target 那邊是同一個物件 → 同一把鎖。

    // 取走原生事件佇列（JSON 陣列字串）並清空。JS 必須在 reconcileActivities() 之前呼叫。
    Function("drainNativeEvents") { () -> String in
      let defaults = UserDefaults.standard
      objc_sync_enter(defaults)
      defer { objc_sync_exit(defaults) }
      let text = defaults.string(forKey: NativeSync.eventsKey) ?? "[]"
      defaults.removeObject(forKey: NativeSync.eventsKey)
      return text
    }

    // JS 每次訂單變動後覆寫「進行中訂單」鏡像（DeliveredIntent / 動態島送達按鈕以此挑單）。
    // 尚未被 JS 取走的原生事件要併進來：未取走的 start 補進鏡像、未取走的 done 從鏡像移除，
    // 避免 JS 用舊資料蓋掉原生剛開/剛結的單。
    Function("syncActiveOrders") { (json: String) -> Void in
      guard let data = json.data(using: .utf8),
            var list = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]]
      else { return }
      let defaults = UserDefaults.standard
      objc_sync_enter(defaults)
      defer { objc_sync_exit(defaults) }
      var known = Set(list.compactMap { $0["id"] as? String })
      var doneOrderIds = Set<String>()
      var doneActivityIds = Set<String>()
      for event in NativeSync.readArray(NativeSync.eventsKey) {
        let type = event["type"] as? String
        if type == "start", let id = event["id"] as? String, !known.contains(id) {
          var order = event
          order.removeValue(forKey: "type")
          list.append(order)
          known.insert(id)
        } else if type == "done" {
          if let orderId = event["orderId"] as? String {
            doneOrderIds.insert(orderId)
          } else if let activityId = event["activityId"] as? String {
            doneActivityIds.insert(activityId)
          }
        }
      }
      list.removeAll { item in
        if let id = item["id"] as? String, doneOrderIds.contains(id) { return true }
        if let aid = item["activityId"] as? String, doneActivityIds.contains(aid) { return true }
        return false
      }
      if let out = try? JSONSerialization.data(withJSONObject: list, options: []),
         let text = String(data: out, encoding: .utf8) {
        defaults.set(text, forKey: NativeSync.activeKey)
      }
    }
  }
}

enum NativeSync {
  static let eventsKey = "pandatimer.native.events.v1"
  static let activeKey = "pandatimer.native.activeOrders.v1"

  /// v0.4 自動偵測開單：與 PandaSharedStore.recordStart 同格式（start 事件＋進行中鏡像），同一把鎖。
  /// takesOverActivity：沿用偵測卡（同一張卡被改成新倒數）→ 鏡像裡其他單的同一 activityId 要拿掉，
  /// 否則動態島「送達」會結到舊單。JS 端 applyNativeEvents 也做同樣處理。
  static func recordStart(_ order: [String: Any], takesOverActivity: Bool) {
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    var event = order
    event["type"] = "start"
    var events = readArray(eventsKey)
    events.append(event)
    writeArray(events, eventsKey)
    var active = readArray(activeKey)
    if takesOverActivity, let aid = order["activityId"] as? String {
      active = active.map { item in
        guard (item["activityId"] as? String) == aid else { return item }
        var copy = item
        copy.removeValue(forKey: "activityId")
        return copy
      }
    }
    active.append(order)
    writeArray(active, activeKey)
  }

  static func writeArray(_ array: [[String: Any]], _ key: String) {
    guard let data = try? JSONSerialization.data(withJSONObject: array, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return }
    UserDefaults.standard.set(text, forKey: key)
  }

  static func readArray(_ key: String) -> [[String: Any]] {
    guard let text = UserDefaults.standard.string(forKey: key),
          let data = text.data(using: .utf8),
          let array = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]]
    else { return [] }
    return array
  }
}
