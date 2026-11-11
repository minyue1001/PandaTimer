import ActivityKit
import AVFoundation
import CoreLocation
import Foundation
import UIKit
import UserNotifications

// v0.4/v0.5：螢幕廣播 extension（PandaBroadcast）→ App 的訊號中樞。
// 實測（v0.3）：ActivityKit 在 broadcast extension 內完全不可用 → extension 只負責 OCR，
// 用 Darwin notification（跨程序、不需 App Group/entitlement）以「名稱」編碼資料通知 App：
//   com.pandatimer.order.<N>（N=1…90 分）、com.pandatimer.broadcast.started/.stopped/.heartbeat、
//   com.pandatimer.drain（App Intents 寫了事件佇列 → 請 JS drain）。
// ⚠️ 名稱與 targets/broadcast/SampleHandler.swift 的 Signal、src/detector.ts 的 parseSignalName 必須一致。
// App 端要活著才收得到 → 偵測期間保活，見 KeepAlive。
// v0.4 實測（iOS 26.6.2）：只靠靜音音訊保活時，背景的 Activity.update 全部無聲失效
//   （liveactivitiesd：「Process is only playing background media so is forbidden to update activity」）。
// v0.5：保活改用背景定位（音訊只當備援）；每次更新後回讀檢查；另有兩條一鍵備援：
//   ① 點「偵測到新單」通知 → App 進前景 → appBecameActive 把最新自動單的倒數推到動態島；
//   ② 偵測卡上的「開始倒數」按鈕（native/intents/StartDetectedCountdownIntent.swift，讀 LastAutoStore）。
final class DetectorHub {
  static let shared = DetectorHub()

  static let orderPrefix = "com.pandatimer.order."
  static let startedName = "com.pandatimer.broadcast.started"
  static let stoppedName = "com.pandatimer.broadcast.stopped"
  static let heartbeatName = "com.pandatimer.broadcast.heartbeat"
  static let drainName = "com.pandatimer.drain"
  static let maxMinutes = 90

  enum Signal {
    case order(Int)
    case started
    case stopped
    case heartbeat
    case drain
  }

  static func parse(_ name: String) -> Signal? {
    switch name {
    case startedName: return .started
    case stoppedName: return .stopped
    case heartbeatName: return .heartbeat
    case drainName: return .drain
    default: break
    }
    guard name.hasPrefix(orderPrefix) else { return nil }
    let rest = String(name.dropFirst(orderPrefix.count))
    guard !rest.isEmpty, !rest.hasPrefix("0"), rest.allSatisfy({ $0 >= "0" && $0 <= "9" }), let n = Int(rest),
          n >= 1, n <= maxMinutes
    else { return nil }
    return .order(n)
  }

  // MARK: - 狀態（只在 queue 上存取）

  private let queue = DispatchQueue(label: "com.pandatimer.detector.hub")
  let keepAlive = KeepAlive()
  private var registered = false
  private var emitter: (([String: Any?]) -> Void)?
  private var watchdog: DispatchSourceTimer?

  private var armed = false
  private var armedAt: Date?
  private var lastBeat: Date?
  private var lastTick = Date()
  private var lastOrderMinutes: Int?
  private var lastOrderAt: Date?
  private var lastOrderHow = ""
  private var islandCheck = ""
  private var autoCount = 0
  private var beatAlerted = false

  private let watchdogInterval = 30
  private let beatTimeout: TimeInterval = 150
  private let orderDedupe: TimeInterval = 90

  // MARK: - 對外（由 LiveActivityModule 呼叫）

  func attach(_ emit: @escaping ([String: Any?]) -> Void) {
    queue.async { self.emitter = emit }
  }

  /// 註冊 4 個狀態名稱＋90 個 order.N。Darwin 回呼在主執行緒，進來後一律轉到 queue。
  func registerIfNeeded() {
    DispatchQueue.main.async {
      guard !self.registeredOnMain else { return }
      self.registeredOnMain = true
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      let observer = Unmanaged.passUnretained(self).toOpaque()
      var names = [Self.startedName, Self.stoppedName, Self.heartbeatName, Self.drainName]
      for n in 1...Self.maxMinutes { names.append("\(Self.orderPrefix)\(n)") }
      for name in names {
        CFNotificationCenterAddObserver(
          center, observer,
          { _, _, cfName, _, _ in
            guard let raw = cfName?.rawValue else { return }
            DetectorHub.shared.receive(raw as String)
          },
          name as CFString, nil, .deliverImmediately)
      }
      self.queue.async { self.registered = true }
    }
  }
  private var registeredOnMain = false  // 只在主執行緒存取

