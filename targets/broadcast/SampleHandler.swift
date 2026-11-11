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
//
// 省記憶體（v0.3 峰值 44MB → 目標 ≤35MB）：
//  - 不用 CIContext：直接讀 pixel buffer 的亮度平面（420f 的 Y），只取畫面下方 55%，整數倍平均縮到長邊 ≤800px，
//    得到 8-bit 灰階小圖（約 0.5MB）再交給 Vision；
//  - OCR 最多每 1.5 秒一次；64×64 平均雜湊與上次 OCR 的畫面幾乎相同就跳過（最多 10 秒強制再 OCR 一次）；
//  - VNRecognizeTextRequest 只建一次重用、minimumTextHeight 0.018；每幀包 autoreleasepool。
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

  static func post(_ name: String) {
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
  }

  /// N 必須在 1…90（MinutePicker 已限制；App 只註冊這 90 個名稱）
  static func postOrder(_ minutes: Int) -> Bool {
    guard minutes >= 1, minutes <= 90 else { return false }
    post("\(orderPrefix)\(minutes)")
    return true
  }
}

final class BroadcastDetector {
  // MARK: - 參數
  private let ocrInterval: CFAbsoluteTime = 1.5
  private let forceOcrInterval: CFAbsoluteTime = 10
  private let sameFrameMaxBits = 40  // 4096 bits 中差異 ≤40（≈1%）視為同一畫面
  private let heartbeatInterval: Int = 60
  private let dedupeWindow: TimeInterval = 180
  private let maxLongEdge = 800
  private let bottomFraction = 0.55
  private let memoryAlertMB: Double = 40

  // MARK: - 狀態
  private let workQueue = DispatchQueue(label: "com.pandatimer.broadcast.work", qos: .userInitiated)
  private let lock = NSLock()
  private let ocr = FrameOCR()
  private var heartbeatTimer: DispatchSourceTimer?

  // lock 保護（ReplayKit 回呼執行緒 ↔ workQueue）
  private var framesReceived = 0
  private var busy = false
  private var lastCheckStart: CFAbsoluteTime = 0
  private var lastOcrAt: CFAbsoluteTime = 0
  private var lastHash: [UInt64]?
  private var skipped = 0
  private var imageFailures = 0
  private var badFormat: OSType?

  // 只在 workQueue 存取
  private var ocrCount = 0
  private var ocrErrors = 0
  private var currentMB: Double = 0
  private var peakMB: Double = 0
  private var alertedPeakMB: Double = 0
  private var lastSawAccept = false
  private var lastTriggerMinutes: Int?
  private var lastTriggerAt: Date?
  private var triggerCount = 0

  // MARK: - 生命週期（由 SampleHandler 轉呼叫）

