import Foundation

// ⚠️ 這個檔案有兩份，必須逐字相同（CI diff 擋）：
//   modules/live-activity/ios/PandaTelemetry.swift（主 App 程序，source "app"）
//   targets/broadcast/PandaTelemetry.swift（螢幕廣播 extension，source "ext"）
// v0.6 遠端狀態回報：POST <PandaTelemetryURL>（server/index.mjs 的 /api/telemetry），header x-pt-key，body JSON 陣列。
// 設定來源：主 App Info.plist 的 PandaTelemetryKey / PandaTelemetryURL / PandaRuntimeVersion
//   （plugins/withTelemetry.js 在 prebuild 時由 app.json extra 寫入）；extension 讀「所屬 App」的 Info.plist
//   （PlugIns/PandaBroadcast.appex 往上兩層）。缺設定 → 停用，只記在 snapshot。
// 隱私鐵律：不得上傳 OCR 原文、地址、店名、顧客資訊。呼叫端只能傳結構化欄位；這裡再擋一次：
//   只收 allowedKeys（伺服器 server/index.mjs 的 FIELD_RULES 也只收同一批）、字串截 80 字、kw 只收 ≤12 字的字串陣列。
// 批次＋節流：累積 10 筆或每 30 秒送一次；urgent（新單/錯誤）立即送；失敗留在記憶體最多 200 筆（丟最舊）；
// 每分鐘最多記 100 筆（伺服器上限 120），超過的非 urgent 事件直接丟（計入 dropped）。全部在自己的 queue 上跑，不阻塞偵測。
final class PandaTelemetry {
  struct Snapshot {
    let enabled: Bool
    let lastOk: Date?
    let lastError: String?
    let pending: Int
    let sent: Int
    let dropped: Int
  }

  static let maxBuffer = 200
  static let batchSize = 10
  static let maxPerPost = 50
  static let flushInterval = 30
  static let maxPerMinute = 100

  /// ⚠️ 與 server/index.mjs 的 FIELD_RULES 鍵名一致（test/telemetry.test.mjs 比對）
  static let allowedKeys: Set<String> = [
    "t", "src", "ev", "dev", "ver", "rv", "upd",
    "seq", "gap", "frames", "ocr", "skip", "fails", "errs", "memMB", "peakMB",
    "accept", "min", "amt", "km", "kw", "screen", "interval", "triggers", "dups",
    "island", "islandErr", "keep", "auth", "fg", "orders", "others", "susp",
    "note", "code", "sent", "dropped", "beatAge", "reason", "cfg",
    "result", "wait", "delay", "hit",
    "dMB", "green", "trig", "stacked", "lockAge", "locked",
  ]

  private let endpoint: URL?
  private let key: String?
  private let queue = DispatchQueue(label: "com.pandatimer.telemetry", qos: .utility)
  private let lock = NSLock()

  // 只在 queue 上存取
  private var context: [String: Any]
  private var buffer: [[String: Any]] = []
  private var inFlight = 0
  private var sending = false
  private var waiters: [() -> Void] = []
  private var timer: DispatchSourceTimer?
  /// v0.6 遠端設定可調（telemetry.flushSeconds / batchSize）；預設＝上面的 static 值
  private var flushEvery = PandaTelemetry.flushInterval
  private var batchLimit = PandaTelemetry.batchSize
  private var session: URLSession?
  private var backoffUntil: Date?
  private var minuteStart = Date()
  private var minuteCount = 0
  private var lastOk: Date?
  private var lastError: String?
  private var sent = 0
  private var dropped = 0

  // lock 保護
  private var published: Snapshot

  init(source: String) {
    let info = Self.hostInfo()
    let key = (info["PandaTelemetryKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    let url = (info["PandaTelemetryURL"] as? String).flatMap { URL(string: $0) }
    self.key = key
    self.endpoint = url
    var ctx: [String: Any] = ["src": source, "dev": Self.deviceTag()]
    if let v = info["CFBundleShortVersionString"] as? String { ctx["ver"] = v }
    if let rv = info["PandaRuntimeVersion"] as? String { ctx["rv"] = rv }
    context = ctx
    let enabled = key != nil && url != nil
    published = Snapshot(
      enabled: enabled, lastOk: nil, lastError: enabled ? nil : "未設定回報網址/金鑰", pending: 0, sent: 0, dropped: 0)
  }

  var isEnabled: Bool { key != nil && endpoint != nil }

  /// 主 App：Bundle.main；extension：所屬 App（.appex 往上兩層）。讀不到就退回自己的 Info.plist。
  static func hostInfo() -> [String: Any] {
    let main = Bundle.main
    if main.bundleURL.pathExtension == "appex" {
      let appURL = main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
      if let info = Bundle(url: appURL)?.infoDictionary, info["PandaTelemetryKey"] != nil { return info }
    }
    return main.infoDictionary ?? [:]
  }

  /// 每個程序（App / extension 各自的 UserDefaults）一個隨機 8 碼，只用來分辨來源，不含任何裝置資訊
  static func deviceTag() -> String {
    let k = "pandatimer.telemetry.dev.v1"
    if let v = UserDefaults.standard.string(forKey: k), !v.isEmpty { return v }
    let v = String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8)).lowercased()
    UserDefaults.standard.set(v, forKey: k)
    return v
  }

  func snapshot() -> Snapshot {
    lock.lock()
    defer { lock.unlock() }
    return published
  }

  /// 之後每筆都會帶的欄位（例如 App 的 OTA 更新 id "upd"）
  func setContext(_ fields: [String: Any]) {
    queue.async {
      for (k, v) in fields where Self.allowedKeys.contains(k) {
        if let c = Self.clean(v) { self.context[k] = c } else { self.context.removeValue(forKey: k) }
      }
    }
  }

