import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ReplayKit
import UserNotifications
import Vision

// v0.4 螢幕廣播偵測 extension（ReplayKit Broadcast Upload Extension，獨立程序、記憶體上限約 50MB）。
// v0.3 實機結論：ActivityKit 在 broadcast extension 內完全不可用（看不到 App 的卡、自己 request 也報
// 「Target does not include NSSupportsLiveActivities plist key」）→ 這裡**不碰 ActivityKit**。
// 只做 OCR 偵測，結果用 Darwin notification 通知 App（名稱編碼資料，見 PandaSignal），App 保活中自己更新動態島。
// 另外保留本地通知「偵測到新單：N 分鐘」給使用者確認（不響聲）。
// v0.6：多單＋（分鐘, 金額）90 秒去重；訊號 com.pandatimer.order.<分>.<序號 mod 4>；
//   遠端狀態回報（PandaTelemetry，只送結構化欄位，OCR 原文不離開 runOCR）。
// v0.7：接單後才開始倒數——邀請畫面出現只送 offer.pending.<分>（App 顯示「等你接單」），邀請消失後看畫面判斷
//   接了沒（OfferTracker.swift）；接單才送 accept.delay.<秒>＋order 訊號（App 用延遲把接單時間還原成按下接受的時間）。
//   自動送達：畫面命中 delivery.completedKeywords → 邊緣觸發送 com.pandatimer.delivered（DeliveryEdge，60 秒不重送）。
//   記憶體保護：OCR 前目前 > ocr.memSkipMB 跳過該幀；OCR 中量到 > ocr.memHighMB → 之後 120 秒 minimumTextHeight 至少 0.03（只認大字）。
//
// 省記憶體（v0.4 實測峰值 43MB → v0.5 目標 ≤36MB；jetsam 約 50MB）：
//  - 不用 CIContext：直接讀 pixel buffer 的亮度平面（420f 的 Y），只取畫面下方 50%，
//    非整數倍盒狀平均縮到長邊 ≤640px（v0.4：55%、整數倍、長邊 ≤800）→ 8-bit 灰階小圖約 0.37MB，
//    且灰階位元組直接當 CGImage 的資料（不再多複製一份）；
//  - OCR 最多每 1.5 秒一次；最近連續幾次 OCR 都沒有接單鈕 → 放慢到 3 秒一次（看到接單鈕立刻回 1.5 秒）；
//    64×64 平均雜湊與上次 OCR 的畫面幾乎相同就跳過（最多 10 秒強制再 OCR 一次）；
//  - VNRecognizeTextRequest 只建一次重用（固定 revision 3）、minimumTextHeight 0.02（長邊 640 ≈ 13px）；
//    handler 每次辨識完即釋放、觀測結果只取字串；每幀包 autoreleasepool。
class SampleHandler: RPBroadcastSampleHandler {
  private let detector = BroadcastDetector()

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    detector.start()
  }

  override func broadcastPaused() {}

  override func broadcastResumed() {}

  override func broadcastFinished() {
    detector.finish()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video else { return }
    detector.process(sampleBuffer)
  }
}

// MARK: - extension → App 訊號（Darwin notification；⚠️ 名稱與 modules/live-activity/ios/DetectorHub.swift、
// src/detector.ts 一致）

enum PandaSignal {
  static let started = "com.pandatimer.broadcast.started"
  static let stopped = "com.pandatimer.broadcast.stopped"
  static let heartbeat = "com.pandatimer.broadcast.heartbeat"
  static let orderPrefix = "com.pandatimer.order."
  /// v0.7：邀請出現（App 顯示「偵測到邀請 N 分，等你接單…」）／判定未接
  static let offerPendingPrefix = "com.pandatimer.offer.pending."
  static let offerCleared = "com.pandatimer.offer.cleared"
  /// v0.7：接單訊號前先送「從按下接受到現在的秒數」（0…60），App 在 2 秒內配對 → acceptedAt＝收到時間 − 秒數
  static let acceptDelayPrefix = "com.pandatimer.accept.delay."
  static let maxAcceptDelay = 60
  /// v0.7 自動送達：看到完成/送達畫面（App 結最早且接單超過 minOrderAgeSec 的進行中單）
  static let delivered = "com.pandatimer.delivered"

  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
  }

  /// v0.6：com.pandatimer.order.<分 1-90>.<序號 0-3>。序號讓連續兩張同分鐘的單名稱不同
  /// （App 被暫停時同名 Darwin 通知會合併成一則）。App 註冊 90×4 個名稱；分鐘數超出範圍 → 不送、回 false。
  static let seqMod = 4

  static func postOrder(_ minutes: Int, seq: Int) -> Bool {
    guard minutes >= 1, minutes <= 90 else { return false }
    post("\(orderPrefix)\(minutes).\(((seq % seqMod) + seqMod) % seqMod)")
    return true
  }

  static func postOfferPending(_ minutes: Int) {
    guard minutes >= 1, minutes <= 90 else { return }
    post("\(offerPendingPrefix)\(minutes)")
  }

  static func postAcceptDelay(_ seconds: Int) {
    post("\(acceptDelayPrefix)\(min(maxAcceptDelay, max(0, seconds)))")
  }
}