  /// App「開始偵測」（前景）：開始保活（定位優先、音訊備援）＋看門狗
  func arm() {
    queue.async {
      self.armed = true
      self.armedAt = Date()
      self.beatAlerted = false
      self.keepAlive.start()
      self.startWatchdog()
    }
  }

  /// App「停止偵測」：停保活（定位＋音訊）；偵測卡若在倒數就交還給那張單（heartbeat=nil），否則結束
  func disarm() async {
    queue.sync {
      self.armed = false
      self.keepAlive.stop()
      self.stopWatchdog()
    }
    for activity in Activity<PandaTimerAttributes>.activities where Self.isDetectorCard(activity) {
      var state = activity.content.state
      if state.mode == "countdown" && state.deadline > Date() {
        state.heartbeat = nil
        state.diag = "偵測已停止（這張倒數保留）"
        await activity.update(ActivityContent(state: state, staleDate: state.deadline))
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  func statusJSON() -> String {
    let dict: [String: Any] = queue.sync {
      let keep = keepAlive.snapshot()
      var d: [String: Any] = [
        "registered": registered,
        "armed": armed,
        "keepAlive": keep.text,
        "keepAliveMode": keep.mode,
        "locationAuth": keep.locationAuth,
        "autoCountSinceLaunch": autoCount,
        "lastOrderHow": lastOrderHow,
        "islandCheck": islandCheck,
      ]
      if let b = lastBeat { d["lastBeatAt"] = Self.ms(b) }
      if let m = lastOrderMinutes { d["lastOrderMinutes"] = m }
      if let at = lastOrderAt { d["lastOrderAt"] = Self.ms(at) }
      if let e = keep.error { d["keepAliveError"] = e }
      if let fix = keep.lastFixAt { d["lastFixAt"] = Self.ms(fix) }
      return d
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  /// App 回到前景（含點「偵測到新單」通知打開 App）：
  /// 最新自動單還沒送達 → 把它的倒數強制推到動態島（背景更新可能被系統擋掉，前景一定可以）＋回讀檢查；
  /// 沒有待補的單 → 照舊只更新心跳/診斷字。不會重複記錄訂單（只改卡，不寫事件）。
  func appBecameActive() {
    queue.async {
      self.keepAlive.ensure()
      let tracking = self.armed || self.lastBeat != nil
      Task {
        if let check = await Self.restorePendingCountdown(reason: "回前景補推") {
          self.queue.async {
            self.islandCheck = check
            self.emit(["type": "restored", "how": check])
          }
        } else if tracking {
          self.queue.async { self.pushCard(note: nil) }
        }
      }
    }
  }

  // MARK: - 訊號處理

  private func receive(_ name: String) {
    guard let signal = Self.parse(name) else { return }
    queue.async { self.handle(signal) }
  }

  private func handle(_ signal: Signal) {
    let now = Date()
    switch signal {
    case .started:
      lastBeat = now
      beatAlerted = false
      if !armed {
        // 使用者從控制中心直接開廣播、App 剛好還活著：試著保活（背景啟動定位/音訊可能被拒，結果寫進狀態）
        armed = true
        armedAt = now
        keepAlive.start()
        startWatchdog()
      }
      pushCard(note: "偵測已啟動")
      emit(["type": "started"])
    case .heartbeat:
      lastBeat = now
      beatAlerted = false
      pushCard(note: nil)
      emit(["type": "heartbeat"])
    case .stopped:
      lastBeat = now
      armed = false
      keepAlive.stop()
      stopWatchdog()
      pushCard(note: "偵測已停止 \(Self.hms(now))", stopping: true)
      emit(["type": "stopped"])
    case .drain:
      emit(["type": "drain"])
    case .order(let minutes):
      handleOrder(minutes, at: now)
    }
  }

  private func handleOrder(_ minutes: Int, at now: Date) {
    if let m = lastOrderMinutes, m == minutes, let at = lastOrderAt, now.timeIntervalSince(at) < orderDedupe {
      return
    }
    // 看門狗每 30 秒走一次；隔太久沒走＝App 曾被暫停，這個訊號可能是恢復後才送達（時間偏晚）
    let wasSuspended = watchdog != nil && now.timeIntervalSince(lastTick) > Double(watchdogInterval) * 1.5 + 5
    lastOrderMinutes = minutes
    lastOrderAt = now
    autoCount += 1
    lastOrderHow = "處理中…"
    let beat = lastBeat ?? now
    let diag = diagText(note: "自動新單 \(minutes) 分")
    let orderId = "\(Int64(Self.ms(now)))-a\(UUID().uuidString.prefix(4).lowercased())"
    // 收到訊號就先寫「最近一次自動偵測」：動態島「開始倒數」按鈕與回前景補推都讀這個
    LastAutoStore.write(.init(
      orderId: orderId, minutes: minutes, detectedAt: now,
      deadline: now.addingTimeInterval(Double(minutes) * 60), activityId: nil))

    Task {
      // App 曾被暫停 → 用 extension 那則「偵測到新單」通知裡的偵測時間（找不到就用收到訊號的時間）
      var acceptedAt = now
      var timeNote = ""
      if wasSuspended {
        if let t = await DetectorNotify.detectedAt(minutes: minutes, notAfter: now) {
          acceptedAt = t
          timeNote = "（App 曾被暫停，接單時間已改用偵測通知的 \(Self.hms(t))）"
        } else {
          timeNote = "（⚠️ App 曾被暫停，接單時間可能偏晚）"
        }
      }
      let deadline = acceptedAt.addingTimeInterval(Double(minutes) * 60)
      let outcome = await Self.openOrderCard(
        minutes: minutes, acceptedAt: acceptedAt, deadline: deadline, beat: beat, diag: diag)
      let notifIds = await DetectorReminders.schedule(deadline: deadline, estimateMin: minutes)
      let acceptedMs = Self.ms(acceptedAt)
      var order: [String: Any] = [
        "id": orderId,
        "acceptedAt": acceptedMs,
        "estimateMin": minutes,
        "deadline": Self.ms(deadline),
        "notifIds": notifIds,
        "source": "auto",
      ]
      if let aid = outcome.activityId { order["activityId"] = aid }
      NativeSync.recordStart(order, takesOverActivity: outcome.reusedDetectorCard)
      LastAutoStore.write(.init(
        orderId: orderId, minutes: minutes, detectedAt: acceptedAt, deadline: deadline,
        activityId: outcome.activityId))
      // 更新是否真的生效：1 秒後重新從 Activity.activities 讀同 id 的 content.state 比對
      let check = await Self.verifyCountdown(activityId: outcome.activityId, deadline: deadline)
      let how = outcome.text + timeNote
      self.queue.async {
        self.lastOrderHow = how
        self.islandCheck = check
        self.emit(["type": "order", "minutes": minutes, "how": how, "check": check])
      }
      await DetectorNotify.post(
        title: "App 已記錄自動新單：\(minutes) 分",
        body: "\(check)\n\(how)\n動態島沒變的話：點「偵測到新單」通知打開 App，或長按動態島按「開始倒數」",
        passive: true)
    }
  }

  // MARK: - 動態島

  struct OrderCardOutcome {
    let activityId: String?
    let reusedDetectorCard: Bool
    let text: String
  }

  /// 先試背景開新倒數卡（官方文件：只有前景/LiveActivityIntent 能開，預期會被拒），
  /// 失敗就把偵測卡改成倒數（疊單時前一張自動單的倒數會被覆蓋）。
  static func openOrderCard(
    minutes: Int, acceptedAt: Date, deadline: Date, beat: Date, diag: String
  ) async -> OrderCardOutcome {
    let requestError: String
    do {
      let id = try await MainActor.run { () throws -> String in
        let state = PandaTimerAttributes.ContentState(
          deadline: deadline, estimateMinutes: minutes, mode: "countdown", heartbeat: nil,
          diag: "自動偵測 \(hm(acceptedAt))")
        let activity = try Activity<PandaTimerAttributes>.request(
          attributes: PandaTimerAttributes(acceptedAt: acceptedAt),
          content: ActivityContent(state: state, staleDate: deadline),
          pushType: nil)
        return activity.id
      }
      return OrderCardOutcome(activityId: id, reusedDetectorCard: false, text: "新開倒數卡成功")
    } catch {
      requestError = error.localizedDescription
    }
    guard let card = detectorCard() else {
      return OrderCardOutcome(
        activityId: nil, reusedDetectorCard: false,
        text: "開新卡被拒（\(requestError)），也找不到偵測卡 → 只記錄＋提醒通知")
    }
    let old = card.content.state
    let overwrote = old.mode == "countdown" && old.deadline > Date()
    var state = old
    state.mode = "countdown"
    state.deadline = deadline
    state.estimateMinutes = minutes
    state.heartbeat = beat
    state.diag = diag
    await card.update(ActivityContent(state: state, staleDate: deadline))
    return OrderCardOutcome(
      activityId: card.id, reusedDetectorCard: true,
      text: "開新卡被拒（\(requestError)），已把偵測卡改成 \(minutes) 分倒數"
        + (overwrote ? "（疊單：前一張自動單的倒數被覆蓋）" : ""))
  }

  /// 更新後 1 秒回讀：同 id 的卡 content.state 是否為新的倒數（mode/deadline）。
  /// ⚠️ 讀到的是本程序 ActivityKit 的狀態；若系統（liveactivitiesd）拒絕但本地狀態已改，這裡仍會是 ✓ —
  /// 所以通知/App 上的 ✓ 只代表「本地已改」，真正以動態島畫面為準（✗ 則一定沒更新成功）。
  static func verifyCountdown(activityId: String?, deadline: Date) async -> String {
    let place = await appStateText()
    guard let id = activityId else { return "動態島：沒有卡可更新✗（\(place)）" }
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    guard let activity = Activity<PandaTimerAttributes>.activities.first(where: { $0.id == id }) else {
      return "動態島：卡不見了✗（\(place)）"
    }
    let state = activity.content.state
    let ok = activity.activityState == .active
      && (state.mode ?? "countdown") == "countdown"
      && abs(state.deadline.timeIntervalSince(deadline)) < 1
    return ok ? "動態島：已更新✓（\(place)）" : "動態島：疑似被系統擋✗（\(place)）"
  }

  static func appStateText() async -> String {
    await MainActor.run { () -> String in
      switch UIApplication.shared.applicationState {
      case .active: return "前景"
      case .inactive: return "前景切換中"
      default: return "背景"
      }
    }
  }

  /// 最新自動單（LastAutoStore）還在進行中 → 把它的倒數推到卡上（優先該單的卡，否則偵測卡），回傳回讀結果。
  /// 沒有待補的單回 nil。只改動態島，不寫訂單事件（不會重複記錄）。
  static func restorePendingCountdown(reason: String) async -> String? {
    let now = Date()
    guard let record = LastAutoStore.read(), LastAutoStore.isOrderActive(record, now: now),
          now < record.deadline.addingTimeInterval(60 * 60)
    else { return nil }
    let alive = Activity<PandaTimerAttributes>.activities.filter {
      $0.activityState != .ended && $0.activityState != .dismissed
    }
    let card: Activity<PandaTimerAttributes>?
    if let aid = record.activityId {
      card = alive.first { $0.id == aid }
    } else {
      card = detectorCard()
    }
    guard let activity = card else { return nil }
    var state = activity.content.state
    state.mode = "countdown"
    state.deadline = record.deadline
    state.estimateMinutes = record.minutes
    state.diag = "\(reason) \(hms(now)) · 自動新單 \(record.minutes) 分 @\(hm(record.detectedAt))"
    await activity.update(ActivityContent(state: state, staleDate: record.deadline))
    return await verifyCountdown(activityId: activity.id, deadline: record.deadline)
  }

  static func isDetectorCard(_ activity: Activity<PandaTimerAttributes>) -> Bool {
    guard activity.activityState != .ended && activity.activityState != .dismissed else { return false }
    let state = activity.content.state
    return state.mode == "standby" || state.mode == "stopped" || state.heartbeat != nil
  }

  static func detectorCard() -> Activity<PandaTimerAttributes>? {
    let all = Activity<PandaTimerAttributes>.activities.filter(isDetectorCard)
    return all.first { $0.content.state.mode == "standby" }
      ?? all.first { $0.content.state.mode == "stopped" }
      ?? all.first
  }

  /// 只更新心跳與診斷字（倒數內容不動）。stopping：非倒數中的卡改成「偵測已停止」。
  private func pushCard(note: String?, stopping: Bool = false) {
    let text = diagText(note: note)
    let beat = lastBeat ?? Date()
    Task {
      guard let activity = Self.detectorCard() else { return }
      let current = activity.content
      var state = current.state
      let counting = state.mode == "countdown" && state.deadline > Date()
      if stopping {
        if !counting { state.mode = "stopped" }
      } else if state.mode == "stopped" {
        state.mode = "standby"
      }
      state.heartbeat = beat
      state.diag = text
      let staleDate = state.mode == "countdown" ? current.staleDate : nil
      await activity.update(ActivityContent(state: state, staleDate: staleDate))
    }
  }

  private func diagText(note: String?) -> String {
    var parts: [String] = []
    if let note = note { parts.append(note) }
    if let beat = lastBeat {
      parts.append("App 已收到心跳 \(Self.hms(beat))")
    } else {
      parts.append("App 尚未收到心跳")
    }
    parts.append("保活:\(keepAlive.snapshot().text)")
    if let m = lastOrderMinutes, let at = lastOrderAt {
      parts.append("最近新單:\(m)分 \(Self.hm(at))")
    }
    return parts.joined(separator: " · ")
  }

  // MARK: - 看門狗（30 秒）：記錄「App 還活著」、補播備援音訊、心跳逾時警告

  private func startWatchdog() {
    guard watchdog == nil else { return }
    lastTick = Date()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(
      deadline: .now() + .seconds(watchdogInterval), repeating: .seconds(watchdogInterval), leeway: .seconds(3))
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    watchdog = timer
  }

  private func stopWatchdog() {
    watchdog?.cancel()
    watchdog = nil
  }

  private func tick() {
    let now = Date()
    lastTick = now
    guard armed else { return }
    keepAlive.ensure()
    let since = lastBeat ?? armedAt ?? now
    let gap = now.timeIntervalSince(since)
    if gap > beatTimeout && !beatAlerted {
      beatAlerted = true
      let minutes = Int((gap / 60).rounded())
      let note = lastBeat == nil ? "⚠️ 還沒收到偵測訊號（廣播沒開始？）" : "⚠️ \(minutes) 分鐘沒收到偵測心跳"
      pushCard(note: note)
      emit(["type": "beatTimeout"])
      let body = "\(note)。偵測可能已被系統關掉，請重新開始偵測。"
      Task {
        await DetectorNotify.post(title: "🐼 偵測沒有回應", body: body, passive: false)
      }
    }
  }

  private func emit(_ body: [String: Any?]) {
    guard let emitter = emitter else { return }
    DispatchQueue.main.async { emitter(body) }
  }

  // MARK: - 工具

  static func ms(_ date: Date) -> Double {
    (date.timeIntervalSince1970 * 1000).rounded()
  }

  private static let hmsFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm:ss"
    return f
  }()

  private static let hmFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm"
    return f
  }()

  static func hms(_ date: Date) -> String { hmsFormatter.string(from: date) }
  static func hm(_ date: Date) -> String { hmFormatter.string(from: date) }
}

// MARK: - 最近一次自動偵測（UserDefaults.standard，主 App 程序內共用）
// ⚠️ 鍵名與 JSON 格式和 native/intents/StartDetectedCountdownIntent.swift 的 DetectedCountdownStore 一致
//    （test/detector.test.mjs 會比對鍵名字串）。
//   {"orderId":String,"minutes":Int,"detectedAt":ms,"deadline":ms,"activityId"?:String}

enum LastAutoStore {
  static let key = "pandatimer.detector.lastAuto.v1"
  /// 訂單剛偵測到、還沒寫進進行中鏡像的寬限時間
  static let recordingGrace: TimeInterval = 30

  struct Record {
    let orderId: String
    let minutes: Int
    let detectedAt: Date
    let deadline: Date
    let activityId: String?
  }

  static func write(_ record: Record) {
    var dict: [String: Any] = [
      "orderId": record.orderId,
      "minutes": record.minutes,
      "detectedAt": DetectorHub.ms(record.detectedAt),
      "deadline": DetectorHub.ms(record.deadline),
    ]
    if let aid = record.activityId { dict["activityId"] = aid }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return }
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    defaults.set(text, forKey: key)
  }

  static func read() -> Record? {
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    guard let text = defaults.string(forKey: key), let data = text.data(using: .utf8),
          let dict = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any],
          let orderId = dict["orderId"] as? String,
          let minutes = (dict["minutes"] as? NSNumber)?.intValue,
          let detectedMs = (dict["detectedAt"] as? NSNumber)?.doubleValue,
          let deadlineMs = (dict["deadline"] as? NSNumber)?.doubleValue
    else { return nil }
    return Record(
      orderId: orderId, minutes: minutes,
      detectedAt: Date(timeIntervalSince1970: detectedMs / 1000),
      deadline: Date(timeIntervalSince1970: deadlineMs / 1000),
      activityId: dict["activityId"] as? String)
  }

  /// 該單仍在進行中：進行中鏡像有它的 id，或剛偵測到（寬限內，記錄還在路上）
  static func isOrderActive(_ record: Record, now: Date) -> Bool {
    if now.timeIntervalSince(record.detectedAt) < recordingGrace { return true }
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    return NativeSync.readArray(NativeSync.activeKey).contains { ($0["id"] as? String) == record.orderId }
  }
}

// MARK: - 保活（v0.5）：背景定位優先；定位授權被拒或定位失敗才用靜音音訊備援
// 定位正常時不播音訊，避免程序被判成「只播背景媒體」而不准更新動態島。
// CLLocationManager 只在主執行緒建立/存取（delegate 回呼也在主執行緒）。

final class KeepAlive: NSObject, CLLocationManagerDelegate {
  struct Snapshot {
    let wanted: Bool
    /// none / auth（等授權）/ location / audio（備援）
    let mode: String
    let audio: AudioKeepAlive.Snapshot
    let locationAuth: String
    let lastFixAt: Date?
    let error: String?

