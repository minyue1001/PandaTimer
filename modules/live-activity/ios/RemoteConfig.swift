import Foundation

// ⚠️ 這個檔案有兩份，必須逐字相同（CI diff 擋）：
//   modules/live-activity/ios/RemoteConfig.swift（主 App 程序：DetectorHub）
//   targets/broadcast/RemoteConfig.swift（螢幕廣播 extension：BroadcastDetector）
// v0.6 遠端設定：原生改動不能 OTA → 偵測參數由伺服器下發（GET <PandaConfigURL>，公開、無金鑰，server/index.mjs）。
//   改 server/config.json 跑 scripts/push-config.sh 就生效，不用重裝 App。
// - 網址：主 App Info.plist 的 PandaConfigURL（plugins/withTelemetry.js 由 app.json extra.configUrl 寫入）；
//   extension 讀所屬 App 的 Info.plist（PandaTelemetry.hostInfo）。
// - 快取：各程序自己的 UserDefaults.standard "pandatimer.remoteConfig.v1"（原始 JSON 字串；PickerConfig.cached() 也讀這個）。
// - 抓取失敗（逾時 3 秒、非 200、不是 JSON 物件、>64KB）→ 沿用上次快取，沒有快取就用內建預設。
// - 欄位缺漏/不合法 → 該欄位用預設（範圍與 src/remoteConfig.ts 的 RANGES 相同）。
final class RemoteConfig {
  static let cacheKey = "pandatimer.remoteConfig.v1"
  static let maxBytes = 64 * 1024

  struct TelemetrySettings {
    /// nil＝用內建白名單
    let keywords: [[String]]?
    let flushSeconds: Int
    let batchSize: Int
  }

  private let url: URL?
  private let lock = NSLock()
  // lock 保護
  private var root: [String: Any] = [:]
  private var etag: String?
  private var fetching = false
  private var fetchedAt: Date?
  private var lastError: String?

  init() {
    let info = PandaTelemetry.hostInfo()
    url = (info["PandaConfigURL"] as? String).flatMap { URL(string: $0) }
    if let text = UserDefaults.standard.string(forKey: Self.cacheKey), let dict = Self.parse(text) {
      root = dict
    }
  }

  var isEnabled: Bool { url != nil }

  /// 目前設定的 version（沒有遠端設定 → "default"）
  var version: String {
    lock.lock()
    defer { lock.unlock() }
    return Self.version(root)
  }

