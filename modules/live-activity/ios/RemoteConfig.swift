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

  /// JSON 布林（NSNumber 的 CFBoolean）；其他 → fallback
  static func bool(_ v: Any?, _ fallback: Bool) -> Bool {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return fallback }
    return n.boolValue
  }

  /// v0.8 telemetry.keywords 上限 60 列（v0.7 是 40）
  static let maxKeywordRows = 60

  /// [[正式名稱, 異體...], ...]：1~60 列、每列 1~6 個 1~12 字的字串；不合法 → nil（用內建）
  static func keywordRows(_ v: Any?) -> [[String]]? {
    guard let rows = v as? [[String]], (1...maxKeywordRows).contains(rows.count),
          rows.allSatisfy({ (1...6).contains($0.count) && $0.allSatisfy { (1...12).contains($0.count) } })
    else { return nil }
    return rows
  }

  static func telemetry(_ root: [String: Any]) -> TelemetrySettings {
    let t = section(root, "telemetry")
    return TelemetrySettings(
      keywords: keywordRows(t["keywords"]),
      flushSeconds: int(t["flushSeconds"], 5, 600, 60),
      batchSize: int(t["batchSize"], 1, 50, 10))
  }

  /// v0.7 自動送達（extension：completedKeywords/enabled；App：enabled/minOrderAgeSec）。預設＝src/deliveryDetector.ts
  /// v0.8：finalKeywords（「訂單完成」：看到就以該時間結單）＋pendingSec（只看到送達確認對話框時先等這麼久）
  struct DeliverySettings {
    // v0.8 首日實測：送達確認對話框「…是否已送達?／確認已送達」、送達後彈窗「訂單完成」
    static let defaultCompletedKeywords =
      "訂單完成|订单完成|完成訂單|完成订单|訂單已完成|订单已完成|已送達|已送达|送達完成|送达完成|確認送達|确认送达|完成送達|完成送达"
    static let defaultFinalKeywords = "訂單完成|订单完成|訂單已完成|订单已完成"
    var enabled = true
    var minOrderAgeSec = 120
    var completedKeywords = DeliverySettings.defaultCompletedKeywords
    var finalKeywords = DeliverySettings.defaultFinalKeywords
    var pendingSec = 30
  }

  static func delivery(_ root: [String: Any]) -> DeliverySettings {
    let d = section(root, "delivery")
    var out = DeliverySettings()
    out.enabled = bool(d["enabled"], out.enabled)
    out.minOrderAgeSec = int(d["minOrderAgeSec"], 0, 1800, out.minOrderAgeSec)
    out.completedKeywords = offerRegex(d["completedKeywords"], out.completedKeywords)
    out.finalKeywords = offerRegex(d["finalKeywords"], out.finalKeywords)
    out.pendingSec = int(d["pendingSec"], 0, 60, out.pendingSec)
    return out
  }

  /// v0.7 extension OCR 記憶體保護（MB）：目前 > memSkipMB 跳過該幀；OCR 中量到 > memHighMB → 之後 120 秒只認大字
  /// v0.8：memSkipMB 預設 36；每 rebuildEvery 次 OCR 重建 VNRecognizeTextRequest；englishToo=false 只用 zh-Hant
  struct OcrSettings {
    var memSkipMB = 36.0
    var memHighMB = 44.0
    var rebuildEvery = 30
    var englishToo = false
  }

  static func ocr(_ root: [String: Any]) -> OcrSettings {
    let o = section(root, "ocr")
    var out = OcrSettings()
    out.memSkipMB = number(o["memSkipMB"], 20, 60, out.memSkipMB)
    out.memHighMB = number(o["memHighMB"], 25, 80, out.memHighMB)
    out.rebuildEvery = int(o["rebuildEvery"], 1, 1000, out.rebuildEvery)
    out.englishToo = bool(o["englishToo"], out.englishToo)
    return out
  }

  /// v0.8 亮綠色金額觸發（detector.greenTrigger；預設＝src/frameTrigger.ts 的 DEFAULT_GREEN）
  struct GreenTriggerSettings {
    var enabled = true
    var minRatio = 0.002
    var yMin = 60
    var cbMax = 110
    var crMax = 110
    var holdSec = 10.0
    var regionFraction = 0.55
  }

  static func greenTrigger(_ root: [String: Any]) -> GreenTriggerSettings {
    let g = (section(root, "detector")["greenTrigger"] as? [String: Any]) ?? [:]
    var out = GreenTriggerSettings()
    out.enabled = bool(g["enabled"], out.enabled)
    out.minRatio = number(g["minRatio"], 0.0001, 0.5, out.minRatio)
    out.yMin = int(g["yMin"], 0, 255, out.yMin)
    out.cbMax = int(g["cbMax"], 0, 255, out.cbMax)
    out.crMax = int(g["crMax"], 0, 255, out.crMax)
    out.holdSec = number(g["holdSec"], 1, 120, out.holdSec)
    out.regionFraction = number(g["regionFraction"], 0.2, 1, out.regionFraction)
    return out
  }

  /// App：心跳逾時秒數（預設 150）
  static func beatTimeout(_ root: [String: Any]) -> TimeInterval {
    Double(int(section(root, "app")["beatTimeoutSeconds"], 60, 1800, 150))
  }

  /// v0.9 App：心跳的動態島 update 只在診斷字有實質變化、或距上次 update 滿這麼多秒才做（預設 300）
  static func cardRefreshSeconds(_ root: [String: Any]) -> TimeInterval {
    Double(int(section(root, "app")["cardRefreshSeconds"], 60, 1800, 300))
  }

  // MARK: - v0.9 省電（預設＝src/powerSaver.ts / src/remoteConfig.ts；以 TS 測試為準）

  /// extension：pandarider 不在畫面上（連 afterMisses 次 OCR 沒有特徵詞）→ away：不做畫面變化觸發、間隔/取樣拉長
  struct AwaySettings {
    static let defaultKeywords =
      "上線中|上线中|休息中|抵達|抵达|取餐|送達|送达|每單收入|每单收入|接受訂單|接受订单|訂單|订单|預計|预计|夾單|夹单|導航|导航"
    var enabled = true
    var afterMisses = 5
    var intervalSec = 6.0
    var probeIntervalSec = 0.5
    var keywords = AwaySettings.defaultKeywords
  }

  static func away(_ root: [String: Any]) -> AwaySettings {
    let a = section(root, "away")
    var out = AwaySettings()
    out.enabled = bool(a["enabled"], out.enabled)
    out.afterMisses = int(a["afterMisses"], 1, 100, out.afterMisses)
    out.intervalSec = number(a["intervalSec"], 1, 60, out.intervalSec)
    out.probeIntervalSec = number(a["probeIntervalSec"], 0.05, 2, out.probeIntervalSec)
    out.keywords = offerRegex(a["keywords"], out.keywords)
    return out
  }

  /// 低電量模式（onLowPower）或 thermalState ≥ thermalLevel（2＝serious；4＝不看溫度）→ extension 所有間隔 ×saverFactor
  struct PowerSettings {
    var saverFactor = 1.5
    var thermalLevel = 2
    var onLowPower = true
  }

  static func power(_ root: [String: Any]) -> PowerSettings {
    let p = section(root, "power")
    var out = PowerSettings()
    out.saverFactor = number(p["saverFactor"], 1, 5, out.saverFactor)
    out.thermalLevel = int(p["thermalLevel"], 1, 4, out.thermalLevel)
    out.onLowPower = bool(p["onLowPower"], out.onLowPower)
    return out
  }

  /// 同 src/powerSaver.ts isSaver（thermal＝ProcessInfo.ThermalState.rawValue）
  static func isSaver(lowPower: Bool, thermal: Int, _ p: PowerSettings) -> Bool {
    (p.onLowPower && lowPower) || thermal >= p.thermalLevel
  }

  /// 目前這個程序看到的省電狀態（ProcessInfo 執行緒安全，extension 也能用）
  static func deviceSaver(_ p: PowerSettings) -> (saver: Bool, lowPower: Bool, thermal: Int) {
    let info = ProcessInfo.processInfo
    let low = info.isLowPowerModeEnabled
    let thermal = info.thermalState.rawValue
    return (isSaver(lowPower: low, thermal: thermal, p), low, thermal)
  }

  /// App 定位保活：locationAccuracy "hundred"|"kilometer"|"threeKilometers"；distanceFilterM 0＝不過濾
  struct KeepAliveSettings {
    var locationAccuracy = "hundred"
    var distanceFilterM = 50
  }

  static func keepAlive(_ root: [String: Any]) -> KeepAliveSettings {
    let k = section(root, "keepAlive")
    var out = KeepAliveSettings()
    out.locationAccuracy = choice(k["locationAccuracy"], ["hundred", "kilometer", "threeKilometers"], out.locationAccuracy)
    out.distanceFilterM = int(k["distanceFilterM"], 0, 5000, out.distanceFilterM)
    return out
  }

  /// v1.0 App：偵測到邀請時動態島/鎖定畫面立即顯示「✓ 已偵測 N 分邀請・可以按接受」（offer 區塊；預設＝src/remoteConfig.ts
  /// DEFAULT_OFFER_ISLAND）。islandIndicator=false → 不改卡片；alertSound "default"|"none"
  /// （⚠️ ActivityKit 沒有官方靜音選項：none 用 .named("") 試，查無檔名時系統可能退回預設聲音，以實機為準）
  struct OfferIslandSettings {
    var islandIndicator = true
    var alertSound = "default"
  }

  static func offerIsland(_ root: [String: Any]) -> OfferIslandSettings {
    let o = section(root, "offer")
    var out = OfferIslandSettings()
    out.islandIndicator = bool(o["islandIndicator"], out.islandIndicator)
    out.alertSound = choice(o["alertSound"], ["default", "none"], out.alertSound)
    return out
  }

  /// 多久重抓一次（預設 600 秒）
  static func refreshSeconds(_ root: [String: Any]) -> TimeInterval {
    Double(int(section(root, "detector")["configRefreshSeconds"], 60, 86400, 600))
  }
}