final class BroadcastDetector {
  // MARK: - 參數（v0.6：由遠端設定下發——server/config.json 的 detector/picker/telemetry 區塊；預設＝下列值＝
  // server/config.default.json＝src/remoteConfig.ts 的 DEFAULT_DETECTOR。缺漏/不合法的欄位用預設，範圍同 RANGES）
  struct DetectorSettings {
    var ocrInterval: CFAbsoluteTime = 1.5
    /// 連續 idleAfterMisses 次 OCR 都沒有接單鈕 → 改用 idleOcrInterval
    var idleOcrInterval: CFAbsoluteTime = 3
    var idleAfterMisses = 3
    var forceOcrInterval: CFAbsoluteTime = 10
    var sameFrameMaxBits = 40  // 4096 bits 中差異 ≤40（≈1%）視為同一畫面
    var heartbeatInterval = 60
    /// 已接的（分鐘數, 金額取整）90 秒內又出現不算新邀請（v0.7 由 OfferTracker 使用）
    var dedupeWindow: TimeInterval = 90
    var maxLongEdge = 640
    var bottomFraction = 0.50
    var minimumTextHeight = 0.02
    var memoryAlertMB: Double = 40
    var refreshSeconds: TimeInterval = 600
    /// 接單鈕正則、分鐘/金額規則（PickerConfig）、回報白名單關鍵字
    var rules = ScreenRules.standard
    /// v0.7 接單判定（遠端設定 "offer"；detector.goneAfterMisses 是 v0.6 用的，v0.7 改看 offer.goneAfterMisses）
    var offer = OfferSettings()
    /// v0.7 自動送達（遠端設定 "delivery"）、OCR 記憶體保護（"ocr"）
    var delivery = RemoteConfig.DeliverySettings()
    var ocrGuard = RemoteConfig.OcrSettings()
    var version = "default"

    init() {}

    init(root: [String: Any]) {
      let d = RemoteConfig.section(root, "detector")
      ocrInterval = RemoteConfig.number(d["ocrIntervalSeconds"], 0.5, 10, ocrInterval)
      idleOcrInterval = RemoteConfig.number(d["idleOcrIntervalSeconds"], 0.5, 30, idleOcrInterval)
      idleAfterMisses = RemoteConfig.int(d["idleAfterMisses"], 1, 100, idleAfterMisses)
      forceOcrInterval = RemoteConfig.number(d["forceOcrSeconds"], 1, 120, forceOcrInterval)
      sameFrameMaxBits = RemoteConfig.int(d["sameFrameMaxBits"], 0, 1000, sameFrameMaxBits)
      heartbeatInterval = RemoteConfig.int(d["heartbeatSeconds"], 15, 600, heartbeatInterval)
      dedupeWindow = RemoteConfig.number(d["dedupeSeconds"], 0, 3600, dedupeWindow)
      maxLongEdge = RemoteConfig.int(d["maxLongEdge"], 320, 1600, maxLongEdge)
      bottomFraction = RemoteConfig.number(d["bottomFraction"], 0.2, 1, bottomFraction)
      minimumTextHeight = RemoteConfig.number(d["minimumTextHeight"], 0, 0.2, minimumTextHeight)
      memoryAlertMB = RemoteConfig.number(d["memoryAlertMB"], 10, 100, memoryAlertMB)
      refreshSeconds = RemoteConfig.refreshSeconds(root)
      rules.picker = PickerConfig(json: RemoteConfig.section(root, "picker"))
      rules.acceptPattern = RemoteConfig.regex(d["acceptPattern"], groups: 0, rules.acceptPattern)
      if let rows = RemoteConfig.telemetry(root).keywords { rules.keywords = rows }
      offer = OfferSettings(root: root)
      rules.acceptedKeywords = offer.acceptedKeywords
      rules.rejectedKeywords = offer.rejectedKeywords
      delivery = RemoteConfig.delivery(root)
      rules.completedKeywords = delivery.completedKeywords
      ocrGuard = RemoteConfig.ocr(root)
      version = RemoteConfig.version(root)
    }
  }

  // MARK: - 狀態
  private let workQueue = DispatchQueue(label: "com.pandatimer.broadcast.work", qos: .userInitiated)
  private let lock = NSLock()
  private let ocr = FrameOCR()
  private var heartbeatTimer: DispatchSourceTimer?
  /// v0.6 遠端設定（broadcastStarted 與每 refreshSeconds 抓一次；逾時 3 秒；失敗用快取或預設）
  private let remote = RemoteConfig()
  private var lastConfigFetch: Date?  // 只在 workQueue
  /// v0.6 遠端狀態回報（只送結構化欄位，見 PandaTelemetry.swift 的隱私鐵律）
  private let telemetry = PandaTelemetry(source: "ext")

  // lock 保護（ReplayKit 回呼執行緒 ↔ workQueue）
  private var framesReceived = 0
  private var busy = false
  private var lastCheckStart: CFAbsoluteTime = 0
  private var lastOcrAt: CFAbsoluteTime = 0
  private var lastHash: [UInt64]?
  private var skipped = 0
  private var imageFailures = 0
  private var badFormat: OSType?
  private var currentInterval: CFAbsoluteTime = 1.5
  private var settings = DetectorSettings()

