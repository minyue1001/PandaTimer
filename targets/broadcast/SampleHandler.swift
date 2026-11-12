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
// v0.8（首日實測：邀請只在畫面上 1~3 秒、閒置 3 秒一次 OCR 常漏；記憶體峰值 70MB；broadcast 常停）：
//   - 每 probeIntervalSeconds（0.2）對原始幀點取樣（FrameProbe：64×64 亮度雜湊＋下方 96×160 色彩取樣，不建圖）→
//     OcrPlanner 決定要不要 OCR：亮綠色金額（GreenEdge）或「畫面變了且靜止」立刻 OCR（最小間隔 0.6 秒），
//     疑似邀請狀態 0.6 秒、閒置 1.5 秒（規則＝src/frameTrigger.ts，以 TS 測試為準）。
//   - OCR 同時最多一個（busy）；每 ocr.rebuildEvery 次重建 VNRecognizeTextRequest；只用 zh-Hant（ocr.englishToo 可加回英文）；
//     每次 OCR 前後的記憶體差最大值寫進 beat 的 dMB。
//   - 夾單：邀請有「夾單」→ 接單時先送 com.pandatimer.offer.stacked 再送 accept.delay＋order。
//   - 送達：「訂單完成」優先；只看到「確認已送達」對話框先待定 delivery.pendingSec 秒（DeliveryEdge＝src/deliveryDetector.ts），
//     送出前先送 com.pandatimer.delivered.delay.<秒>；廣播停止時待定的照對話框時間送出。
//   - broadcastPaused/Resumed 回報 pause/resume；stop 帶最後畫面（screen/kw）方便對照停止原因。
// v0.9 省電（規則＝src/powerSaver.ts，以 TS 測試為準）：
//   - away 模式：連 away.afterMisses 次 OCR 沒有 pandarider 特徵詞（away.keywords）也沒接單鈕、沒在判定邀請/等送達
//     → 取消畫面變化觸發（只留綠色金額觸發）、固定間隔 away.intervalSec（6 秒）、取樣 away.probeIntervalSec（0.5 秒）；
//     看到特徵詞或綠色觸發立刻回正常（AwayTracker；切換時 telemetry "mode"）。
//   - 低電量模式或 thermalState ≥ power.thermalLevel → 所有間隔 ×power.saverFactor（PowerTiming；切換時 telemetry "power"）。
//   - beat 多帶 ocrMin（每分鐘 OCR 次數）/probes（本區間取樣次數）/mode/awaySec/saver/lowPower/thermal。
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

  override func broadcastPaused() {
    detector.paused()
  }

  override func broadcastResumed() {
    detector.resumed()
  }

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
  /// v0.7 自動送達：看到完成/送達畫面（v0.8 App 結截止最早且接單超過 minOrderAgeSec 的進行中單）
  static let delivered = "com.pandatimer.delivered"
  /// v0.8：delivered 前先送「實際送達在幾秒前」（0…60；只看到確認對話框、等「訂單完成」逾時時 > 0）
  static let deliveredDelayPrefix = "com.pandatimer.delivered.delay."
  /// v0.8：夾單（在 accept.delay 之前送；App 2 秒內配對 → 訂單 stacked）
  static let offerStacked = "com.pandatimer.offer.stacked"

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

  static func postDeliveredDelay(_ seconds: Int) {
    post("\(deliveredDelayPrefix)\(min(60, max(0, seconds)))")
  }
}