  /// 遠端設定：批次秒數與筆數（超出範圍的值已由 RemoteConfig 換成預設）
  func configure(flushSeconds: Int, batchSize: Int) {
    queue.async {
      let changed = flushSeconds != self.flushEvery
      self.flushEvery = max(5, flushSeconds)
      self.batchLimit = max(1, min(Self.maxPerPost, batchSize))
      if changed, let t = self.timer {
        t.schedule(
          deadline: .now() + .seconds(self.flushEvery), repeating: .seconds(self.flushEvery), leeway: .seconds(5))
      }
    }
  }

  /// 記一筆事件。urgent：新單/錯誤 → 立即送
  func log(_ event: String, _ fields: [String: Any] = [:], urgent: Bool = false) {
    guard isEnabled else { return }
    let now = Date()
    queue.async {
      if now.timeIntervalSince(self.minuteStart) >= 60 {
        self.minuteStart = now
        self.minuteCount = 0
      }
      if self.minuteCount >= Self.maxPerMinute && !urgent {
        self.dropped += 1
        self.publish()
        return
      }
      self.minuteCount += 1
      var record = self.context
      record["ev"] = String(event.prefix(24))
      record["t"] = (now.timeIntervalSince1970 * 1000).rounded()
      for (k, v) in fields where Self.allowedKeys.contains(k) && k != "src" && k != "dev" {
        if let c = Self.clean(v) { record[k] = c }
      }
      self.buffer.append(record)
      self.trim()
      self.ensureTimer()
      if urgent || self.buffer.count >= self.batchLimit { self.send(force: urgent) }
      self.publish()
    }
  }

  /// 立刻把手上的全部送出（extension 結束前用）；送完或失敗後呼叫 done（呼叫端自己限時等待）
  func flush(_ done: (() -> Void)? = nil) {
    queue.async {
      if let d = done { self.waiters.append(d) }
      if self.sending { return }
      if self.buffer.isEmpty || !self.isEnabled {
        self.finishWaiters()
        return
      }
      self.send(force: true)
    }
  }

  static func clean(_ value: Any) -> Any? {
    switch value {
    case let b as Bool: return b
    case let i as Int: return i
    case let d as Double: return d.isFinite ? (d * 100).rounded() / 100 : nil
    case let s as String: return String(s.prefix(80))
    case let a as [String]: return Array(a.prefix(20).map { String($0.prefix(12)) })
    default: return nil
    }
  }

  // MARK: - 內部（queue 上）

  private func trim() {
    if buffer.count > Self.maxBuffer {
      let extra = buffer.count - Self.maxBuffer
      buffer.removeFirst(extra)
      dropped += extra
    }
  }

  private func ensureTimer() {
    guard timer == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now() + .seconds(flushEvery), repeating: .seconds(flushEvery), leeway: .seconds(5))
    t.setEventHandler { [weak self] in self?.send(force: false) }
    t.resume()
    timer = t
  }

  private func makeSession() -> URLSession {
    if let s = session { return s }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 20
    config.urlCache = nil
    config.httpMaximumConnectionsPerHost = 1
    config.waitsForConnectivity = false
    let s = URLSession(configuration: config)
    session = s
    return s
  }

  private func send(force: Bool) {
    guard let url = endpoint, let key = key else { return }
    if sending { return }
    if buffer.isEmpty {
      finishWaiters()
      return
    }
    if !force, let until = backoffUntil, until > Date() { return }
    let batch = Array(buffer.prefix(Self.maxPerPost))
    guard let body = try? JSONSerialization.data(withJSONObject: batch, options: []) else {
      buffer.removeFirst(batch.count)
      dropped += batch.count
      lastError = "JSON 編碼失敗"
      publish()
      return
    }
    buffer.removeFirst(batch.count)
    inFlight = batch.count
    sending = true
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue(key, forHTTPHeaderField: "x-pt-key")
    request.httpBody = body
    makeSession().dataTask(with: request) { [weak self] _, response, error in
      guard let self = self else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? 0
      let errText = error?.localizedDescription
      self.queue.async { self.handleResult(batch: batch, code: code, error: errText) }
    }.resume()
  }

  private func handleResult(batch: [[String: Any]], code: Int, error: String?) {
    sending = false
    inFlight = 0
    if (200..<300).contains(code) {
      lastOk = Date()
      lastError = nil
      sent += batch.count
      backoffUntil = nil
    } else if code == 400 || code == 401 || code == 403 || code == 413 {
      // 重送也不會過（金鑰錯/格式錯/太大）→ 丟掉這批
      dropped += batch.count
      lastError = "HTTP \(code)"
    } else {
      buffer.insert(contentsOf: batch, at: 0)
      trim()
      lastError = error.map { String($0.prefix(60)) } ?? "HTTP \(code)"
      backoffUntil = Date().addingTimeInterval(code == 429 ? 60 : 30)
    }
    publish()
    let ok = (200..<300).contains(code)
    if ok && !buffer.isEmpty && (!waiters.isEmpty || buffer.count >= batchLimit) {
      send(force: !waiters.isEmpty)
    } else {
      finishWaiters()
    }
  }

  private func finishWaiters() {
    let list = waiters
    waiters = []
    list.forEach { $0() }
  }

  private func publish() {
    let snap = Snapshot(
      enabled: isEnabled, lastOk: lastOk, lastError: lastError, pending: buffer.count + inFlight, sent: sent,
      dropped: dropped)
    lock.lock()
    published = snap
    lock.unlock()
  }
}
