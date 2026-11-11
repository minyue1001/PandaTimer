import ActivityKit
import AVFoundation
import Foundation
import UserNotifications

// v0.4：螢幕廣播 extension（PandaBroadcast）→ App 的訊號中樞。
// 實測（v0.3）：ActivityKit 在 broadcast extension 內完全不可用 → extension 只負責 OCR，
// 用 Darwin notification（跨程序、不需 App Group/entitlement）以「名稱」編碼資料通知 App：
//   com.pandatimer.order.<N>（N=1…90 分）、com.pandatimer.broadcast.started/.stopped/.heartbeat、
//   com.pandatimer.drain（App Intents 寫了事件佇列 → 請 JS drain）。
// ⚠️ 名稱與 targets/broadcast/SampleHandler.swift 的 Signal、src/detector.ts 的 parseSignalName 必須一致。
// App 端要活著才收得到 → 偵測期間用背景音訊（靜音、mixWithOthers）保活，見 KeepAlive。
// 動態島與訂單紀錄都在原生端完成（不依賴 JS 是否在跑）：開卡/改卡 → 排 2 則提醒 → 寫 start 事件進
// UserDefaults 佇列（與 App Intents 同格式）→ 發事件叫 JS drain。
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

  /// App「開始偵測」（前景）：開始音訊保活＋看門狗
  func arm() {
    queue.async {
      self.armed = true
      self.armedAt = Date()
      self.beatAlerted = false
      self.keepAlive.start()
      self.startWatchdog()
    }
  }

  /// App「停止偵測」：停保活；偵測卡若在倒數就交還給那張單（heartbeat=nil），否則結束
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
      var d: [String: Any] = [
        "registered": registered,
        "armed": armed,
        "keepAlive": keepAlive.snapshot().text,
        "autoCountSinceLaunch": autoCount,
        "lastOrderHow": lastOrderHow,
      ]
      if let b = lastBeat { d["lastBeatAt"] = Self.ms(b) }
      if let m = lastOrderMinutes { d["lastOrderMinutes"] = m }
      if let at = lastOrderAt { d["lastOrderAt"] = Self.ms(at) }
      if let e = keepAlive.snapshot().error { d["keepAliveError"] = e }
      return d
    }
    guard let data = try? JSONSerialization.data(withJSONObject: dict, options: []),
          let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  /// App 回到前景：補一次偵測卡（背景更新可能被系統擋掉）、確認保活仍在播
  func appBecameActive() {
    queue.async {
      self.keepAlive.ensurePlaying()
      if self.armed || self.lastBeat != nil { self.pushCard(note: nil) }
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
        // 使用者從控制中心直接開廣播、App 剛好還活著：試著保活（背景啟動音訊可能被拒，失敗寫進狀態）
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
    let deadline = now.addingTimeInterval(Double(minutes) * 60)
    let beat = lastBeat ?? now
    let diag = diagText(note: "自動新單 \(minutes) 分")

    Task {
      let outcome = await Self.openOrderCard(
        minutes: minutes, acceptedAt: now, deadline: deadline, beat: beat, diag: diag)
      let notifIds = await DetectorReminders.schedule(deadline: deadline, estimateMin: minutes)
      let acceptedMs = Self.ms(now)
      var order: [String: Any] = [
        "id": "\(Int64(acceptedMs))-a\(UUID().uuidString.prefix(4).lowercased())",
        "acceptedAt": acceptedMs,
        "estimateMin": minutes,
        "deadline": Self.ms(deadline),
        "notifIds": notifIds,
        "source": "auto",
      ]
      if let aid = outcome.activityId { order["activityId"] = aid }
      NativeSync.recordStart(order, takesOverActivity: outcome.reusedDetectorCard)
      let how = outcome.text + (wasSuspended ? "（⚠️ App 曾被暫停，接單時間可能偏晚）" : "")
      self.queue.async {
        self.lastOrderHow = how
        self.emit(["type": "order", "minutes": minutes, "how": how])
      }
      await DetectorNotify.post(
        title: "App 已記錄自動新單：\(minutes) 分", body: how, passive: true)
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
      return OrderCardOutcome(activityId: id, reusedDetectorCard: false, text: "動態島：背景新開倒數卡成功")
    } catch {
      requestError = error.localizedDescription
    }
    guard let card = detectorCard() else {
      return OrderCardOutcome(
        activityId: nil, reusedDetectorCard: false,
        text: "動態島：背景開卡被拒（\(requestError)），也找不到偵測卡 → 只記錄＋提醒通知")
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
      text: "動態島：背景開新卡被拒（\(requestError)），已把偵測卡改成 \(minutes) 分倒數"
        + (overwrote ? "（疊單：前一張自動單的倒數被覆蓋）" : "")
        + "；若動態島沒變＝系統擋了背景更新")
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

  // MARK: - 看門狗（30 秒）：記錄「App 還活著」、補播保活、心跳逾時警告

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
    keepAlive.ensurePlaying()
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

// MARK: - 背景音訊保活（靜音、可與其他 App 混音，不打斷 pandarider 提示音或使用者音樂）

final class KeepAlive {
  struct Snapshot {
    let wanted: Bool
    let playing: Bool
    let interrupted: Bool
    let error: String?

    var text: String {
      if !wanted { return "未保活" }
      if interrupted { return "中斷" }
      if playing { return "音訊中" }
      return error == nil ? "未播放" : "失敗"
    }
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
      self.wanted = false
      self.interrupted = false
      self.player?.stop()
      self.player = nil
      try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
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