final class BroadcastDetector {
  // MARK: - 參數（v0.6：由遠端設定下發——server/config.json 的 detector/picker/telemetry 區塊；預設＝下列值＝
  // server/config.default.json＝src/remoteConfig.ts 的 DEFAULT_DETECTOR。缺漏/不合法的欄位用預設，範圍同 RANGES）
  struct DetectorSettings {
    var ocrInterval: CFAbsoluteTime = 1.5
    /// 連續 idleAfterMisses 次 OCR 都沒有接單鈕 → 改用 idleOcrInterval
    var idleOcrInterval: CFAbsoluteTime = 1.5
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
    /// v0.8 偵測更快（src/frameTrigger.ts）：疑似邀請時的 OCR 間隔、畫面變化觸發門檻（4096 bits 中）、
    /// 變化/綠色觸發與上次 OCR 的最小間隔、每幀取樣的最小間隔、亮綠色金額觸發
    var fastOcrInterval: CFAbsoluteTime = 0.6
    var changeMinBits = 120
    var changeMinGap: CFAbsoluteTime = 0.6
    var probeInterval: CFAbsoluteTime = 0.2
    var green = RemoteConfig.GreenTriggerSettings()
    /// 接單鈕正則、分鐘/金額規則（PickerConfig）、回報白名單關鍵字
    var rules = ScreenRules.standard
    /// v0.7 接單判定（遠端設定 "offer"；detector.goneAfterMisses 是 v0.6 用的，v0.7 改看 offer.goneAfterMisses）
    var offer = OfferSettings()
    /// v0.7 自動送達（遠端設定 "delivery"）、OCR 記憶體保護（"ocr"）
    var delivery = RemoteConfig.DeliverySettings()
    var ocrGuard = RemoteConfig.OcrSettings()
    /// v0.9 省電（遠端設定 "away"、"power"）
    var away = RemoteConfig.AwaySettings()
    var power = RemoteConfig.PowerSettings()
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
      fastOcrInterval = RemoteConfig.number(d["fastOcrIntervalSeconds"], 0.3, 10, fastOcrInterval)
      changeMinBits = RemoteConfig.int(d["changeMinBits"], 1, 4096, changeMinBits)
      changeMinGap = RemoteConfig.number(d["changeMinGapSeconds"], 0.2, 10, changeMinGap)
      probeInterval = RemoteConfig.number(d["probeIntervalSeconds"], 0.05, 2, probeInterval)
      green = RemoteConfig.greenTrigger(root)
      rules.picker = PickerConfig(json: RemoteConfig.section(root, "picker"))
      rules.acceptPattern = RemoteConfig.regex(d["acceptPattern"], groups: 0, rules.acceptPattern)
      if let rows = RemoteConfig.telemetry(root).keywords { rules.keywords = rows }
      offer = OfferSettings(root: root)
      rules.acceptedKeywords = offer.acceptedKeywords
      rules.rejectedKeywords = offer.rejectedKeywords
      rules.stackedKeywords = offer.stackedKeywords
      delivery = RemoteConfig.delivery(root)
      rules.completedKeywords = delivery.completedKeywords
      rules.finalKeywords = delivery.finalKeywords
      ocrGuard = RemoteConfig.ocr(root)
      away = RemoteConfig.away(root)
      power = RemoteConfig.power(root)
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
  /// OCR 進行中（保證同時最多一個 OCR；進行中的幀連取樣都不做）
  private var busy = false
  private var lastProbeAt: CFAbsoluteTime = 0
  private var lastOcrAt: CFAbsoluteTime?
  /// v0.8：上次 OCR 時／上一個取樣的 64×64 雜湊
  private var lastOcrHash: [UInt64]?
  private var lastProbeHash: [UInt64]?
  private let greenEdge = GreenEdge()
  private var greenPending = false
  private var fastUntil: CFAbsoluteTime = 0
  /// workQueue 寫入的鏡像（取樣時判斷「疑似邀請」用）
  private var offerActiveFlag = false
  private var lastSawAcceptFlag = false
  private var lastPlanSame = false
  /// 本次心跳區間：綠色比例最大值、各觸發原因次數
  private var greenMax: Double = 0
  private var greenTriggers = 0
  private var trigCounts: [String: Int] = [:]
  private var skipped = 0
  private var imageFailures = 0
  private var badFormat: OSType?
  /// 最近一次取樣實際用的固定 OCR 間隔（含 away/省電倍率；只給診斷/回報顯示）
  private var currentInterval: CFAbsoluteTime = 1.5
  private var settings = DetectorSettings()
  /// v0.9 省電：連續沒接單鈕（閒置間隔）、away 狀態機、省電倍率生效中、本心跳區間取樣次數與 away 秒數
  private var idleFlag = false
  private let awayTracker = AwayTracker()
  private var saverFlag = false
  private var lowPowerNow = false
  private var thermalNow = 0
  private var probeCount = 0
  private var awaySince: CFAbsoluteTime?
  private var awaySecAcc: Double = 0

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
  /// v0.8：本次心跳區間 OCR 前後記憶體差的最大值（MB）、最近一次畫面摘要（stop 時回報）
  private var ocrDeltaMax: Double = 0
  private var lastInfo: ScreenInfo.Summary?
  private var lastWhy = ""
  /// v0.9：上次心跳時的 OCR 次數與時間（算每分鐘 OCR 次數）、省電狀態通知
  private var ocrCountAtBeat = 0
  private var lastBeatAt = Date()
  private var powerObservers: [NSObjectProtocol] = []

  // MARK: - 生命週期（由 SampleHandler 轉呼叫）

