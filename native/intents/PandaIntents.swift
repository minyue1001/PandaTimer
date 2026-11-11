import ActivityKit
import AppIntents
import CoreGraphics
import Foundation
import UserNotifications
import Vision

// 只在主 App target（plugins/withAppIntents.js 把 native/intents/*.swift 加進 PandaTimer 的 Sources）。
// App Intents 的 metadata 只會從主 App（或 app intents extension）擷取，放在 CocoaPods 靜態 pod 裡系統看不到。
// 兩個 intent 都是 LiveActivityIntent：系統在背景啟動 App 程序執行 perform，不打開 App、不切走 pandarider；
// 背景不跑 JS，所以結果寫進 UserDefaults（PandaSharedStore），JS 回前景時 drainNativeEvents() 合併。

struct PandaIntentError: Error, CustomLocalizedStringResourceConvertible {
  let message: String
  init(_ message: String) { self.message = message }
  var localizedStringResource: LocalizedStringResource { "\(message)" }
}

/// 捷徑「熊貓接單」：① 擷取螢幕畫面 → ② 熊貓倒數：從截圖開始
struct StartFromScreenshotIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "從截圖開始"
  static let openAppWhenRun: Bool = false

  // supportedContentTypes:[UTType] 版本要 iOS 18；deployment target 17.0 只能用 supportedTypeIdentifiers（iOS 18 起 deprecated，僅警告）
  @Parameter(
    title: "截圖",
    supportedTypeIdentifiers: ["public.image"],
    inputConnectionBehavior: .connectToPreviousIntentResult
  )
  var screenshot: IntentFile

  static var parameterSummary: some ParameterSummary {
    Summary("從 \(\.$screenshot) 開始倒數")
  }

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let text: String
    do {
      text = try ScreenshotOCR.recognize(screenshot.data)
    } catch {
      throw PandaIntentError("截圖辨識失敗，請在 App 內手動開始")
    }
    guard let minutes = MinutePicker.pick(text) else {
      throw PandaIntentError("找不到分鐘數，請在 App 內手動開始")
    }

    let acceptedAt = Date()
    let deadline = acceptedAt.addingTimeInterval(Double(minutes) * 60)
    var activityId: String?
    var activityError: String?
    do {
      activityId = try await IntentLiveActivity.start(
        estimateMin: minutes, acceptedAt: acceptedAt, deadline: deadline)
    } catch {
      activityError = (error as? PandaIntentError)?.message ?? error.localizedDescription
    }
    let notifIds = await IntentReminders.schedule(deadline: deadline, estimateMin: minutes)

    let acceptedMs = PandaSharedStore.ms(acceptedAt)
    let suffix = UUID().uuidString.prefix(5).lowercased()
    var order: [String: Any] = [
      "id": "\(Int64(acceptedMs))-\(suffix)",
      "acceptedAt": acceptedMs,
      "estimateMin": minutes,
      "deadline": PandaSharedStore.ms(deadline),
      "notifIds": notifIds,
    ]
    if let activityId = activityId { order["activityId"] = activityId }
    PandaSharedStore.recordStart(order)

    if let activityError = activityError {
      return .result(dialog: "已開始：預估 \(minutes) 分（動態島未啟動：\(activityError)）")
    }
    return .result(dialog: "已開始：預估 \(minutes) 分")
  }
}

/// 捷徑「熊貓送達」：結束最早一筆進行中的單（以 JS 同步過來的鏡像＋原生開的單為準）
struct DeliveredIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "送達"
  static let openAppWhenRun: Bool = false

  init() {}

  func perform() async throws -> some IntentResult & ProvidesDialog {
    let now = Date()
    guard let order = PandaSharedStore.finishOrder(activityId: nil, at: now) else {
      return .result(dialog: "沒有進行中的訂單")
    }
    await PandaSharedStore.cleanup(activityId: order.activityId, notifIds: order.notifIds)
    let actual = ((PandaSharedStore.ms(now) - order.acceptedAt) / 60_000 * 10).rounded() / 10
    let actualText = actual == actual.rounded() ? String(Int(actual)) : String(format: "%.1f", actual)
    return .result(dialog: "已送達：實際 \(actualText) 分／預估 \(order.estimateMin) 分")
  }
}

/// 讓兩個 intent 出現在捷徑 App 的「熊貓倒數」底下（phrases 必須含 applicationName）
struct PandaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartFromScreenshotIntent(),
      phrases: [
        "用\(.applicationName)從截圖開始",
        "\(.applicationName)接單",
      ],
      shortTitle: "從截圖開始",
      systemImageName: "timer"
    )
    AppShortcut(
      intent: DeliveredIntent(),
      phrases: [
        "\(.applicationName)送達",
        "用\(.applicationName)標記送達",
      ],
      shortTitle: "送達",
      systemImageName: "checkmark.circle"
    )
  }
}

// MARK: - OCR

enum ScreenshotOCR {
  /// Vision 辨識文字；把同一水平線上的觀測合成一行（由左到右），各行由上到下以 \n 串起來
  static func recognize(_ data: Data) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(data: data, options: [:])
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
      let box = observation.boundingBox  // 正規化座標，原點在左下
      pieces.append(Piece(text: candidate.string, midY: box.midY, minX: box.minX, height: box.height))
    }
    pieces.sort { $0.midY > $1.midY }  // 由上到下

    var lines: [[Piece]] = []
    for piece in pieces {
      if let last = lines.last, let ref = last.first,
         abs(ref.midY - piece.midY) < max(ref.height, piece.height) * 0.5 {
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

// MARK: - Live Activity / 通知

enum IntentLiveActivity {
  /// LiveActivityIntent 的 perform 內允許在背景本地啟動（pushType: nil → 不需 aps-environment）
  static func start(estimateMin: Int, acceptedAt: Date, deadline: Date) async throws -> String {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      throw PandaIntentError("設定 › 熊貓倒數 › 即時動態 已關閉")
    }
    return try await MainActor.run { () throws -> String in
      let attributes = PandaTimerAttributes(acceptedAt: acceptedAt)
      let state = PandaTimerAttributes.ContentState(deadline: deadline, estimateMinutes: estimateMin)
      // staleDate = 截止時間：過了截止系統重繪，widget 用 context.isStale 顯示「已超時」
      let content = ActivityContent(state: state, staleDate: deadline)
      let activity = try Activity<PandaTimerAttributes>.request(
        attributes: attributes, content: content, pushType: nil)
      return activity.id
    }
  }
}

enum IntentReminders {
  /// 截止前 3 分與截止各一則本地通知（文字與 src/notify.ts 相同）。
  /// 不用 timeSensitive / critical（需要 entitlement）；背景無法跳權限詢問，沒授權就不排。
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
        identifier: UUID().uuidString,
        content: content,
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
