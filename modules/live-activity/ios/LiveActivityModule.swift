import ActivityKit
import ExpoModulesCore
import Foundation

final class LiveActivityUnsupportedException: GenericException<String> {
  override var reason: String {
    "Live Activity 不可用：\(param)"
  }
}

final class LiveActivityStartException: GenericException<String> {
  override var reason: String {
    "Live Activity 啟動失敗：\(param)"
  }
}

public class LiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiveActivity")

    // 系統版本夠新、且使用者沒在設定裡關掉「即時動態」
    Function("isSupported") { () -> Bool in
      if #available(iOS 16.2, *) {
        return ActivityAuthorizationInfo().areActivitiesEnabled
      }
      return false
    }

    // 本地啟動 Live Activity（pushType: nil → 不需要 aps-environment）
    // 必須在 App 位於前景時呼叫，否則 ActivityKit 會拒絕。
    AsyncFunction("start") { (estimateMinutes: Double, deadlineMs: Double) throws -> String in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException("需要 iOS 16.2 以上")
      }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw LiveActivityUnsupportedException("設定 > 熊貓倒數 > 即時動態 已關閉")
      }
      let deadline = Date(timeIntervalSince1970: deadlineMs / 1000.0)
      let attributes = PandaTimerAttributes(acceptedAt: Date())
      let state = PandaTimerAttributes.ContentState(
        deadline: deadline,
        estimateMinutes: Int(estimateMinutes.rounded())
      )
      // staleDate = 截止時間：過了截止系統會重繪，widget 用 context.isStale 顯示「已超時」
      let content = ActivityContent(state: state, staleDate: deadline)
      do {
        let activity = try Activity<PandaTimerAttributes>.request(
          attributes: attributes,
          content: content,
          pushType: nil
        )
        return activity.id
      } catch {
        throw LiveActivityStartException(error.localizedDescription)
      }
    }.runOnQueue(.main)

    // 結束指定 id 的 Live Activity（找不到也算成功）
    AsyncFunction("end") { (id: String, promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      let targets = Activity<PandaTimerAttributes>.activities.filter { $0.id == id }
      Task {
        for activity in targets {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("endAll") { (promise: Promise) in
      guard #available(iOS 16.2, *) else {
        promise.resolve(nil)
        return
      }
      let targets = Activity<PandaTimerAttributes>.activities
      Task {
        for activity in targets {
          await activity.end(nil, dismissalPolicy: .immediate)
        }
        promise.resolve(nil)
      }
    }

    // 目前系統裡還活著的 activity id（App 重開後用來對帳）
    Function("activeIds") { () -> [String] in
      guard #available(iOS 16.2, *) else { return [] }
      return Activity<PandaTimerAttributes>.activities.map { $0.id }
    }
  }
}