  func start() {
    PandaSignal.post(PandaSignal.started)
    workQueue.async {
      RunRecord.reportPreviousIfCrashed()
      self.sampleMemory()
      RunRecord.save(diag: self.diag(), finished: false)
    }
    let timer = DispatchSource.makeTimerSource(queue: workQueue)
    timer.schedule(
      deadline: .now() + .seconds(heartbeatInterval),
      repeating: .seconds(heartbeatInterval),
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
    PandaSignal.post(PandaSignal.stopped)
    // 程序在這個方法 return 後就會被結束 → 等最後一則（靜音）摘要通知送出（最多 2 秒）
    let done = DispatchSemaphore(value: 0)
    workQueue.async {
      self.sampleMemory()
      let text = self.diag()
      RunRecord.save(diag: "偵測已停止 \(Clock.hms(Date())) · \(text)", finished: true)
      Task.detached {
        await Notifier.post("偵測已停止", text, passive: true)
        done.signal()
      }
    }
    _ = done.wait(timeout: .now() + 2)
  }

  /// 每 60 秒：心跳給 App；記錄本輪診斷（被系統殺掉時下次開始會回報）；峰值 >40MB 發靜音通知
  private func heartbeat() {
    PandaSignal.post(PandaSignal.heartbeat)
    sampleMemory()
    let text = diag()
    RunRecord.save(diag: text, finished: false)
    if peakMB > memoryAlertMB && peakMB >= alertedPeakMB + 3 {
      alertedPeakMB = peakMB
      Task.detached {
        await Notifier.post("偵測記憶體偏高", "峰值超過 40MB（上限約 50MB，超過會被系統關掉）\n\(text)", passive: true)
      }
    }
  }

  // MARK: - 每幀

  func process(_ sampleBuffer: CMSampleBuffer) {
    let now = CFAbsoluteTimeGetCurrent()
    lock.lock()
    framesReceived += 1
    let shouldCheck = !busy && now - lastCheckStart >= ocrInterval
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
        sampleBuffer, bottomFraction: bottomFraction, maxLongEdge: maxLongEdge)
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
    let same = lastHash.map { GrayFrame.distance($0, frame.hash) <= sameFrameMaxBits } ?? false
    if same && now - lastOcrAt < forceOcrInterval {
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
    let text: String
    do {
      guard let image = frame.cgImage() else {
        ocrErrors += 1
        return
      }
      text = try ocr.recognize(image, orientation: frame.orientation)
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
    let sent = PandaSignal.postOrder(minutes)
    let text2 = diag()
    Task.detached {
      await Notifier.post(
        "偵測到新單：\(minutes) 分鐘",
        (sent ? "已通知 App 開倒數與記錄" : "分鐘數超出 1–90，未通知 App") + "\n\(text2)",
        passive: false)
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
    let skips = skipped
    let format = badFormat
    lock.unlock()
    var parts = [
      "幀 \(frames)",
      "OCR \(ocrCount)",
      "跳 \(skips)",
      "\(Int(currentMB.rounded()))/\(Int(peakMB.rounded()))MB",
      lastSawAccept ? "末次:有接單鈕" : "末次:無",
    ]
    if triggerCount > 0, let m = lastTriggerMinutes { parts.append("觸發\(triggerCount)(\(m)分)") }
    if ocrErrors + fails > 0 { parts.append("錯\(ocrErrors)/\(fails)") }
    if let f = format { parts.append("格式\(String(format: "%08X", f))") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - 灰階小圖（直接取亮度，不經 CIContext）

struct GrayFrame {
  let width: Int
  let height: Int
  let pixels: [UInt8]
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
    let factor = max(1, (max(width, cropH) + maxLongEdge - 1) / maxLongEdge)
    let outW = width / factor
    let outH = cropH / factor
    guard outW > 0, outH > 0 else { return (nil, nil) }
    let area = factor * factor
    var pixels = [UInt8](repeating: 0, count: outW * outH)
    pixels.withUnsafeMutableBufferPointer { out in
      for oy in 0..<outH {
        let rowBase = y0 + oy * factor
        for ox in 0..<outW {
          var sum = 0
          for dy in 0..<factor {
            let row = src + (rowBase + dy) * stride
            for dx in 0..<factor {
              let p = row + (ox * factor + dx) * bpp
              if bpp == 1 {
                sum += Int(p[0])
              } else {
                sum += (Int(p[0]) + 2 * Int(p[1]) + Int(p[2])) >> 2  // BGRA → 近似亮度
              }
            }
          }
          out[oy * outW + ox] = UInt8(sum / area)
        }
      }
    }
    let frame = GrayFrame(
      width: outW, height: outH, pixels: pixels, orientation: orientation,
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
    guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
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
    r.minimumTextHeight = 0.018  // 相對圖高；小圖長邊 800px → 約 14px 以下的字略過
    return r
  }()

  /// 只在 workQueue 呼叫（request 不是執行緒安全的）
  func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation) throws -> String {
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
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
// 一律不響聲；passive＝只進通知中心不亮螢幕。不用 timeSensitive/critical（需要 entitlement）。

enum Notifier {
  static func post(_ title: String, _ body: String, passive: Bool) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = nil
    content.interruptionLevel = passive ? .passive : .active
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

  /// 上一輪沒有走到 broadcastFinished（被 jetsam 殺掉或當掉）→ 發通知附最後一次的診斷
  static func reportPreviousIfCrashed() {
    guard let last = UserDefaults.standard.dictionary(forKey: key),
          let finished = last["finished"] as? Bool, !finished,
          let at = last["at"] as? Double
    else { return }
    let diag = (last["diag"] as? String) ?? ""
    let when = Clock.hms(Date(timeIntervalSince1970: at))
    Task.detached {
      await Notifier.post("⚠️ 上次偵測異常中止", "最後紀錄 \(when)：\(diag)（可能記憶體超過上限被系統關掉）", passive: false)
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