  // 只在 workQueue 存取
  private var ocrCount = 0
  private var ocrErrors = 0
  private var currentMB: Double = 0
  private var peakMB: Double = 0
  private var alertedPeakMB: Double = 0
  private var lastSawAccept = false
  private var missStreak = 0
  private var lastTriggerMinutes: Int?
  private var lastTriggerAt: Date?
  /// v0.7：判定「已接」並送出訂單訊號的次數
  private var triggerCount = 0
  /// v0.7 邀請狀態機（idle/offered/deciding）＋視窗到期計時器
  private let tracker = OfferTracker()
  private var decisionTimer: DispatchWorkItem?
  private var orderSeq = 0
  private var dupCount = 0
  /// v0.7 自動送達邊緣觸發、記憶體保護
  private let deliveryEdge = DeliveryEdge()
  private var deliveredCount = 0
  private var memSkips = 0
  private var lastMemSkipLog: Date?
  private var highMemUntil: Date?
  private var lastOcrDoneAt: Date?
  private var lastScreenLogged: String?
  private var lastScreenLoggedAt: Date?

  // MARK: - 生命週期（由 SampleHandler 轉呼叫）

  func start() {
    PandaSignal.post(PandaSignal.started)
    // 先套上次快取的遠端設定（沒有就預設），再背景抓最新的
    let initial = DetectorSettings(root: remote.snapshot())
    lock.lock()
    settings = initial
    currentInterval = initial.ocrInterval
    lock.unlock()
    workQueue.async {
      self.applyConfig(self.remote.snapshot())
      self.refreshConfig()
      if let previous = RunRecord.reportPreviousIfCrashed() {
        self.telemetry.log("crashPrev", ["note": previous], urgent: true)
      }
      self.sampleMemory()
      RunRecord.save(diag: self.diag(), finished: false)
      self.telemetry.log("start", self.statsFields(), urgent: true)
    }
    let timer = DispatchSource.makeTimerSource(queue: workQueue)
    timer.schedule(
      deadline: .now() + .seconds(initial.heartbeatInterval),
      repeating: .seconds(initial.heartbeatInterval),
      leeway: .seconds(5))
    timer.setEventHandler { [weak self] in
      self?.heartbeat()
    }
    timer.resume()
    heartbeatTimer = timer
  }

