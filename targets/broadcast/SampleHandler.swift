import ActivityKit
import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import ReplayKit
import UserNotifications
import Vision

// v0.3「螢幕廣播自動偵測」最小驗證版（ReplayKit Broadcast Upload Extension，獨立程序、記憶體上限約 50MB）。
// 沒有 App Group → 不能跟 App 共享資料。唯一通道：App 前景先開一張「待命」Live Activity，
// 這裡用 Activity<PandaTimerAttributes>.activities 找到它並 update（是否可行＝本版要驗證的事）。
// 看不到卡片時改用本地通知回報（結果 B），讓使用者不用 Mac/Console 也看得出結果。
//
// 省記憶體：每秒最多處理 1 幀、忙就丟幀；裁切畫面下方 60%（新單資訊卡在下半）再縮到長邊 ≤ 1000px；
// CIContext 只建一次；每幀包 autoreleasepool。
//
// SampleHandler 只轉呼叫；邏輯放在一般類別 BroadcastDetector（不繼承 SDK 類別，避免 SDK 對
// RPBroadcastSampleHandler 加的 actor 標註影響背景佇列上的呼叫）。
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

final class BroadcastDetector {
  // MARK: - 參數
  private let ocrInterval: CFAbsoluteTime = 1.0
  private let heartbeatInterval: Int = 60
  private let dedupeWindow: TimeInterval = 180
  private let blindNoticeInterval: TimeInterval = 600
  private let maxLongEdge: CGFloat = 1000
  private let bottomFraction: CGFloat = 0.6

  // MARK: - 狀態
  private let workQueue = DispatchQueue(label: "com.pandatimer.broadcast.work", qos: .userInitiated)
  private let lock = NSLock()
  private let ciContext = CIContext(options: [
    .useSoftwareRenderer: true,  // 背景程序送 GPU 工作可能被拒，CPU 較穩（1 秒 1 幀負擔得起）
    .cacheIntermediates: false,
    .workingColorSpace: NSNull(),
  ])
  private var heartbeatTimer: DispatchSourceTimer?

  // lock 保護（ReplayKit 回呼執行緒 ↔ workQueue）
  private var framesReceived = 0
  private var busy = false
  private var lastOcrStart: CFAbsoluteTime = 0
  private var imageFailures = 0

  // 只在 workQueue 存取
  private var ocrCount = 0
  private var ocrErrors = 0
  private var currentMB: Double = 0
  private var peakMB: Double = 0
  private var lastSawAccept = false
  private var lastTriggerMinutes: Int?
  private var lastTriggerAt: Date?
  private var triggerCount = 0
  private var lastBlindNoticeAt: Date?

  // MARK: - 生命週期（由 SampleHandler 轉呼叫）

  func start() {
    workQueue.async {
      RunRecord.reportPreviousIfCrashed()
      self.sampleMemory()
      RunRecord.save(diag: self.diag(), finished: false)
      self.pushHeartbeat()
    }
    let timer = DispatchSource.makeTimerSource(queue: workQueue)
    timer.schedule(
      deadline: .now() + .seconds(heartbeatInterval),
      repeating: .seconds(heartbeatInterval),
      leeway: .seconds(5))
    timer.setEventHandler { [weak self] in
      self?.pushHeartbeat()
    }
    timer.resume()
    heartbeatTimer = timer
  }

  func finish() {
    heartbeatTimer?.cancel()
    heartbeatTimer = nil
    // 程序在這個方法 return 後就會被結束 → 等最後一次 update 送出（最多 3 秒）
    let done = DispatchSemaphore(value: 0)
    workQueue.async {
      let text = "偵測已停止 \(Clock.hms(Date())) · \(self.diag())"
      RunRecord.save(diag: text, finished: true)
      guard let activity = DetectorCard.find().activity else {
        done.signal()
        return
      }
      let current = activity.content
      var state = current.state
      let counting = state.mode == "countdown" && state.deadline > Date()
      if !counting { state.mode = "stopped" }  // 倒數中就保留倒數，只換診斷字
      state.heartbeat = Date()
      state.diag = text
      let content = ActivityContent(state: state, staleDate: counting ? current.staleDate : nil)
      Task.detached {
        await activity.update(content)
        done.signal()
      }
    }
    _ = done.wait(timeout: .now() + 3)
  }

  func process(_ sampleBuffer: CMSampleBuffer) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    framesReceived += 1
    let shouldProcess = !busy && now - lastOcrStart >= ocrInterval
    if shouldProcess {
      busy = true
      lastOcrStart = now
    }
    lock.unlock()
    guard shouldProcess else { return }  // 節流＋忙就丟幀