  func start() {
    PandaSignal.post(PandaSignal.started)
    // 先套上次快取的遠端設定（沒有就預設），再背景抓最新的
    let initial = DetectorSettings(root: remote.snapshot())
    lock.lock()
    settings = initial
    currentInterval = initial.ocrInterval
    lock.unlock()
    // v0.9：低電量模式/溫度變化 → 重算省電倍率（通知在任意執行緒，轉到 workQueue）
    let center = NotificationCenter.default
    for name in [Notification.Name.NSProcessInfoPowerStateDidChange, ProcessInfo.thermalStateDidChangeNotification] {
      powerObservers.append(
        center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
          guard let self = self else { return }
          self.workQueue.async { self.refreshPower() }
        })
    }
    workQueue.async {
      self.lastBeatAt = Date()
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
    powerObservers.forEach { NotificationCenter.default.removeObserver($0) }
    powerObservers = []
    // v0.7：還在等判定的邀請先結案（offered → 未接；deciding → 依 ambiguousAs），訂單訊號要在 stopped 之前送
    workQueue.sync {
      self.decisionTimer?.cancel()
      self.decisionTimer = nil
      self.handleOffer(self.tracker.finish(Date()), info: nil)
      // v0.8：只看到送達確認對話框、還在等「訂單完成」→ 照對話框時間送出（首日停止常緊接在送達對話框之後）
      if self.currentSettings().delivery.enabled {
        self.handleDelivery(self.deliveryEdge.finish(Date()), info: nil)
      }
    }
    PandaSignal.post(PandaSignal.stopped)
    // 程序在這個方法 return 後就會被結束 → 等最後一則（靜音）摘要通知送出（最多 2 秒）
    let done = DispatchSemaphore(value: 0)
    let sent = DispatchSemaphore(value: 0)
    workQueue.async {
      self.sampleMemory()
      let text = self.diag()
      RunRecord.save(diag: "偵測已停止 \(Clock.hms(Date())) · \(text)", finished: true)
      // v0.8：帶最後一次 OCR 的畫面摘要與距今秒數，對照停止原因（例如送達對話框→拍照）
      var fields = self.statsFields().merging(self.powerFields(reset: false)) { $1 }
      if let i = self.lastInfo {
        fields["screen"] = i.screen
        fields["kw"] = i.kw
      }
      if let at = self.lastOcrDoneAt { fields["wait"] = OfferTracker.round1(Date().timeIntervalSince(at)) }
      self.telemetry.log("stop", fields)
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

  /// v0.8：ReplayKit 暫停/恢復（例如系統畫面、來電）—回報以對照停止原因
  func paused() {
    workQueue.async { self.telemetry.log("pause", self.statsFields(), urgent: true) }
  }

  func resumed() {
    workQueue.async { self.telemetry.log("resume", self.statsFields(), urgent: true) }
  }

  /// 每 60 秒（遠端可調）：心跳給 App；記錄本輪診斷（被系統殺掉時下次開始會回報）；峰值超過門檻發靜音通知；
  /// 每 refreshSeconds 重抓一次遠端設定
  private func heartbeat() {
    PandaSignal.post(PandaSignal.heartbeat)
    sampleMemory()
    refreshPower()
    let text = diag()
    RunRecord.save(diag: text, finished: false)
    telemetry.log("beat", statsFields().merging(powerFields(reset: true)) { $1 })
    // dMB / green / trig 是「這個心跳區間」的值
    ocrDeltaMax = 0
    lock.lock()
    greenMax = 0
    trigCounts = [:]
    lock.unlock()
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
    idleFlag = missStreak >= next.idleAfterMisses
    lock.unlock()
    ocr.setMinimumTextHeight(Float(next.minimumTextHeight))
    let t = RemoteConfig.telemetry(root)
    telemetry.configure(flushSeconds: t.flushSeconds, batchSize: t.batchSize)
    telemetry.setContext(["cfg": next.version])
    tracker.settings = next.offer
    tracker.dedupeSeconds = next.dedupeWindow
    deliveryEdge.pendingSec = TimeInterval(next.delivery.pendingSec)
    ocr.configure(englishToo: next.ocrGuard.englishToo, rebuildEvery: next.ocrGuard.rebuildEvery)
    if old.heartbeatInterval != next.heartbeatInterval, let timer = heartbeatTimer {
      timer.schedule(
        deadline: .now() + .seconds(next.heartbeatInterval), repeating: .seconds(next.heartbeatInterval),
        leeway: .seconds(5))
    }
    refreshPower()
  }

  // MARK: - v0.9 省電（只在 workQueue）

  /// 低電量模式/溫度 → 省電倍率生效與否；有變化記 telemetry "power"
  private func refreshPower() {
    let s = currentSettings()
    let d = RemoteConfig.deviceSaver(s.power)
    lock.lock()
    let changed = d.saver != saverFlag
    saverFlag = d.saver
    lowPowerNow = d.lowPower
    thermalNow = d.thermal
    lock.unlock()
    if changed {
      telemetry.log(
        "power", ["saver": d.saver, "lowPower": d.lowPower, "thermal": d.thermal, "note": d.saver ? "on" : "off"],
        urgent: false)
    }
  }

  /// away 進出記帳（呼叫端持 lock）
  private func noteModeLocked(_ away: Bool, now: CFAbsoluteTime) {
    if away {
      if awaySince == nil { awaySince = now }
    } else if let since = awaySince {
      awaySecAcc += max(0, now - since)
      awaySince = nil
    }
  }

  private func logMode(_ c: AwayTracker.Change, trig: String) {
    telemetry.log("mode", ["mode": c.away ? "away" : "normal", "reason": c.reason, "trig": trig])
  }

  /// 心跳/停止回報的省電量測欄位；reset＝心跳（區間值歸零）
  private func powerFields(reset: Bool) -> [String: Any] {
    let now = Date()
    let elapsed = max(1, now.timeIntervalSince(lastBeatAt))
    let ocrs = ocrCount - ocrCountAtBeat
    let t = CFAbsoluteTimeGetCurrent()
    lock.lock()
    let probes = probeCount
    let awaySec = awaySecAcc + (awaySince.map { max(0, t - $0) } ?? 0)
    let away = awayTracker.away
    let saver = saverFlag
    let low = lowPowerNow
    let thermal = thermalNow
    if reset {
      probeCount = 0
      awaySecAcc = 0
      if awaySince != nil { awaySince = t }
    }
    lock.unlock()
    if reset {
      ocrCountAtBeat = ocrCount
      lastBeatAt = now
    }
    return [
      "ocrMin": (Double(ocrs) * 60 / elapsed * 10).rounded() / 10, "probes": probes,
      "mode": away ? "away" : "normal", "awaySec": Int(awaySec.rounded()), "saver": saver, "lowPower": low,
      "thermal": thermal,
    ]
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

  /// v0.8：每 probeIntervalSeconds 取樣一次（點取樣，不建圖）→ OcrPlanner 決定要不要 OCR（規則＝src/frameTrigger.ts）。
  /// OCR 進行中（busy）連取樣都不做 → 同時最多一個 OCR。
  func process(_ sampleBuffer: CMSampleBuffer) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    framesReceived += 1
    let s = settings
    // v0.9：away 0.5 秒、正常 0.2 秒取樣；省電再 ×saverFactor
    let probeEvery = PowerTiming.make(s, away: awayTracker.away, saver: saverFlag).probe
    let due = !busy && now - lastProbeAt >= probeEvery
    if due {
      busy = true
      lastProbeAt = now
      probeCount += 1
    }
    lock.unlock()
    guard due else { return }  // 節流＋OCR 進行中就丟幀

    var probe: FrameProbe?
    var format: OSType?
    autoreleasepool {
      (probe, format) = FrameProbe.make(sampleBuffer, hashFraction: s.bottomFraction, green: s.green)
    }
    guard let p = probe else {
      lock.lock()
      imageFailures += 1
      if let f = format { badFormat = f }
      busy = false
      lock.unlock()
      return
    }

    lock.lock()
    let ratio = p.greenTotal > 0 ? Double(p.greenCount) / Double(p.greenTotal) : 0
    if ratio > greenMax { greenMax = ratio }
    let greenHit = s.green.enabled && p.greenTotal > 0 && ratio >= s.green.minRatio
    var modeChange: AwayTracker.Change?
    if greenEdge.observe(hit: greenHit) {
      greenPending = true
      greenTriggers += 1
      fastUntil = now + s.green.holdSec
      // v0.9：疑似邀請 → 離開 away
      modeChange = awayTracker.observeGreen()
      if let c = modeChange { noteModeLocked(c.away, now: now) }
    }
    let diffOcr = lastOcrHash.map { GrayFrame.distance($0, p.hash) }
    let diffPrev = lastProbeHash.map { GrayFrame.distance($0, p.hash) }
    lastProbeHash = p.hash
    let fast = OcrPlanner.isFast(
      now: now, fastUntil: fastUntil, offerActive: offerActiveFlag, lastSawAccept: lastSawAcceptFlag)
    let timing = PowerTiming.make(s, away: awayTracker.away, saver: saverFlag)
    let t = timing.s
    let interval = fast ? t.fastOcrInterval : (idleFlag ? t.idleOcrInterval : t.ocrInterval)
    currentInterval = interval
    let plan = OcrPlanner.plan(
      now: now, lastOcrAt: lastOcrAt, interval: interval, fast: fast,
      diffFromOcr: diffOcr, diffFromPrev: diffPrev, greenPending: greenPending, s: t,
      changeEnabled: timing.changeEnabled)
    if let c = modeChange { logMode(c, trig: "green") }
    guard let why = plan.why else {
      if plan.same && !lastPlanSame { skipped += 1 }  // 同畫面跳過：每段只算一次
      lastPlanSame = plan.same
      busy = false
      lock.unlock()
      return
    }
    lastPlanSame = false
    greenPending = false
    lastOcrHash = p.hash
    lastOcrAt = now
    trigCounts[why, default: 0] += 1
    lock.unlock()

    // 在回呼內就把畫面縮成小灰階圖，不把 ReplayKit 的 pixel buffer 帶到別的執行緒
    var made: GrayFrame?
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

    workQueue.async {
      autoreleasepool {
        self.runOCR(frame, why: why)
      }
      self.lock.lock()
      self.busy = false
      self.lock.unlock()
    }
  }

  private func runOCR(_ frame: GrayFrame, why: String) {
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
        telemetry.log("memSkip", ["memMB": currentMB, "peakMB": peakMB, "skip": memSkips, "trig": why])
      }
      return
    }
    let beforeMB = currentMB
    // OCR 中量到偏高 → 之後 120 秒只認大字（文字很多的畫面 Vision 峰值較高；接單鈕/分鐘數/完成訂單都是大字）
    let highMem = (highMemUntil.map { Date() < $0 } ?? false) || currentMB > s.ocrGuard.memSkipMB
    ocr.setMinimumTextHeight(Float(highMem ? max(s.minimumTextHeight, 0.03) : s.minimumTextHeight))
    let info: ScreenInfo.Summary
    // v0.9：畫面上有沒有 pandarider（特徵詞或接單鈕）；原文同樣不離開這裡
    var panda = false
    do {
      guard let image = frame.cgImage() else {
        ocrErrors += 1
        return
      }
      let ocrText = try ocr.recognize(image, orientation: frame.orientation)
      let analyzed = ScreenInfo.analyzeWithPresence(ocrText, rules: s.rules, awayKeywords: s.away.keywords)
      info = analyzed.summary
      panda = analyzed.panda
    } catch {
      ocrErrors += 1
      return
    }
    ocrCount += 1
    lastOcrDoneAt = Date()
    lastWhy = why
    // v0.8：這次 OCR 讓記憶體多了多少（辨識完、Vision 中間緩衝還沒釋放時量的 lastInnerMB − OCR 前）
    ocrDeltaMax = max(ocrDeltaMax, ocr.lastInnerMB - beforeMB)
    sampleMemory()
    if ocr.lastInnerMB > s.ocrGuard.memHighMB {
      if !highMem {
        telemetry.log(
          "memHigh",
          ["memMB": ocr.lastInnerMB, "peakMB": peakMB, "dMB": ocr.lastInnerMB - beforeMB, "screen": info.screen,
           "kw": info.kw, "trig": why])
      }
      highMemUntil = Date().addingTimeInterval(120)
      ocr.rebuild()  // 連 request 留著的上一批觀測結果一起放掉
    }
    lastSawAccept = info.accept
    lastInfo = info
    missStreak = info.accept ? 0 : missStreak + 1
    logScreenIfChanged(info, why: why)

    // v0.7：邀請狀態機（不再「看到邀請就送訊號」；接單判定見 OfferTracker.swift）
    handleOffer(tracker.observe(Date(), OfferObservation(info)), info: info)
    // v0.7 自動送達（邊緣觸發＋60 秒不重送；v0.8 訂單完成優先、對話框待定；App 端挑單/互斥見 DetectorHub.AutoDelivery）
    if s.delivery.enabled {
      handleDelivery(deliveryEdge.observe(Date(), hit: info.delivered, final: info.deliveredFinal), info: info)
    }
    scheduleDecisionTimer()
    // v0.8：疑似邀請（接單鈕/判定中/綠色 hold）的快速間隔在取樣時決定；這裡只決定一般/閒置
    // v0.9：away 判定（邀請判定中、送達待定中都算在 pandarider）
    let busyWithOffer = tracker.isActive || deliveryEdge.deadline != nil
    lock.lock()
    idleFlag = missStreak >= s.idleAfterMisses
    lastSawAcceptFlag = info.accept
    offerActiveFlag = tracker.isActive
    let change = awayTracker.observeOcr(panda: panda, offerActive: busyWithOffer, s.away)
    if let c = change { noteModeLocked(c.away, now: CFAbsoluteTimeGetCurrent()) }
    lock.unlock()
    if let c = change { logMode(c, trig: why) }
  }