  func finish() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
    // v0.7：還在等判定的邀請先結案（offered → 未接；deciding → 依 ambiguousAs），訂單訊號要在 stopped 之前送
    workQueue.sync {
      self.decisionTimer?.cancel()
      self.decisionTimer = nil
      self.handleOffer(self.tracker.finish(Date()), info: nil)
    }
    PandaSignal.post(PandaSignal.stopped)
    // 程序在這個方法 return 後就會被結束 → 等最後一則（靜音）摘要通知送出（最多 2 秒）
    let done = DispatchSemaphore(value: 0)
    let sent = DispatchSemaphore(value: 0)
    workQueue.async {
      self.sampleMemory()
      let text = self.diag()
      RunRecord.save(diag: "偵測已停止 \(Clock.hms(Date())) · \(text)", finished: true)
      self.telemetry.log("stop", self.statsFields())
      self.telemetry.flush { sent.signal() }
      Task.detached {
        await Notifier.post("偵測已停止", text, passive: true)
        done.signal()
      }
    }
    // 程序在這個方法 return 後就會被結束：通知與最後一批回報各等一下（合計最多約 2.5 秒）
    _ = done.wait(timeout: .now() + 2)
    _ = sent.wait(timeout: .now() + 0.5)
  }

  /// 每 60 秒（遠端可調）：心跳給 App；記錄本輪診斷（被系統殺掉時下次開始會回報）；峰值超過門檻發靜音通知；
  /// 每 refreshSeconds 重抓一次遠端設定
  private func heartbeat() {
    PandaSignal.post(PandaSignal.heartbeat)
    sampleMemory()
    let text = diag()
    RunRecord.save(diag: text, finished: false)
    telemetry.log("beat", statsFields())
    let s = currentSettings()
    if peakMB > s.memoryAlertMB && peakMB >= alertedPeakMB + 3 {
      alertedPeakMB = peakMB
      let limit = Int(s.memoryAlertMB)
      Task.detached {
        await Notifier.post("偵測記憶體偏高", "峰值超過 \(limit)MB（上限約 50MB，超過會被系統關掉）\n\(text)", passive: true)
      }
    }
    if lastConfigFetch.map({ Date().timeIntervalSince($0) >= s.refreshSeconds }) ?? true { refreshConfig() }
  }

  // MARK: - 遠端設定（只在 workQueue）

  private func currentSettings() -> DetectorSettings {
    lock.lock()
    defer { lock.unlock() }
    return settings
  }

  private func applyConfig(_ root: [String: Any]) {
    let next = DetectorSettings(root: root)
    lock.lock()
    let old = settings
    settings = next
    if currentInterval == old.ocrInterval || currentInterval == old.idleOcrInterval {
      currentInterval = missStreak >= next.idleAfterMisses ? next.idleOcrInterval : next.ocrInterval
    }
    lock.unlock()
    ocr.setMinimumTextHeight(Float(next.minimumTextHeight))
    let t = RemoteConfig.telemetry(root)
    telemetry.configure(flushSeconds: t.flushSeconds, batchSize: t.batchSize)
    telemetry.setContext(["cfg": next.version])
    tracker.settings = next.offer
    tracker.dedupeSeconds = next.dedupeWindow
    if old.heartbeatInterval != next.heartbeatInterval, let timer = heartbeatTimer {
      timer.schedule(
        deadline: .now() + .seconds(next.heartbeatInterval), repeating: .seconds(next.heartbeatInterval),
        leeway: .seconds(5))
    }
  }

  private func refreshConfig() {
    lastConfigFetch = Date()
    remote.refresh(timeout: 3) { [weak self] changed in
      guard let self = self else { return }
      self.workQueue.async {
        if changed {
          self.applyConfig(self.remote.snapshot())
          self.telemetry.log("config", ["cfg": self.remote.version, "note": "updated"], urgent: true)
        } else if let err = self.remote.error {
          self.telemetry.log("config", ["cfg": self.remote.version, "reason": err])
        }
      }
    }
  }

  // MARK: - 每幀

  func process(_ sampleBuffer: CMSampleBuffer) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    framesReceived += 1
    let s = settings
    let shouldCheck = !busy && now - lastCheckStart >= currentInterval
    if shouldCheck {
      busy = true
      lastCheckStart = now
    }
    lock.unlock()
    guard shouldCheck else { return }  // 節流＋忙就丟幀

    // 在回呼內就把畫面縮成小灰階圖，不把 ReplayKit 的 pixel buffer 帶到別的執行緒
    var made: GrayFrame?
    var format: OSType?
    autoreleasepool {
      (made, format) = GrayFrame.make(
        sampleBuffer, bottomFraction: s.bottomFraction, maxLongEdge: s.maxLongEdge)
    }
    guard let frame = made else {
      lock.lock()
      imageFailures += 1
      if let f = format { badFormat = f }
      busy = false
      lock.unlock()
      return
    }

    lock.lock()
    let same = lastHash.map { GrayFrame.distance($0, frame.hash) <= s.sameFrameMaxBits } ?? false
    if same && now - lastOcrAt < s.forceOcrInterval {
      skipped += 1
      busy = false
      lock.unlock()
      return
    }
    lastHash = frame.hash
    lastOcrAt = now
    lock.unlock()

    workQueue.async {
      autoreleasepool {
        self.runOCR(frame)
      }
      self.lock.lock()
      self.busy = false
      self.lock.unlock()
    }
  }

  private func runOCR(_ frame: GrayFrame) {
    // OCR 原文只活在這個函式內：立刻轉成結構化摘要（ScreenInfo），之後只用摘要（隱私鐵律：原文不上傳、不保存）
    let s = currentSettings()
    // v0.7 記憶體保護：目前已偏高就跳過這一幀（Vision 辨識當下會再往上衝十幾 MB；jetsam 約 50MB）
    sampleMemory()
    // 但最多連跳 15 秒（記憶體一直下不來也不能整個停擺；強制那次用「只認大字」模式）
    let starving = lastOcrDoneAt.map { Date().timeIntervalSince($0) >= 15 } ?? true
    if currentMB > s.ocrGuard.memSkipMB && !starving {
      memSkips += 1
      let now = Date()
      if lastMemSkipLog.map({ now.timeIntervalSince($0) >= 30 }) ?? true {
        lastMemSkipLog = now
        telemetry.log("memSkip", ["memMB": currentMB, "peakMB": peakMB, "skip": memSkips])
      }
      return
    }
    // OCR 中量到偏高 → 之後 120 秒只認大字（文字很多的畫面 Vision 峰值較高；接單鈕/分鐘數/完成訂單都是大字）
    let highMem = (highMemUntil.map { Date() < $0 } ?? false) || currentMB > s.ocrGuard.memSkipMB
    ocr.setMinimumTextHeight(Float(highMem ? max(s.minimumTextHeight, 0.03) : s.minimumTextHeight))
    let info: ScreenInfo.Summary
    do {
      guard let image = frame.cgImage() else {
        ocrErrors += 1
        return
      }
      let ocrText = try ocr.recognize(image, orientation: frame.orientation)
      info = ScreenInfo.analyze(ocrText, rules: s.rules)
    } catch {
      ocrErrors += 1
      return
    }
    ocrCount += 1
    lastOcrDoneAt = Date()
    sampleMemory()
    if ocr.lastInnerMB > s.ocrGuard.memHighMB {
      if !highMem {
        telemetry.log("memHigh", ["memMB": ocr.lastInnerMB, "peakMB": peakMB, "screen": info.screen, "kw": info.kw])
      }
      highMemUntil = Date().addingTimeInterval(120)
    }
    lastSawAccept = info.accept
    missStreak = info.accept ? 0 : missStreak + 1
    logScreenIfChanged(info)

    // v0.7：邀請狀態機（不再「看到邀請就送訊號」；接單判定見 OfferTracker.swift）
    handleOffer(tracker.observe(Date(), OfferObservation(info)), info: info)
    scheduleDecisionTimer()
    // v0.7 自動送達（邊緣觸發＋60 秒不重送；App 端挑單/互斥見 DetectorHub.AutoDelivery）
    if s.delivery.enabled {
      switch deliveryEdge.observe(Date(), hit: info.delivered) {
      case .send:
        deliveredCount += 1
        PandaSignal.post(PandaSignal.delivered)
        telemetry.log(
          "delivered_seen", ["hit": info.deliveredHit, "kw": info.kw, "screen": info.screen, "note": "signal"], urgent: true)
      case .repeatSuppressed:
        telemetry.log("delivered_seen", ["hit": info.deliveredHit, "kw": info.kw, "screen": info.screen, "note": "repeat"])
      case .idle:
        break
      }
    }
    // 等判定期間維持快速 OCR（要盡快看到接單後/未接畫面）
    let fast = tracker.deadline != nil
    let interval = (missStreak >= s.idleAfterMisses && !fast) ? s.idleOcrInterval : s.ocrInterval
    lock.lock()
    currentInterval = interval
    lock.unlock()
  }

  // MARK: - v0.7 邀請 → 接單判定（只在 workQueue）

  /// deciding 的視窗到期：畫面靜止時 ReplayKit 不送幀、OCR 不會跑 → 另排計時器推進狀態機
  private func scheduleDecisionTimer() {
    decisionTimer?.cancel()
    decisionTimer = nil
    guard let deadline = tracker.deadline else { return }
    let item = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.decisionTimer = nil
      self.handleOffer(self.tracker.tick(Date()), info: nil)
      self.scheduleDecisionTimer()
    }
    decisionTimer = item
    workQueue.asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow) + 0.2, execute: item)
  }

  private func handleOffer(_ events: [OfferEvent], info: ScreenInfo.Summary?) {
    for event in events {
      switch event {
      case .seen(let offer):
        PandaSignal.postOfferPending(offer.minutes)
        var fields: [String: Any] = ["min": offer.minutes, "note": "pending"]
        if let a = offer.amount { fields["amt"] = a }
        if let i = info {
          fields["kw"] = i.kw
          fields["screen"] = i.screen
          if let km = i.km { fields["km"] = km }
        }
        telemetry.log("offer_seen", fields)
      case .resumed(let offer, let away):
        telemetry.log("offer_resumed", ["min": offer.minutes, "wait": away])
      case .dup(let minutes, let amount):
        // 已接的同一組（分鐘數, 金額）dedupeSeconds 內又出現（例：逾時判接單後切回來邀請還在）
        dupCount += 1
        telemetry.log("dup", ["min": minutes, "amt": amount ?? 0, "dups": dupCount])
      case .decided(let decision):
        decided(decision)
      }
    }
  }

  private func decided(_ d: OfferDecision) {
    let minutes = d.offer.minutes
    var fields: [String: Any] = [
      // note＝result 的備份：部署中的 v0.6 伺服器不認得 result/wait/hit，會丟掉
      "min": minutes, "result": d.accepted ? "accept" : "reject", "note": d.accepted ? "accept" : "reject",
      "reason": d.reason, "wait": d.waitSec,
      "kw": d.kw, "hit": d.hit,
    ]
    if let a = d.offer.amount { fields["amt"] = a }
    telemetry.log("offer_decided", fields, urgent: true)
    let reasonText: String
    switch d.reason {
    case "accepted": reasonText = "看到接單後的畫面"
    case "rejected": reasonText = "看到未接的畫面"
    case "timeout": reasonText = "\(currentSettings().offer.decideWindowSec) 秒內看不出結果，依設定當" + (d.accepted ? "接單" : "未接")
    case "superseded": reasonText = "又來新邀請，前一張依設定當" + (d.accepted ? "接單" : "未接")
    case "replaced": reasonText = "邀請直接換成另一張"
    default: reasonText = "偵測停止"
    }
    let amountText = d.offer.amount.map { String(format: "%.2f 元・", $0) } ?? ""
    guard d.accepted, let acceptedAt = d.acceptedAt else {
      PandaSignal.post(PandaSignal.offerCleared)
      Task.detached {
        await Notifier.post("未接單：\(minutes) 分鐘", "\(amountText)\(reasonText)，不開倒數", passive: true)
      }
      return
    }
    let now = d.decidedAt
    lastTriggerMinutes = minutes
    lastTriggerAt = now
    triggerCount += 1
    let seq = orderSeq
    orderSeq += 1
    let delay = OfferTracker.delaySeconds(decidedAt: now, acceptedAt: acceptedAt)
    PandaSignal.postAcceptDelay(delay)
    let sent = PandaSignal.postOrder(minutes, seq: seq)
    let text2 = diag()
    var orderFields: [String: Any] = [
      "min": minutes, "seq": seq % PandaSignal.seqMod, "triggers": triggerCount, "kw": d.kw, "accept": true,
      "memMB": currentMB, "peakMB": peakMB, "delay": delay, "reason": d.reason,
      "note": sent ? "signal" : "outOfRange",
    ]
    if let a = d.offer.amount { orderFields["amt"] = a }
    telemetry.log("order", orderFields, urgent: true)
    // userInfo：App 被暫停後才收到訊號時，用這裡的時間（＝按下接受的時間）當接單時間（DetectorNotify.detectedAt，
    // 以分鐘數＋序號配對）。點這則通知 → 系統打開 App → App 回前景就把卡片重推一次（不會重複記錄）。
    let detectedMs = (acceptedAt.timeIntervalSince1970 * 1000).rounded()
    let seqValue = seq % PandaSignal.seqMod
    Task.detached {
      let infoDict: [String: Any] = [
        "pandatimer": "detected", "minutes": minutes, "detectedAt": detectedMs, "seq": seqValue,
      ]
      await Notifier.post(
        "已接單：\(minutes) 分鐘",
        amountText + "\(reasonText)。"
          + (sent ? "已通知 App 開倒數與記錄。動態島沒變→點這則打開 App" : "分鐘數超出 1–90，未通知 App")
          + "\n\(text2)",
        passive: false, userInfo: infoDict)
    }
  }

  /// 畫面分類或接單鈕狀態有變才記一筆（最多每 5 秒一筆，接單鈕狀態改變不受限）
  private func logScreenIfChanged(_ info: ScreenInfo.Summary) {
    let tag = "\(info.screen)|\(info.accept)"
    let now = Date()
    guard tag != lastScreenLogged else { return }
    let acceptChanged = lastScreenLogged.map { !$0.hasSuffix("|\(info.accept)") } ?? true
    if !acceptChanged, let at = lastScreenLoggedAt, now.timeIntervalSince(at) < 5 { return }
    lastScreenLogged = tag
    lastScreenLoggedAt = now
    var fields: [String: Any] = ["screen": info.screen, "accept": info.accept, "kw": info.kw]
    if let m = info.minutes { fields["min"] = m }
    if let a = info.amount { fields["amt"] = a }
    if let km = info.km { fields["km"] = km }
    telemetry.log("screen", fields)
  }

  /// 心跳/開始/停止回報的統計欄位（只有數字）
  private func statsFields() -> [String: Any] {
    lock.lock()
    let frames = framesReceived
    let fails = imageFailures
    let skips = skipped
    let interval = currentInterval
    lock.unlock()
    return [
      "frames": frames, "ocr": ocrCount, "skip": skips, "fails": fails, "errs": ocrErrors,
      "memMB": currentMB, "peakMB": peakMB, "accept": lastSawAccept, "interval": interval,
      "triggers": triggerCount, "dups": dupCount,
    ]
  }

  // MARK: - 診斷

  private func sampleMemory() {
    guard let mem = Memory.footprintMB() else { return }
    currentMB = mem.current
    peakMB = max(peakMB, mem.current, mem.peak)
  }

  private func currentIntervalText() -> String {
    lock.lock()
    let v = currentInterval
    lock.unlock()
    return v == v.rounded() ? String(Int(v)) : String(format: "%.1f", v)
  }

  private func diag() -> String {
    lock.lock()
    let frames = framesReceived
    let fails = imageFailures
    let skips = skipped
    let format = badFormat
    lock.unlock()
    var parts = [
      "幀 \(frames)",
      "OCR \(ocrCount)",
      "跳 \(skips)",
      "\(Int(currentMB.rounded()))/\(Int(peakMB.rounded()))MB",
      lastSawAccept ? "末次:有接單鈕" : "末次:無",
      "間隔\(currentIntervalText())s",
    ]
    if triggerCount > 0, let m = lastTriggerMinutes { parts.append("觸發\(triggerCount)(\(m)分)") }
    if deliveredCount > 0 { parts.append("送達\(deliveredCount)") }
    if memSkips > 0 { parts.append("記憶體跳\(memSkips)") }
    parts.append("設定 \(currentSettings().version)")
    if ocrErrors + fails > 0 { parts.append("錯\(ocrErrors)/\(fails)") }
    if let f = format { parts.append("格式\(String(format: "%08X", f))") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - v0.7 自動送達：送達畫面的邊緣觸發（⚠️ 與 src/deliveryDetector.ts 的 DeliveryEdge 同規則）
// 「從沒有變成有」才送一次；連 2 次 OCR 沒命中才算這次出現結束；送過後 60 秒內再出現也不送。只在 workQueue 用。

final class DeliveryEdge {
  enum Result {
    case idle
    case send
    case repeatSuppressed
  }

  static let goneAfterMisses = 2
  static let repeatSeconds: TimeInterval = 60
  private var visible = false
  private var misses = 0
  private var lastSentAt: Date?

  func observe(_ now: Date, hit: Bool) -> Result {
    if hit {
      misses = 0
      if visible { return .idle }
      visible = true
      if let last = lastSentAt, now.timeIntervalSince(last) < Self.repeatSeconds { return .repeatSuppressed }
      lastSentAt = now
      return .send
    }
    if visible {
      misses += 1
      if misses >= Self.goneAfterMisses {
        visible = false
        misses = 0
      }
    }
    return .idle
  }
}

// MARK: - 灰階小圖（直接取亮度，不經 CIContext）

struct GrayFrame {
  let width: Int
  let height: Int
  /// 灰階位元組（Data：cgImage() 直接包成 CGDataProvider，不再複製）
  let pixels: Data
  let orientation: CGImagePropertyOrientation
  let hash: [UInt64]  // 64×64 平均雜湊，4096 bits

  /// 失敗時回傳 (nil, 不支援的像素格式或 nil)
  static func make(_ sampleBuffer: CMSampleBuffer, bottomFraction: Double, maxLongEdge: Int)
    -> (GrayFrame?, OSType?)
  {
    guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return (nil, nil) }
    var orientation = CGImagePropertyOrientation.up
    if let raw = CMGetAttachment(
      sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
      let o = CGImagePropertyOrientation(rawValue: raw.uint32Value)
    {
      orientation = o
    }
    let format = CVPixelBufferGetPixelFormatType(pb)
    let isBGRA = format == kCVPixelFormatType_32BGRA
    let isYUV =
      format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
      || format == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    guard isBGRA || isYUV else { return (nil, format) }

    CVPixelBufferLockBaseAddress(pb, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
    let base: UnsafeMutableRawPointer?
    let width: Int
    let height: Int
    let stride: Int
    let bpp: Int
    if isYUV {
      base = CVPixelBufferGetBaseAddressOfPlane(pb, 0)
      width = CVPixelBufferGetWidthOfPlane(pb, 0)
      height = CVPixelBufferGetHeightOfPlane(pb, 0)
      stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
      bpp = 1
    } else {
      base = CVPixelBufferGetBaseAddress(pb)
      width = CVPixelBufferGetWidth(pb)
      height = CVPixelBufferGetHeight(pb)
      stride = CVPixelBufferGetBytesPerRow(pb)
      bpp = 4
    }
    guard let raw = base, width > 0, height > 0 else { return (nil, nil) }
    let src = raw.assumingMemoryBound(to: UInt8.self)

    // 直立（.up）：新單資訊卡在下半 → 只取下方 bottomFraction 的列；其他方向不裁，方向交給 Vision
    let y0 = orientation == .up ? Int(Double(height) * (1 - bottomFraction)) : 0
    let cropH = height - y0
    // 非整數倍縮小：長邊剛好 ≤maxLongEdge（整數倍時 1398 列只能縮成 466，字太小）。
    // 每個輸出像素＝對應來源矩形（2–3 px 見方）的平均（盒狀濾波，等同面積平均，字邊不會鋸齒化）。
    let longEdge = max(width, cropH)
    let outW: Int
    let outH: Int
    if longEdge <= maxLongEdge {
      outW = width
      outH = cropH
    } else {
      outW = max(1, width * maxLongEdge / longEdge)
      outH = max(1, cropH * maxLongEdge / longEdge)
    }
    guard outW > 0, outH > 0 else { return (nil, nil) }
    // 預先算好每個輸出欄/列對應的來源範圍 [start, end)
    var xs = [Int](repeating: 0, count: outW + 1)
    for i in 0...outW { xs[i] = i * width / outW }
    var ys = [Int](repeating: 0, count: outH + 1)
    for i in 0...outH { ys[i] = y0 + i * cropH / outH }
    var pixels = [UInt8](repeating: 0, count: outW * outH)
    pixels.withUnsafeMutableBufferPointer { out in
      for oy in 0..<outH {
        let r0 = ys[oy]
        let r1 = max(r0 + 1, ys[oy + 1])
        for ox in 0..<outW {
          let c0 = xs[ox]
          let c1 = max(c0 + 1, xs[ox + 1])
          var sum = 0
          for sy in r0..<r1 {
            let row = src + sy * stride
            for sx in c0..<c1 {
              let p = row + sx * bpp
              if bpp == 1 {
                sum += Int(p[0])
              } else {
                sum += (Int(p[0]) + 2 * Int(p[1]) + Int(p[2])) >> 2  // BGRA → 近似亮度
              }
            }
          }
          out[oy * outW + ox] = UInt8(sum / ((r1 - r0) * (c1 - c0)))
        }
      }
    }
    let frame = GrayFrame(
      width: outW, height: outH, pixels: Data(pixels), orientation: orientation,
      hash: averageHash(pixels, width: outW, height: outH))
    return (frame, nil)
  }

  static func averageHash(_ pixels: [UInt8], width: Int, height: Int) -> [UInt64] {
    let n = 64
    var samples = [Int](repeating: 0, count: n * n)
    var total = 0
    for y in 0..<n {
      let sy = min(height - 1, y * height / n)
      for x in 0..<n {
        let sx = min(width - 1, x * width / n)
        let v = Int(pixels[sy * width + sx])
        samples[y * n + x] = v
        total += v
      }
    }
    let mean = total / (n * n)
    var bits = [UInt64](repeating: 0, count: n * n / 64)
    for i in 0..<(n * n) where samples[i] > mean {
      bits[i >> 6] |= UInt64(1) << UInt64(i & 63)
    }
    return bits
  }

  static func distance(_ a: [UInt64], _ b: [UInt64]) -> Int {
    guard a.count == b.count else { return Int.max }
    var d = 0
    for i in 0..<a.count { d += (a[i] ^ b[i]).nonzeroBitCount }
    return d
  }

  func cgImage() -> CGImage? {
    guard let provider = CGDataProvider(data: pixels as CFData) else { return nil }
    return CGImage(
      width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: width,
      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
      provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
  }
}

// MARK: - OCR（request 只建一次重用；行合併邏輯同 native/intents/PandaIntents.swift 的 ScreenshotOCR）

final class FrameOCR {
  private let request: VNRecognizeTextRequest = {
    let r = VNRecognizeTextRequest()
    r.recognitionLevel = .accurate  // .fast 不支援中文
    r.recognitionLanguages = ["zh-Hant", "en-US"]
    r.usesLanguageCorrection = false
    // 固定 revision（iOS 16+ 的 rev3 支援中文）：不讓系統依 SDK 預設挑，也避免載入其他版本的模型
    r.revision = VNRecognizeTextRequestRevision3
    // 相對圖高；直立裁切後圖高＝長邊 640 → 約 13px 以下的字略過（≈ 原畫面 9pt 以下）。
    // 27 分鐘（大字）、110.26 $、接受訂單（按鈕字）都在 15pt 以上 → 縮圖後約 20px 以上，不受影響。
    r.minimumTextHeight = 0.02
    return r
  }()

  /// v0.7：最近一次 OCR 辨識完當下的記憶體（MB）；只在 workQueue 讀寫
  private(set) var lastInnerMB: Double = 0

  /// v0.6 遠端設定 detector.minimumTextHeight；只在 workQueue 呼叫
  func setMinimumTextHeight(_ value: Float) {
    if request.minimumTextHeight != value { request.minimumTextHeight = value }
  }

  /// 只在 workQueue 呼叫（request 不是執行緒安全的）
  func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> String {
    struct Piece {
      let text: String
      let midY: CGFloat
      let minX: CGFloat
      let height: CGFloat
    }
    // handler 與 observations 只活在這個 autoreleasepool 內：取出字串/位置後立刻釋放（Vision 的中間緩衝跟著走）
    var pieces: [Piece] = []
    var failure: Error?
    autoreleasepool {
      do {
        let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
        try handler.perform([request])
        // v0.7：辨識完、Vision 中間緩衝還沒釋放時量一次（接近這次 OCR 的峰值；給記憶體保護用）
        lastInnerMB = Memory.footprintMB()?.current ?? 0
        for observation in request.results ?? [] {
          guard let candidate = observation.topCandidates(1).first else { continue }
          let box = observation.boundingBox
          pieces.append(Piece(text: candidate.string, midY: box.midY, minX: box.minX, height: box.height))
        }
      } catch {
        failure = error
      }
    }
    if let failure = failure { throw failure }
    pieces.sort { $0.midY > $1.midY }

    var lines: [[Piece]] = []
    for piece in pieces {
      if let last = lines.last, let ref = last.first,
         abs(ref.midY - piece.midY) < max(ref.height, piece.height) * 0.5
      {
        lines[lines.count - 1].append(piece)
      } else {
        lines.append([piece])
      }
    }
    return lines
      .map { $0.sorted { $0.minX < $1.minX }.map(\.text).joined(separator: " ") }
      .joined(separator: "\n")
  }
}

// MARK: - 記憶體（phys_footprint＝jetsam 判定用的數字）

enum Memory {
  static func footprintMB() -> (current: Double, peak: Double)? {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard kr == KERN_SUCCESS else { return nil }
    let mb = 1_048_576.0
    return (Double(info.phys_footprint) / mb, Double(info.ledger_phys_footprint_peak) / mb)
  }
}

// MARK: - 本地通知（授權沿用 App 的；extension 無法跳授權詢問）
// 一律不響聲；passive＝只進通知中心不亮螢幕。不用 timeSensitive/critical（需要 entitlement）。

enum Notifier {
  static func post(_ title: String, _ body: String, passive: Bool, userInfo: [String: Any]? = nil) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = nil
    content.interruptionLevel = passive ? .passive : .active
    if let info = userInfo {
      // 點擊本地通知預設就會打開「所屬 App」（extension 的通知屬於主 App）；targetContentIdentifier 只是標記
      content.userInfo = info
      content.targetContentIdentifier = "pandatimer.detected"
    }
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }
}

// MARK: - 上一輪紀錄（extension 自己的 UserDefaults，跨次保留；用來抓「被系統殺掉」）

enum RunRecord {
  private static let key = "pandatimer.broadcast.lastRun.v1"

  static func save(diag: String, finished: Bool) {
    let record: [String: Any] = ["at": Date().timeIntervalSince1970, "diag": diag, "finished": finished]
    UserDefaults.standard.set(record, forKey: key)
  }

  /// 上一輪沒有走到 broadcastFinished（被 jetsam 殺掉或當掉）→ 發通知附最後一次的診斷；回傳給 telemetry 的摘要
  /// （診斷字只有幀數/OCR 次數/記憶體等統計，沒有畫面內容）
  static func reportPreviousIfCrashed() -> String? {
    guard let last = UserDefaults.standard.dictionary(forKey: key),
          let finished = last["finished"] as? Bool, !finished,
          let at = last["at"] as? Double
    else { return nil }
    let diag = (last["diag"] as? String) ?? ""
    let when = Clock.hms(Date(timeIntervalSince1970: at))
    Task.detached {
      await Notifier.post("⚠️ 上次偵測異常中止", "最後紀錄 \(when)：\(diag)（可能記憶體超過上限被系統關掉）", passive: false)
    }
    return "\(when) \(diag)"
  }
}

enum Clock {
  private static let formatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_Hant_TW")
    f.dateFormat = "HH:mm:ss"
    return f
  }()

  static func hms(_ date: Date) -> String {
    formatter.string(from: date)
  }
}