    var text: String {
      guard wanted else { return "無" }
      switch mode {
      case "location": return "定位中"
      case "auth": return "等待定位授權"
      case "audio":
        if audio.playing { return "音訊中(備援)" }
        return audio.interrupted ? "音訊備援中斷" : "音訊備援失敗"
      default: return "無"
      }
    }
  }

  private let audio = AudioKeepAlive()
  private let lock = NSLock()
  private struct Published {
    var wanted = false
    var mode = "none"
    var auth = "unknown"
    var fix: Date?
    var error: String?
  }
  private var published = Published()

  // 只在主執行緒存取
  private var manager: CLLocationManager?
  private var backgroundSession: AnyObject?  // iOS 17 CLBackgroundActivitySession
  private var wanted = false
  private var mode = "none"
  private var fallbackReason: String?  // "denied" | "failed"
  private var locationError: String?
  private(set) var lastLocation: CLLocation?  // 以後做到點提醒用；本版只存記憶體

  func snapshot() -> Snapshot {
    lock.lock()
    let p = published
    lock.unlock()
    let audioSnap = audio.snapshot()
    var error = p.error
    if p.mode == "audio", let e = audioSnap.error { error = (error.map { $0 + "；" } ?? "") + "音訊：\(e)" }
    return Snapshot(
      wanted: p.wanted, mode: p.mode, audio: audioSnap, locationAuth: p.auth, lastFixAt: p.fix, error: error)
  }