  /// v0.8 送達動作（只在 workQueue）：send＝先送延遲再送 delivered；pending＝只看到確認對話框；repeat＝60 秒內送過
  private func handleDelivery(_ action: DeliveryEdge.Action, info: ScreenInfo.Summary?) {
    var fields: [String: Any] = [:]
    if let i = info {
      fields["hit"] = i.deliveredHit
      fields["kw"] = i.kw
      fields["screen"] = i.screen
    }
    switch action {
    case .send(let delay, let why):
      deliveredCount += 1
      PandaSignal.postDeliveredDelay(delay)
      PandaSignal.post(PandaSignal.delivered)
      fields["note"] = "signal"
      fields["reason"] = why
      fields["delay"] = delay
      telemetry.log("delivered_seen", fields, urgent: true)
    case .pending:
      fields["note"] = "pending"
      telemetry.log("delivered_seen", fields)
    case .repeatSuppressed:
      fields["note"] = "repeat"
      telemetry.log("delivered_seen", fields)
    case .idle:
      break
    }
  }

  // MARK: - v0.7 邀請 → 接單判定（只在 workQueue）

  /// deciding 的視窗到期／v0.8 送達待定到期：畫面靜止時 ReplayKit 不送幀、OCR 不會跑 → 另排計時器推進狀態機
  private func scheduleDecisionTimer() {
    decisionTimer?.cancel()
    decisionTimer = nil
    let deadlines = [tracker.deadline, deliveryEdge.deadline].compactMap { $0 }
    guard let deadline = deadlines.min() else { return }
    let item = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.decisionTimer = nil
      self.handleOffer(self.tracker.tick(Date()), info: nil)
      if self.currentSettings().delivery.enabled {
        self.handleDelivery(self.deliveryEdge.tick(Date()), info: nil)
      }
      self.lock.lock()
      self.offerActiveFlag = self.tracker.isActive
      self.lock.unlock()
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
        var fields: [String: Any] = ["min": offer.minutes, "note": "pending", "trig": lastWhy, "stacked": offer.stacked]
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
      "kw": d.kw, "hit": d.hit, "stacked": d.offer.stacked,
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
    let stacked = d.offer.stacked
    if stacked { PandaSignal.post(PandaSignal.offerStacked) }  // v0.8：先夾單、再延遲、最後 order
    PandaSignal.postAcceptDelay(delay)
    let sent = PandaSignal.postOrder(minutes, seq: seq)
    let text2 = diag()
    var orderFields: [String: Any] = [
      "min": minutes, "seq": seq % PandaSignal.seqMod, "triggers": triggerCount, "kw": d.kw, "accept": true,
      "memMB": currentMB, "peakMB": peakMB, "delay": delay, "reason": d.reason,
      "note": sent ? "signal" : "outOfRange", "stacked": stacked,
    ]
    if let a = d.offer.amount { orderFields["amt"] = a }
    telemetry.log("order", orderFields, urgent: true)
    // userInfo：App 被暫停後才收到訊號時，用這裡的時間（＝按下接受的時間）當接單時間（DetectorNotify.detectedAt，
    // 以分鐘數＋序號配對）。點這則通知 → 系統打開 App → App 回前景就把卡片重推一次（不會重複記錄）。
    let detectedMs = (acceptedAt.timeIntervalSince1970 * 1000).rounded()
    let seqValue = seq % PandaSignal.seqMod
    Task.detached {
      let infoDict: [String: Any] = [
        "pandatimer": "detected", "minutes": minutes, "detectedAt": detectedMs, "seq": seqValue, "stacked": stacked,
      ]
      await Notifier.post(
        "已接單：\(minutes) 分鐘" + (stacked ? "（夾單）" : ""),
        amountText + "\(reasonText)。"
          + (sent ? "已通知 App 開倒數與記錄。動態島沒變→點這則打開 App" : "分鐘數超出 1–90，未通知 App")
          + "\n\(text2)",
        passive: false, userInfo: infoDict)
    }
  }

