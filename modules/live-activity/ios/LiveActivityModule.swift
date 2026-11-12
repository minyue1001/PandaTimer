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

    OnAppEntersBackground {
      DetectorHub.shared.appEnteredBackground()
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

    // JS 送達/取消一單後呼叫（JS 已先把進行中鏡像同步成「不含這單」）。找不到也算成功。
    // v0.6（同 PandaSharedStore.cleanup → DetectorCardPlan.afterFinish）：這張卡上還掛著其他單 → 切到下一單；
    // 沒有了 → 偵測卡（heartbeat 有值）回「偵測中」待命，一般卡結束。
    AsyncFunction("end") { (id: String, promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      Task {
        await DetectorCardPlan.afterFinish(activityId: id, note: "已送達 \(DetectorCardPlan.clock(Date()))")
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
        let detector = state.heartbeat != nil || state.mode == "standby" || state.mode == "stopped" || state.mode == "offer"
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
        // v1.0：mode "offer" 的 staleDate＝偵測＋60 秒 → 過期後 activityState 是 .stale，也要沿用（不然會多開一張）
        return (activity.activityState == .active || activity.activityState == .stale)
          && (state.mode == "standby" || state.mode == "stopped" || state.mode == "offer" || state.heartbeat != nil)
      }
      if let activity = existing {
        var state = activity.content.state
        if state.mode == "stopped" || state.mode == "offer" { state.mode = "standby" }
        // v1.0：重新開始偵測 → 舊的「已偵測邀請」一律清掉
        state.offerMin = nil
        state.offerAmount = nil
        state.offerAt = nil
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

    // App「開始偵測」（前景）→ 保活（v0.5：背景定位優先、靜音音訊只當備援）＋看門狗。回傳 detectorStatus 的 JSON。
    Function("armDetection") { () -> String in
      DetectorHub.shared.registerIfNeeded()
      DetectorHub.shared.arm()
      return DetectorHub.shared.statusJSON()
    }

    // App「停止偵測」→ 停保活（定位＋音訊）、偵測卡結束（倒數中的卡交還給那張單）
    AsyncFunction("stopDetection") { () async -> Void in
      await DetectorHub.shared.disarm()
    }

    // 偵測狀態 JSON（armed/keepAlive/keepAliveMode/locationAuth/lastFixAt/islandCheck/lastBeatAt/lastOrder*/
    // autoCountSinceLaunch/telemetryLastOk/telemetryPending/telemetryError）
    Function("detectorStatus") { () -> String in
      return DetectorHub.shared.statusJSON()
    }

    // v0.6：JS 告訴原生回報要帶的情境（OTA 更新 id）。JSON 物件字串，例如 {"upd":"1a2b3c4d"}；只收白名單鍵。
    Function("setTelemetryContext") { (json: String) -> Void in
      guard let data = json.data(using: .utf8),
            let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
      else { return }
      DetectorHub.shared.setTelemetryContext(dict)
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
      // v0.7 自動送達互斥：鏡像裡原本有、JS 這次拿掉（App 內按送達/取消）、又不是原生剛結的 → 記為手動結單時間
      // （DetectorHub.AutoDelivery 90 秒內不自動結，避免先手動、後看到完成畫面又結掉下一單）
      let newIds = Set(list.compactMap { $0["id"] as? String })
      let removedByJS = NativeSync.readArray(NativeSync.activeKey).contains { item in
        guard let id = item["id"] as? String else { return false }
        return !newIds.contains(id) && !doneOrderIds.contains(id)
      }
      if removedByJS {
        defaults.set((Date().timeIntervalSince1970 * 1000).rounded(), forKey: "pandatimer.native.lastManualDoneAt.v1")
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

  /// 自動偵測開單：與 PandaSharedStore.recordStart 同格式（start 事件＋進行中鏡像），同一把鎖。
  /// v0.6：多張自動單可以共用同一張偵測卡（同一 activityId），不再把舊單的 activityId 拿掉（DetectorCardPlan）。
  static func recordStart(_ order: [String: Any]) {
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    var event = order
    event["type"] = "start"
    var events = readArray(eventsKey)
    events.append(event)
    writeArray(events, eventsKey)
    var active = readArray(activeKey)
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