  func snapshot() -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    return root
  }

  var lastFetchAt: Date? {
    lock.lock()
    defer { lock.unlock() }
    return fetchedAt
  }

  var error: String? {
    lock.lock()
    defer { lock.unlock() }
    return lastError
  }

  /// 抓一次（逾時 timeout 秒）；done(changed) 在背景執行緒呼叫。失敗沿用快取/預設，不丟錯。
  func refresh(timeout: TimeInterval = 3, done: @escaping (Bool) -> Void) {
    guard let url = url else {
      done(false)
      return
    }
    lock.lock()
    if fetching {
      lock.unlock()
      done(false)
      return
    }
    fetching = true
    let tag = etag
    lock.unlock()
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
    if let tag = tag { request.setValue(tag, forHTTPHeaderField: "If-None-Match") }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = timeout
    config.timeoutIntervalForResource = timeout
    config.urlCache = nil
    config.waitsForConnectivity = false
    let session = URLSession(configuration: config)
    session.dataTask(with: request) { [weak self] data, response, error in
      session.finishTasksAndInvalidate()
      guard let self = self else { return }
      let http = response as? HTTPURLResponse
      let code = http?.statusCode ?? 0
      var changed = false
      self.lock.lock()
      self.fetching = false
      self.fetchedAt = Date()
      if code == 200, let data = data, data.count <= Self.maxBytes,
         let text = String(data: data, encoding: .utf8), let dict = Self.parse(text)
      {
        changed = !NSDictionary(dictionary: dict).isEqual(to: self.root)
        self.root = dict
        self.etag = http?.value(forHTTPHeaderField: "Etag")
        self.lastError = nil
        UserDefaults.standard.set(text, forKey: Self.cacheKey)
      } else if code == 304 {
        self.lastError = nil
      } else {
        self.lastError = error.map { String($0.localizedDescription.prefix(60)) } ?? "HTTP \(code)"
      }
      self.lock.unlock()
      done(changed)
    }.resume()
  }

  // MARK: - 解析（缺漏/不合法 → 預設）

  static func parse(_ text: String) -> [String: Any]? {
    guard let data = text.data(using: .utf8), data.count <= maxBytes else { return nil }
    return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
  }

  static func version(_ root: [String: Any]) -> String {
    guard let v = root["version"] as? String, !v.isEmpty, v.count <= 40 else { return "default" }
    return v
  }

  static func section(_ root: [String: Any], _ name: String) -> [String: Any] {
    (root[name] as? [String: Any]) ?? [:]
  }

  static func number(_ v: Any?, _ lo: Double, _ hi: Double, _ fallback: Double) -> Double {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return fallback }
    let x = n.doubleValue
    return x.isFinite && x >= lo && x <= hi ? x : fallback
  }

  static func int(_ v: Any?, _ lo: Int, _ hi: Int, _ fallback: Int) -> Int {
    let x = number(v, Double(lo), Double(hi), Double(fallback))
    return x == x.rounded() ? Int(x) : fallback
  }

  /// 編得過且捕捉群組數 ≥ groups 才收，否則 fallback
  static func regex(_ v: Any?, groups: Int, _ fallback: String) -> String {
    guard let p = v as? String, !p.isEmpty, p.count <= 300,
          let r = try? NSRegularExpression(pattern: p, options: []),
          r.numberOfCaptureGroups >= groups
    else { return fallback }
    return p
  }

  /// v0.7 offer.acceptedKeywords / rejectedKeywords：編得過、≤300 字，且**不能命中空字串**（'a|'、'.*' 會讓每個畫面都算命中）
  static func offerRegex(_ v: Any?, _ fallback: String) -> String {
    guard let p = v as? String, !p.isEmpty, p.count <= 300,
          let r = try? NSRegularExpression(pattern: p, options: []),
          r.firstMatch(in: "", options: [], range: NSRange(location: 0, length: 0)) == nil
    else { return fallback }
    return p
  }

  /// 字串列舉（例如 offer.ambiguousAs："accept"|"reject"）；不在選項內 → fallback
  static func choice(_ v: Any?, _ options: [String], _ fallback: String) -> String {
    guard let s = v as? String, options.contains(s) else { return fallback }
    return s
  }

  /// [[正式名稱, 異體...], ...]：1~40 列、每列 1~6 個 1~12 字的字串；不合法 → nil（用內建）
  static func keywordRows(_ v: Any?) -> [[String]]? {
    guard let rows = v as? [[String]], (1...40).contains(rows.count),
          rows.allSatisfy({ (1...6).contains($0.count) && $0.allSatisfy { (1...12).contains($0.count) } })
    else { return nil }
    return rows
  }

  static func telemetry(_ root: [String: Any]) -> TelemetrySettings {
    let t = section(root, "telemetry")
    return TelemetrySettings(
      keywords: keywordRows(t["keywords"]),
      flushSeconds: int(t["flushSeconds"], 5, 600, 30),
      batchSize: int(t["batchSize"], 1, 50, 10))
  }

  /// v0.7 自動送達（extension：completedKeywords/enabled；App：enabled/minOrderAgeSec）。預設＝src/deliveryDetector.ts
  struct DeliverySettings {
    // ⚠️ 待實測調整（實機 telemetry 有 screen=delivering kw=完成訂單,聯絡）
    static let defaultCompletedKeywords =
      "完成訂單|完成订单|訂單已完成|订单已完成|已送達|已送达|送達完成|送达完成|確認送達|确认送达|完成送達|完成送达"
    var enabled = true
    var minOrderAgeSec = 120
    var completedKeywords = DeliverySettings.defaultCompletedKeywords
  }

  static func delivery(_ root: [String: Any]) -> DeliverySettings {
    let d = section(root, "delivery")
    var out = DeliverySettings()
    if let n = d["enabled"] as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() { out.enabled = n.boolValue }
    out.minOrderAgeSec = int(d["minOrderAgeSec"], 0, 1800, out.minOrderAgeSec)
    out.completedKeywords = offerRegex(d["completedKeywords"], out.completedKeywords)
    return out
  }

  /// v0.7 extension OCR 記憶體保護（MB）：目前 > memSkipMB 跳過該幀；OCR 中量到 > memHighMB → 之後 120 秒只認大字
  struct OcrSettings {
    var memSkipMB = 38.0
    var memHighMB = 44.0
  }

  static func ocr(_ root: [String: Any]) -> OcrSettings {
    let o = section(root, "ocr")
    var out = OcrSettings()
    out.memSkipMB = number(o["memSkipMB"], 20, 60, out.memSkipMB)
    out.memHighMB = number(o["memHighMB"], 25, 80, out.memHighMB)
    return out
  }

  /// App：心跳逾時秒數（預設 150）
  static func beatTimeout(_ root: [String: Any]) -> TimeInterval {
    Double(int(section(root, "app")["beatTimeoutSeconds"], 60, 1800, 150))
  }

  /// 多久重抓一次（預設 600 秒）
  static func refreshSeconds(_ root: [String: Any]) -> TimeInterval {
    Double(int(section(root, "detector")["configRefreshSeconds"], 60, 86400, 600))
  }
}