  func start() {
    onMain {
      self.wanted = true
      self.setupManager()
      self.apply()
    }
  }

  func stop() {
    onMain {
      self.wanted = false
      self.manager?.stopUpdatingLocation()
      self.invalidateBackgroundSession()
      self.audio.stop()
      self.mode = "none"
      self.fallbackReason = nil
      self.locationError = nil
      self.publish()
    }
  }

  /// 看門狗/回前景：備援音訊被中斷就補播；定位模式不用動
  func ensure() {
    onMain {
      guard self.wanted else { return }
      if self.mode == "audio" { self.audio.ensurePlaying() }
    }
  }

  private func onMain(_ work: @escaping () -> Void) {
    if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
  }

  private func setupManager() {
    guard manager == nil else { return }
    let m = CLLocationManager()
    m.delegate = self
    m.desiredAccuracy = kCLLocationAccuracyHundredMeters
    m.distanceFilter = 50
    m.activityType = .otherNavigation
    m.pausesLocationUpdatesAutomatically = false
    m.showsBackgroundLocationIndicator = true
    manager = m
  }

  private func apply() {
    guard wanted, let m = manager else {
      publish()
      return
    }
    switch m.authorizationStatus {
    case .notDetermined:
      mode = "auth"
      m.requestWhenInUseAuthorization()
    case .authorizedWhenInUse, .authorizedAlways:
      // 需要 Info.plist UIBackgroundModes 含 location（不是 entitlement），否則這行會 assert
      m.allowsBackgroundLocationUpdates = true
      if #available(iOS 17.0, *), backgroundSession == nil {
        backgroundSession = CLBackgroundActivitySession()
      }
      m.startUpdatingLocation()
      if !(mode == "audio" && fallbackReason == "failed") {
        // 授權 OK（或剛從「被拒」改成允許）→ 定位保活，停掉音訊
        mode = "location"
        fallbackReason = nil
        locationError = nil
        audio.stop()
      }
    case .denied, .restricted:
      fallback("denied", "定位權限被拒（設定›熊貓倒數›位置 選「使用 App 期間」）")
    @unknown default:
      fallback("denied", "定位授權狀態未知")
    }
    publish()
  }