  /// 畫面分類或接單鈕狀態有變才記一筆（最多每 5 秒一筆，接單鈕狀態改變不受限）
  private func logScreenIfChanged(_ info: ScreenInfo.Summary, why: String) {
    let tag = "\(info.screen)|\(info.accept)"
    let now = Date()
    guard tag != lastScreenLogged else { return }
    let acceptChanged = lastScreenLogged.map { !$0.hasSuffix("|\(info.accept)") } ?? true
    if !acceptChanged, let at = lastScreenLoggedAt, now.timeIntervalSince(at) < 5 { return }
    lastScreenLogged = tag
    lastScreenLoggedAt = now
    var fields: [String: Any] = ["screen": info.screen, "accept": info.accept, "kw": info.kw, "trig": why]
    if info.stacked { fields["stacked"] = true }
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
    let green = greenMax
    let trig = trigCounts.sorted { $0.key < $1.key }.map { "\($0.key)\($0.value)" }.joined(separator: " ")
    lock.unlock()
    return [
      "frames": frames, "ocr": ocrCount, "skip": skips, "fails": fails, "errs": ocrErrors,
      "memMB": currentMB, "peakMB": peakMB, "accept": lastSawAccept, "interval": interval,
      "triggers": triggerCount, "dups": dupCount,
      // v0.8：OCR 前後記憶體差最大值、綠色比例最大值（本心跳區間）、各觸發原因的 OCR 次數（例 "change3 green1 interval40"）
      "dMB": (ocrDeltaMax * 10).rounded() / 10, "green": (green * 10000).rounded() / 10000,
      "trig": trig.isEmpty ? "-" : trig,
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
    lock.lock()
    let away = awayTracker.away
    let saver = saverFlag
    lock.unlock()
    if away { parts.append("非熊貓畫面(慢速)") }
    if saver { parts.append("省電中") }
    parts.append("設定 \(currentSettings().version)")
    if ocrErrors + fails > 0 { parts.append("錯\(ocrErrors)/\(fails)") }
    if let f = format { parts.append("格式\(String(format: "%08X", f))") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - v0.7 自動送達：送達畫面的邊緣觸發（⚠️ 與 src/deliveryDetector.ts 的 DeliveryEdge 同規則，以 TS 測試為準）
// 「從沒有變成有」才動作；連 2 次 OCR 沒命中才算這次出現結束；送過後 60 秒內再出現也不送。只在 workQueue 用。
// v0.8：命中 finalKeywords（訂單完成）→ 立刻送（delay 0）；只命中其他 completedKeywords（送達確認對話框）→ 待定，
//   pendingSec 內出現「訂單完成」改送那個時間、到期以對話框時間送（delay＝到期 − 對話框出現）；廣播停止時待定的照樣送出。

final class DeliveryEdge {
  enum Action {
    case idle
    case send(delay: Int, why: String)
    case pending
    case repeatSuppressed
  }

  static let goneAfterMisses = 2
  static let repeatSeconds: TimeInterval = 60
  var pendingSec: TimeInterval = 30
  private var visible = false
  private var misses = 0
  private var lastSentAt: Date?
  private var pendingAt: Date?

  /// 待定到期時間（呼叫端排計時器）
  var deadline: Date? { pendingAt.map { $0.addingTimeInterval(pendingSec) } }

  func observe(_ now: Date, hit: Bool, final isFinal: Bool) -> Action {
    if hit {
      misses = 0
      if isFinal && pendingAt != nil {
        pendingAt = nil
        visible = true
        lastSentAt = now
        return .send(delay: 0, why: "finalAfterPending")
      }
      if visible { return tick(now) }
      visible = true
      if let last = lastSentAt, now.timeIntervalSince(last) < Self.repeatSeconds { return .repeatSuppressed }
      if isFinal || pendingSec <= 0 {
        lastSentAt = now
        return .send(delay: 0, why: isFinal ? "final" : "immediate")
      }
      pendingAt = now
      return .pending
    }
    if visible {
      misses += 1
      if misses >= Self.goneAfterMisses {
        visible = false
        misses = 0
      }
    }
    return tick(now)
  }

  func tick(_ now: Date) -> Action {
    guard let at = pendingAt, now.timeIntervalSince(at) >= pendingSec else { return .idle }
    return flush(now, why: "timeout")
  }

  func finish(_ now: Date) -> Action {
    pendingAt == nil ? .idle : flush(now, why: "stopped")
  }

  private func flush(_ now: Date, why: String) -> Action {
    let at = pendingAt ?? now
    pendingAt = nil
    lastSentAt = now
    let d = now.timeIntervalSince(at).rounded()
    return .send(delay: d.isFinite ? min(60, max(0, Int(d))) : 0, why: why)
  }
}

// MARK: - v0.8 每幀取樣（⚠️ 與 src/frameTrigger.ts 同規則）：64×64 亮度雜湊＋下方 96×160 亮綠色取樣，不建任何圖。
// YUV（420f/420v）多讀 CbCr 平面同位置的 2 bytes；BGRA 讀同一批點換算成 YCbCr。額外記憶體：雜湊樣本 4096 個 Int（32KB，用完即丟）。

struct FrameProbe {
  static let hashGrid = 64
  static let greenW = 96
  static let greenH = 160

  let hash: [UInt64]
  let greenCount: Int
  let greenTotal: Int

  /// BT.601 全幅 RGB → YCbCr（同 TS rgbToYCbCr）
  static func ycbcr(r: Int, g: Int, b: Int) -> (Int, Int, Int) {
    func c(_ v: Double) -> Int { min(255, max(0, Int(v.rounded()))) }
    let rd = Double(r)
    let gd = Double(g)
    let bd = Double(b)
    let y = c((299 * rd + 587 * gd + 114 * bd) / 1000)
    let cb = c(128 + (-169 * rd - 331 * gd + 500 * bd) / 1000)
    let cr = c(128 + (500 * rd - 419 * gd - 81 * bd) / 1000)
    return (y, cb, cr)
  }

  static func isGreen(y: Int, cb: Int, cr: Int, _ s: RemoteConfig.GreenTriggerSettings) -> Bool {
    y >= s.yMin && cb <= s.cbMax && cr <= s.crMax
  }

  static func make(_ sampleBuffer: CMSampleBuffer, hashFraction: Double, green: RemoteConfig.GreenTriggerSettings)
    -> (FrameProbe?, OSType?)
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
    var chroma: UnsafeMutableRawPointer?
    var chromaStride = 0
    let width: Int
    let height: Int
    let stride: Int
    if isYUV {
      base = CVPixelBufferGetBaseAddressOfPlane(pb, 0)
      width = CVPixelBufferGetWidthOfPlane(pb, 0)
      height = CVPixelBufferGetHeightOfPlane(pb, 0)
      stride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
      chroma = CVPixelBufferGetBaseAddressOfPlane(pb, 1)
      chromaStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1)
    } else {
      base = CVPixelBufferGetBaseAddress(pb)
      width = CVPixelBufferGetWidth(pb)
      height = CVPixelBufferGetHeight(pb)
      stride = CVPixelBufferGetBytesPerRow(pb)
    }
    guard let raw = base, width > 0, height > 0, !isYUV || chroma != nil else { return (nil, nil) }
    let src = raw.assumingMemoryBound(to: UInt8.self)
    let csrc = chroma?.assumingMemoryBound(to: UInt8.self)
    let up = orientation == .up

    // 亮度雜湊（裁切同 GrayFrame：直立只看下方 hashFraction）
    let n = hashGrid
    let hy0 = up ? Int(Double(height) * (1 - hashFraction)) : 0
    let hH = max(1, height - hy0)
    var samples = [Int](repeating: 0, count: n * n)
    var total = 0
    for j in 0..<n {
      let sy = min(height - 1, hy0 + (j * hH + hH / 2) / n)
      let row = src + sy * stride
      for i in 0..<n {
        let sx = min(width - 1, (i * width + width / 2) / n)
        let v: Int
        if isYUV {
          v = Int(row[sx])
        } else {
          let p = row + sx * 4
          v = (Int(p[0]) + 2 * Int(p[1]) + Int(p[2])) >> 2
        }
        samples[j * n + i] = v
        total += v
      }
    }
    let mean = total / (n * n)
    var bits = [UInt64](repeating: 0, count: n * n / 64)
    for i in 0..<(n * n) where samples[i] > mean {
      bits[i >> 6] |= UInt64(1) << UInt64(i & 63)
    }

    // 亮綠色取樣（下方 regionFraction）
    var greenCount = 0
    var greenTotal = 0
    if green.enabled {
      let gy0 = up ? Int(Double(height) * (1 - green.regionFraction)) : 0
      let gH = max(1, height - gy0)
      for j in 0..<greenH {
        let sy = min(height - 1, gy0 + (j * gH + gH / 2) / greenH)
        let row = src + sy * stride
        for i in 0..<greenW {
          let sx = min(width - 1, (i * width + width / 2) / greenW)
          var y = 0
          var cb = 128
          var cr = 128
          if let c = csrc {
            y = Int(row[sx])
            let cp = c + (sy >> 1) * chromaStride + (sx >> 1) * 2
            cb = Int(cp[0])
            cr = Int(cp[1])
          } else {
            let p = row + sx * 4
            (y, cb, cr) = ycbcr(r: Int(p[2]), g: Int(p[1]), b: Int(p[0]))
          }
          greenTotal += 1
          if isGreen(y: y, cb: cb, cr: cr, green) { greenCount += 1 }
        }
      }
    }
    return (FrameProbe(hash: bits, greenCount: greenCount, greenTotal: greenTotal), nil)
  }
}

/// 綠色邊緣觸發（同 TS GreenEdge）：從沒有變成有 → true；連 2 次取樣沒有才算消失。呼叫端持 lock
final class GreenEdge {
  static let goneAfter = 2
  private var on = false
  private var misses = 0

  func observe(hit: Bool) -> Bool {
    if hit {
      misses = 0
      if on { return false }
      on = true
      return true
    }
    if on {
      misses += 1
      if misses >= Self.goneAfter {
        on = false
        misses = 0
      }
    }
    return false
  }
}

/// 要不要現在 OCR（同 TS planOcr / isFast；時間：秒）
enum OcrPlanner {
  /// 疑似邀請狀態下，同畫面最多跳過這麼久（秒）
  static let fastForceSeconds: CFAbsoluteTime = 2

  struct Plan {
    /// nil＝不 OCR；否則 first / green / change / interval / force
    let why: String?
    /// 不 OCR 的原因是「同畫面」（否則是還沒到間隔）
    let same: Bool
  }

  static func isFast(now: CFAbsoluteTime, fastUntil: CFAbsoluteTime, offerActive: Bool, lastSawAccept: Bool) -> Bool {
    offerActive || lastSawAccept || now < fastUntil
  }

  static func plan(
    now: CFAbsoluteTime, lastOcrAt: CFAbsoluteTime?, interval: CFAbsoluteTime, fast: Bool,
    diffFromOcr: Int?, diffFromPrev: Int?, greenPending: Bool, s: BroadcastDetector.DetectorSettings,
    changeEnabled: Bool = true
  ) -> Plan {
    guard let last = lastOcrAt else { return Plan(why: "first", same: false) }
    let since = now - last
    if since >= s.changeMinGap {
      if greenPending { return Plan(why: "green", same: false) }
      let settled = diffFromPrev.map { $0 <= s.sameFrameMaxBits } ?? false
      if changeEnabled, let d = diffFromOcr, d > s.changeMinBits, settled { return Plan(why: "change", same: false) }
    }
    if since < interval { return Plan(why: nil, same: false) }
    let same = diffFromOcr.map { $0 <= s.sameFrameMaxBits } ?? false
    if !same { return Plan(why: "interval", same: false) }
    let force = fast ? min(s.forceOcrInterval, fastForceSeconds) : s.forceOcrInterval
    return since >= force ? Plan(why: "force", same: false) : Plan(why: nil, same: true)
  }
}

// MARK: - v0.9 省電（⚠️ 與 src/powerSaver.ts 同規則，以 TS 測試為準）

/// away 狀態機（同 TS AwayTracker）：連 afterMisses 次 OCR 沒有 pandarider → away；看到特徵詞/判定中/綠色觸發 → 回正常。呼叫端持 lock
final class AwayTracker {
  struct Change {
    let away: Bool
    /// noPanda / panda / offer / green / disabled
    let reason: String
  }

  private(set) var away = false
  private(set) var misses = 0

  func observeOcr(panda: Bool, offerActive: Bool, _ s: RemoteConfig.AwaySettings) -> Change? {
    if !s.enabled {
      misses = 0
      guard away else { return nil }
      away = false
      return Change(away: false, reason: "disabled")
    }
    if panda || offerActive {
      misses = 0
      guard away else { return nil }
      away = false
      return Change(away: false, reason: panda ? "panda" : "offer")
    }
    misses += 1
    if away || misses < s.afterMisses { return nil }
    away = true
    return Change(away: true, reason: "noPanda")
  }

  func observeGreen() -> Change? {
    misses = 0
    guard away else { return nil }
    away = false
    return Change(away: false, reason: "green")
  }
}

/// 依模式算這次取樣用的排程參數（同 TS effectiveTiming）：away → 一般/閒置間隔＝away.intervalSec、取樣＝away.probeIntervalSec、
/// 不做畫面變化觸發；saver → 所有間隔 ×power.saverFactor
enum PowerTiming {
  static func make(_ s: BroadcastDetector.DetectorSettings, away: Bool, saver: Bool)
    -> (s: BroadcastDetector.DetectorSettings, probe: CFAbsoluteTime, changeEnabled: Bool)
  {
    let f = saver ? s.power.saverFactor : 1
    var t = s
    t.ocrInterval = (away ? s.away.intervalSec : s.ocrInterval) * f
    t.idleOcrInterval = (away ? s.away.intervalSec : s.idleOcrInterval) * f
    t.fastOcrInterval = s.fastOcrInterval * f
    t.changeMinGap = s.changeMinGap * f
    t.forceOcrInterval = s.forceOcrInterval * f
    let probe = (away ? s.away.probeIntervalSec : s.probeInterval) * f
    return (t, probe, !away)
  }
}

// MARK: - 灰階小圖（直接取亮度，不經 CIContext）

struct GrayFrame {
  let width: Int
  let height: Int
  /// 灰階位元組（Data：cgImage() 直接包成 CGDataProvider，不再複製）
  let pixels: Data
  let orientation: CGImagePropertyOrientation

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
    let frame = GrayFrame(width: outW, height: outH, pixels: Data(pixels), orientation: orientation)
    return (frame, nil)
  }

  /// 雜湊距離（v0.8 雜湊改由 FrameProbe 每次取樣產生）
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

// MARK: - OCR（行合併邏輯同 native/intents/PandaIntents.swift 的 ScreenshotOCR）
// v0.8：request 重用，但每 ocr.rebuildEvery 次（或量到 memHigh）重建——重用的 request 會一直抱著上一批觀測結果，
//   重建也讓 Vision 放掉跟這個 request 綁的中間狀態；語言只用 zh-Hant（ocr.englishToo=true 才加 en-US，少載一個語言模型；
//   數字、$、公里、分鐘在 zh-Hant 模型可辨——實機待驗，不行就遠端把 englishToo 打開）。

final class FrameOCR {
  private var request: VNRecognizeTextRequest
  private var languages = ["zh-Hant"]
  private var minimumTextHeight: Float = 0.02
  private var uses = 0
  private var rebuildEvery = 30
  /// 重建次數（診斷用）
  private(set) var rebuilds = 0

  init() {
    request = Self.makeRequest(languages: ["zh-Hant"], minimumTextHeight: 0.02)
  }

  private static func makeRequest(languages: [String], minimumTextHeight: Float) -> VNRecognizeTextRequest {
    let r = VNRecognizeTextRequest()
    r.recognitionLevel = .accurate  // .fast 不支援中文
    r.recognitionLanguages = languages
    r.usesLanguageCorrection = false
    // 固定 revision（iOS 16+ 的 rev3 支援中文）：不讓系統依 SDK 預設挑，也避免載入其他版本的模型
    r.revision = VNRecognizeTextRequestRevision3
    // 相對圖高；直立裁切後圖高＝長邊 640 → 約 13px 以下的字略過（≈ 原畫面 9pt 以下）。
    // 27 分鐘（大字）、110.26 $、接受訂單（按鈕字）都在 15pt 以上 → 縮圖後約 20px 以上，不受影響。
    r.minimumTextHeight = minimumTextHeight
    return r
  }

  /// v0.7：最近一次 OCR 辨識完當下的記憶體（MB）；只在 workQueue 讀寫
  private(set) var lastInnerMB: Double = 0

  /// v0.6 遠端設定 detector.minimumTextHeight；只在 workQueue 呼叫
  func setMinimumTextHeight(_ value: Float) {
    guard minimumTextHeight != value else { return }
    minimumTextHeight = value
    request.minimumTextHeight = value
  }

  /// v0.8 遠端設定 ocr.englishToo / rebuildEvery；只在 workQueue 呼叫
  func configure(englishToo: Bool, rebuildEvery: Int) {
    self.rebuildEvery = max(1, rebuildEvery)
    let langs = englishToo ? ["zh-Hant", "en-US"] : ["zh-Hant"]
    if langs != languages {
      languages = langs
      rebuild()
    }
  }

  /// 丟掉舊 request（連同它抱著的上一批結果）換新的；只在 workQueue 呼叫
  func rebuild() {
    request = Self.makeRequest(languages: languages, minimumTextHeight: minimumTextHeight)
    uses = 0
    rebuilds += 1
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
    if uses >= rebuildEvery { rebuild() }
    uses += 1
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
