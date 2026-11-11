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
  /// 連續 idleAfterMisses 次 OCR 都沒有接單鈕 → 改用 idleOcrInterval
  private let idleOcrInterval: CFAbsoluteTime = 3
  private let idleAfterMisses = 3
  private let forceOcrInterval: CFAbsoluteTime = 10
  private let sameFrameMaxBits = 40  // 4096 bits 中差異 ≤40（≈1%）視為同一畫面
  private let heartbeatInterval: Int = 60
  private let dedupeWindow: TimeInterval = 180
  private let maxLongEdge = 640
  private let bottomFraction = 0.50
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
  private var currentInterval: CFAbsoluteTime = 1.5

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
    missStreak = lastSawAccept ? 0 : missStreak + 1
    let interval = missStreak >= idleAfterMisses ? idleOcrInterval : ocrInterval
    lock.lock()
    currentInterval = interval
    lock.unlock()
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
    // userInfo：App 被暫停後才收到訊號時，用這裡的偵測時間當接單時間（DetectorNotify.detectedAt）。
    // 點這則通知 → 系統打開 App → App 回前景就把這單的倒數推到動態島（不會重複記錄）。
    let detectedMs = (now.timeIntervalSince1970 * 1000).rounded()
    Task.detached {
      let info: [String: Any] = ["pandatimer": "detected", "minutes": minutes, "detectedAt": detectedMs]
      await Notifier.post(
        "偵測到新單：\(minutes) 分鐘",
        (sent ? "已通知 App 開倒數與記錄。動態島沒變→點這則打開 App" : "分鐘數超出 1–90，未通知 App")
          + "\n\(text2)",
        passive: false, userInfo: info)
    }
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
    if ocrErrors + fails > 0 { parts.append("錯\(ocrErrors)/\(fails)") }
    if let f = format { parts.append("格式\(String(format: "%08X", f))") }
    return parts.joined(separator: " · ")
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