  private func fallback(_ reason: String, _ message: String) {
    guard wanted else { return }
    if reason == "denied" {
      manager?.stopUpdatingLocation()
      invalidateBackgroundSession()
    }
    mode = "audio"
    fallbackReason = reason
    locationError = message
    audio.start()
  }

  private func invalidateBackgroundSession() {
    if #available(iOS 17.0, *), let session = backgroundSession as? CLBackgroundActivitySession {
      session.invalidate()
    }
    backgroundSession = nil
  }

  private func publish() {
    let auth = manager.map { Self.authText($0.authorizationStatus) } ?? "unknown"
    let next = Published(
      wanted: wanted, mode: wanted ? mode : "none", auth: auth, fix: lastLocation?.timestamp, error: locationError)
    lock.lock()
    published = next
    lock.unlock()
  }

  private static func authText(_ status: CLAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "notDetermined"
    case .authorizedWhenInUse: return "whenInUse"
    case .authorizedAlways: return "always"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
  }

  // MARK: CLLocationManagerDelegate（主執行緒）

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    onMain { self.apply() }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    onMain {
      if let last = locations.last { self.lastLocation = last }
      if self.wanted && self.mode == "audio" && self.fallbackReason == "failed" {
        // 定位恢復 → 回到定位保活、停備援音訊
        self.mode = "location"
        self.fallbackReason = nil
        self.locationError = nil
        self.audio.stop()
      }
      self.publish()
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    let code = (error as? CLError)?.code
    onMain {
      if code == .locationUnknown { return }  // 暫時拿不到位置，系統會繼續試
      if code == .denied {
        self.fallback("denied", "定位權限被拒（設定›熊貓倒數›位置 選「使用 App 期間」）")
      } else {
        self.fallback("failed", "定位失敗：\(error.localizedDescription)")
      }
      self.publish()
    }
  }
}