    // 在回呼內就把畫面縮成小 CGImage，不把 ReplayKit 的 pixel buffer 留到別的執行緒（避免卡住它的 buffer pool）
    var image: CGImage?
    autoreleasepool {
      image = makeImage(sampleBuffer)
    }
    guard let cgImage = image else {
      lock.lock()
      imageFailures += 1
      busy = false
      lock.unlock()
      return
    }
    workQueue.async {
      autoreleasepool {
        self.runOCR(cgImage)
      }
      self.lock.lock()
      self.busy = false
      self.lock.unlock()
    }
  }

  // MARK: - 影像與 OCR

  private func makeImage(_ sampleBuffer: CMSampleBuffer) -> CGImage? {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return nil }
    var image = CIImage(cvPixelBuffer: pixelBuffer)
    if let raw = CMGetAttachment(
      sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
      let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value)
    {
      image = image.oriented(orientation)
    }
    let extent = image.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    // CIImage 原點在左下 → 畫面下方 60% 是 y 較小的那段
    let crop = CGRect(
      x: extent.minX, y: extent.minY, width: extent.width, height: (extent.height * bottomFraction).rounded())
    image = image.cropped(to: crop)
    let scale = min(1, maxLongEdge / max(crop.width, crop.height))
    if scale < 1 {
      image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
    return ciContext.createCGImage(image, from: image.extent.integral)
  }

  private func runOCR(_ cgImage: CGImage) {
    let text: String
    do {
      text = try FrameOCR.recognize(cgImage)
    } catch {
      ocrErrors += 1
      return
    }
    ocrCount += 1
    sampleMemory()
    lastSawAccept = OrderDetector.hasAcceptButton(text)
    guard lastSawAccept, let minutes = OrderDetector.detect(text) else { return }

    // 去重：同一分鐘數 3 分鐘內只觸發一次（新單畫面會停留好幾秒）
    let now = Date()
    if let last = lastTriggerMinutes, last == minutes,
       let at = lastTriggerAt, now.timeIntervalSince(at) < dedupeWindow
    {
      return
    }
    lastTriggerMinutes = minutes
    lastTriggerAt = now
    triggerCount += 1
    trigger(minutes: minutes, at: now)
  }

  // MARK: - Live Activity

  private func trigger(minutes: Int, at now: Date) {
    let deadline = now.addingTimeInterval(Double(minutes) * 60)
    let text = diag()
    let state = PandaTimerAttributes.ContentState(
      deadline: deadline, estimateMinutes: minutes, mode: "countdown", heartbeat: now, diag: text)
    let found = DetectorCard.find()
    Task.detached {
      let outcome: String
      if let activity = found.activity {
        await activity.update(ActivityContent(state: state, staleDate: deadline))
        outcome = "動態島已改成 \(minutes) 分倒數（結果 A）"
      } else {
        outcome = await DetectorCard.requestNew(
          minutes: minutes, deadline: deadline, beat: now, diag: text, total: found.total)
      }
      await Notifier.post("偵測到新單：\(minutes) 分鐘", "\(outcome)\n\(text)")
    }
  }

  /// 每 60 秒：只更新心跳與診斷字，倒數內容不動
  private func pushHeartbeat() {
    sampleMemory()
    let text = diag()
    RunRecord.save(diag: text, finished: false)
    let found = DetectorCard.find()
    guard let activity = found.activity else {
      noteBlind(total: found.total, text: text)
      return
    }
    let current = activity.content
    var state = current.state
    if state.mode == "stopped" { state.mode = "standby" }  // 上一輪停止留下的卡 → 回到待命
    state.heartbeat = Date()
    state.diag = text
    let content = ActivityContent(state: state, staleDate: state.mode == "countdown" ? current.staleDate : nil)
    Task.detached {
      await activity.update(content)
    }
  }

  private func noteBlind(total: Int, text: String) {
    let now = Date()
    if let last = lastBlindNoticeAt, now.timeIntervalSince(last) < blindNoticeInterval { return }
    lastBlindNoticeAt = now
    Task.detached {
      await Notifier.post(
        "⚠️ 偵測程式看不到動態島（結果 B）",
        "偵測仍在執行，但系統內 \(total) 張熊貓卡片裡沒有偵測卡。\n\(text)")
    }
  }

  // MARK: - 診斷

  private func sampleMemory() {
    guard let mem = Memory.footprintMB() else { return }
    currentMB = mem.current
    peakMB = max(peakMB, mem.current, mem.peak)
  }

  private func diag() -> String {
    lock.lock()
    let frames = framesReceived
    let fails = imageFailures
    lock.unlock()
    var parts = [
      "幀 \(frames)",
      "OCR \(ocrCount)",
      "\(Int(currentMB.rounded()))/\(Int(peakMB.rounded()))MB",
      lastSawAccept ? "末次:有接單鈕" : "末次:無",
    ]
    if triggerCount > 0, let m = lastTriggerMinutes { parts.append("觸發\(triggerCount)(\(m)分)") }
    if ocrErrors + fails > 0 { parts.append("錯\(ocrErrors)/\(fails)") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - 偵測卡（ActivityKit；獨立 enum，不受 RPBroadcastSampleHandler 的 actor 隔離影響）

enum DetectorCard {
  /// 只認「偵測卡」：mode == standby/stopped，或 heartbeat 有值（由偵測程式管理的倒數）。
  /// 不碰 App 一般開單的倒數卡，以免把真正進行中的單改掉。total＝系統裡看得到的熊貓卡片總數（診斷用）。
  static func find() -> (activity: Activity<PandaTimerAttributes>?, total: Int) {
    let all = Activity<PandaTimerAttributes>.activities.filter {
      $0.activityState != .ended && $0.activityState != .dismissed
    }
    let mine =
      all.first { $0.content.state.mode == "standby" }
      ?? all.first { $0.content.state.mode == "stopped" }
      ?? all.first { $0.content.state.heartbeat != nil }
    return (mine, all.count)
  }

  /// 找不到偵測卡時，試試偵測程式能不能自己開一張（多半會被拒，結果寫進通知當診斷）
  static func requestNew(minutes: Int, deadline: Date, beat: Date, diag: String, total: Int) async -> String {
    do {
      // 與 native/intents 的 IntentLiveActivity.start 同寫法：只捕捉 Sendable 的值，在 MainActor 上 request
      let id = try await MainActor.run { () throws -> String in
        let state = PandaTimerAttributes.ContentState(
          deadline: deadline, estimateMinutes: minutes, mode: "countdown", heartbeat: beat, diag: diag)
        let activity = try Activity<PandaTimerAttributes>.request(
          attributes: PandaTimerAttributes(acceptedAt: beat),
          content: ActivityContent(state: state, staleDate: deadline),
          pushType: nil)
        return activity.id
      }
      return "看不到偵測卡，但偵測程式自己開了新動態島（結果 C，\(id.prefix(6))）"
    } catch {
      return "看不到偵測卡（系統內熊貓卡 \(total) 張），自己開也失敗（結果 B）：\(error.localizedDescription)"
    }
  }
}

// MARK: - OCR（行合併邏輯同 native/intents/PandaIntents.swift 的 ScreenshotOCR）

enum FrameOCR {
  static func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate  // .fast 不支援中文
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let observations = request.results ?? []

    struct Piece {
      let text: String
      let midY: CGFloat
      let minX: CGFloat
      let height: CGFloat
    }
    var pieces: [Piece] = []
    for observation in observations {
      guard let candidate = observation.topCandidates(1).first else { continue }
      let box = observation.boundingBox
      pieces.append(Piece(text: candidate.string, midY: box.midY, minX: box.minX, height: box.height))
    }
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
// 不先查 authorizationStatus：extension 讀到的狀態是否等於 App 的沒把握，直接 add，失敗就算了。

enum Notifier {
  static func post(_ title: String, _ body: String) async {
    let center = UNUserNotificationCenter.current()
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
    try? await center.add(request)
  }
}

// MARK: - 上一輪紀錄（extension 自己的 UserDefaults，跨次保留；用來抓「被系統殺掉」）

enum RunRecord {
  private static let key = "pandatimer.broadcast.lastRun.v1"

  static func save(diag: String, finished: Bool) {
    let record: [String: Any] = ["at": Date().timeIntervalSince1970, "diag": diag, "finished": finished]
    UserDefaults.standard.set(record, forKey: key)
  }

  /// 上一輪沒有走到 broadcastFinished（被 jetsam 殺掉或當掉）→ 發通知附最後一次的診斷
  static func reportPreviousIfCrashed() {
    guard let last = UserDefaults.standard.dictionary(forKey: key),
          let finished = last["finished"] as? Bool, !finished,
          let at = last["at"] as? Double
    else { return }
    let diag = (last["diag"] as? String) ?? ""
    let when = Clock.hms(Date(timeIntervalSince1970: at))
    Task.detached {
      await Notifier.post("⚠️ 上次偵測異常中止", "最後紀錄 \(when)：\(diag)（可能記憶體超過上限被系統關掉）")
    }
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