// MARK: - 備援：背景音訊保活（靜音、可與其他 App 混音，不打斷 pandarider 提示音或使用者音樂）

final class AudioKeepAlive {
  struct Snapshot {
    let wanted: Bool
    let playing: Bool
    let interrupted: Bool
    let error: String?
  }

  private let q = DispatchQueue(label: "com.pandatimer.detector.keepalive")
  private let lock = NSLock()
  private var state = Snapshot(wanted: false, playing: false, interrupted: false, error: nil)
  // 只在 q 上存取
  private var player: AVAudioPlayer?
  private var wanted = false
  private var interrupted = false
  private var lastError: String?
  private var observers: [NSObjectProtocol] = []

  init() {
    let center = NotificationCenter.default
    observers.append(
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) {
        [weak self] note in
        let raw = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
        let type = raw.flatMap { AVAudioSession.InterruptionType(rawValue: $0) }
        self?.q.async {
          guard let self = self else { return }
          if type == .began {
            self.interrupted = true
            self.publish()
          } else if type == .ended {
            // mixable session 不一定收得到 ended（Apple 論壇：不保證），所以看門狗/回前景也會補播
            self.interrupted = false
            self.activate()
          }
        }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.q.async { self?.activateIfStopped() }
      })
    observers.append(
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: nil) {
        [weak self] _ in
        self?.q.async {
          self?.player = nil
          self?.activate()
        }
      })
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return state
  }

  func start() {
    q.async {
      self.wanted = true
      self.activate()
    }
  }

  func stop() {
    q.async {
      let had = self.wanted || self.player != nil
      self.wanted = false
      self.interrupted = false
      self.player?.stop()
      self.player = nil
      if had {
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
      }
      self.publish()
    }
  }

  func ensurePlaying() {
    q.async { self.activateIfStopped() }
  }

  private func activateIfStopped() {
    guard wanted, player?.isPlaying != true else { return }
    activate()
  }

  private func activate() {
    guard wanted else {
      publish()
      return
    }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
      try session.setActive(true)
      if player == nil {
        let p = try AVAudioPlayer(data: Self.silentWav())
        p.numberOfLoops = -1
        p.prepareToPlay()
        player = p
      }
      if player?.isPlaying != true, player?.play() != true {
        throw NSError(domain: "PandaKeepAlive", code: 1, userInfo: [NSLocalizedDescriptionKey: "play() 失敗"])
      }
      interrupted = false
      lastError = nil
    } catch {
      lastError = error.localizedDescription
    }
    publish()
  }

  private func publish() {
    let snap = Snapshot(
      wanted: wanted, playing: player?.isPlaying == true, interrupted: interrupted, error: lastError)
    lock.lock()
    state = snap
    lock.unlock()
  }

  /// 1 秒、8kHz、16-bit 單聲道、全 0 樣本的 WAV（程式產生，不用額外音檔）
  static func silentWav(seconds: Double = 1, sampleRate: Int = 8000) -> Data {
    let samples = Int(Double(sampleRate) * seconds)
    let dataSize = samples * 2
    var d = Data()
    func ascii(_ s: String) { d.append(contentsOf: Array(s.utf8)) }
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    ascii("RIFF")
    u32(UInt32(36 + dataSize))
    ascii("WAVE")
    ascii("fmt ")
    u32(16)
    u16(1)  // PCM
    u16(1)  // mono
    u32(UInt32(sampleRate))
    u32(UInt32(sampleRate * 2))
    u16(2)
    u16(16)
    ascii("data")
    u32(UInt32(dataSize))
    d.append(Data(count: dataSize))
    return d
  }
}

// MARK: - 通知（不用 timeSensitive/critical：需要 entitlement）

enum DetectorNotify {
  static func post(title: String, body: String, passive: Bool) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = nil
    content.interruptionLevel = passive ? .passive : .active
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }

  /// extension 發的「偵測到新單」通知（userInfo pandatimer=detected）裡的偵測時間：
  /// 同分鐘數、在 notAfter 之前 10 分鐘內的最新一則。找不到回 nil。
  static func detectedAt(minutes: Int, notAfter: Date) async -> Date? {
    let delivered = await UNUserNotificationCenter.current().deliveredNotifications()
    var best: Date?
    for notification in delivered {
      let info = notification.request.content.userInfo
      guard (info["pandatimer"] as? String) == "detected",
            (info["minutes"] as? NSNumber)?.intValue == minutes,
            let ms = (info["detectedAt"] as? NSNumber)?.doubleValue
      else { continue }
      let t = Date(timeIntervalSince1970: ms / 1000)
      guard t <= notAfter.addingTimeInterval(5), notAfter.timeIntervalSince(t) < 600 else { continue }
      if best.map({ t > $0 }) ?? true { best = t }
    }
    return best
  }
}

/// 截止前 3 分與截止各一則（文字與 src/notify.ts、native/intents 的 IntentReminders 相同）
enum DetectorReminders {
  static func schedule(deadline: Date, estimateMin: Int) async -> [String] {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    switch settings.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      break
    default:
      return []
    }
    let plans: [(Date, String, String)] = [
      (deadline.addingTimeInterval(-3 * 60), "🐼 剩 3 分鐘", "預估 \(estimateMin) 分的單快到了，加油！"),
      (deadline, "🐼 已到預估時間", "預估 \(estimateMin) 分的單已到時，現在開始算超時"),
    ]
    var ids: [String] = []
    for (when, title, body) in plans {
      let interval = when.timeIntervalSinceNow
      if interval <= 1 { continue }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = body
      content.sound = .default
      let request = UNNotificationRequest(
        identifier: UUID().uuidString, content: content,
        trigger: UNTimeIntervalNotificationTrigger(timeInterval: interval, repeats: false))
      do {
        try await center.add(request)
        ids.append(request.identifier)
      } catch {
        continue
      }
    }
    return ids
  }
}
