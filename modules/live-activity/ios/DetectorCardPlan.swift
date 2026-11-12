import ActivityKit
import Foundation

// ⚠️ 這個檔案有三份，必須逐字相同（CI diff 擋）：
//   modules/live-activity/ios/DetectorCardPlan.swift（pod LiveActivity：DetectorHub、JS 的 end()）
//   native/intents/DetectorCardPlan.swift（主 App target：動態島「送達」「開始倒數」的 LiveActivityIntent）
//   targets/widget/DetectorCardPlan.swift（widget 編得過即可；intent 的 perform 在 App 程序跑）
// v0.6 多單：背景開不了新卡 → 自動偵測的單全部掛在同一張「偵測卡」上（進行中鏡像裡 activityId == 卡 id）。
// 卡片倒數顯示**最早截止**那單，其餘寫進 ContentState.others；送達一單後自動切到下一單，全部送達回「偵測中」待命。
// ⚠️ others 文字規則與 src/cardPlan.ts 的 othersText 相同（TS 版有測試），改一邊改兩邊。
// 只用三個 target 都有的符號：PandaTimerAttributes、Foundation、ActivityKit。
enum DetectorCardPlan {
  static let activeKey = "pandatimer.native.activeOrders.v1"
  /// others 最多列幾個截止時間
  static let maxListed = 3
  static let maxDiag = 120

  struct Item {
    let id: String
    let acceptedAt: Date
    let estimateMin: Int
    let deadline: Date
  }

  /// 鏡像的一筆（{id, acceptedAt(ms), estimateMin, deadline(ms)?, activityId?}）→ Item；欄位不全回 nil
  static func item(_ dict: [String: Any]) -> Item? {
    guard let id = dict["id"] as? String,
          let acceptedMs = (dict["acceptedAt"] as? NSNumber)?.doubleValue
    else { return nil }
    let estimate = (dict["estimateMin"] as? NSNumber)?.intValue ?? 0
    let deadlineMs = (dict["deadline"] as? NSNumber)?.doubleValue ?? (acceptedMs + Double(estimate) * 60_000)
    return Item(
      id: id, acceptedAt: Date(timeIntervalSince1970: acceptedMs / 1000), estimateMin: estimate,
      deadline: Date(timeIntervalSince1970: deadlineMs / 1000))
  }

  /// 截止早的在前；同截止依接單時間
  static func sorted(_ items: [Item]) -> [Item] {
    items.sorted { a, b in
      a.deadline != b.deadline ? a.deadline < b.deadline : a.acceptedAt < b.acceptedAt
    }
  }

  /// 進行中鏡像裡掛在這張卡（activityId == cardId）的單，最早截止在前
  static func items(cardId: String) -> [Item] {
    let defaults = UserDefaults.standard
    objc_sync_enter(defaults)
    defer { objc_sync_exit(defaults) }
    guard let text = defaults.string(forKey: activeKey), let data = text.data(using: .utf8),
          let list = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [[String: Any]]
    else { return [] }
    return sorted(list.compactMap { dict -> Item? in
      guard (dict["activityId"] as? String) == cardId else { return nil }
      return item(dict)
    })
  }

  /// 「另 2 單：18:42、18:55 截止」；超過 maxListed 單 → 「另 5 單：18:42、18:55、19:01… 截止」；沒有其他單 → nil
  static func othersText(_ rest: [Item]) -> String? {
    guard !rest.isEmpty else { return nil }
    let times = rest.prefix(maxListed).map { clock($0.deadline) }.joined(separator: "、")
    let more = rest.count > maxListed ? "…" : ""
    return "另 \(rest.count) 單：\(times)\(more) 截止"
  }

  static func clock(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "HH:mm"
    return f.string(from: date)
  }

  static func isAlive(_ activity: Activity<PandaTimerAttributes>) -> Bool {
    activity.activityState != .ended && activity.activityState != .dismissed
  }

  /// 把卡套成 items 的樣子，回傳顯示中的主單（nil＝回待命或已結束）。
  /// items 空：偵測卡（heartbeat 有值或待命/已停止）→ 回 standby（已停止維持 stopped）；一般卡 → 結束。
  /// alert 非 nil → update(_:alertConfiguration:)（展開動態島＋響聲提示，強迫重繪）；心跳等一般更新不要帶。
  /// v1.0：套用時一律清掉「偵測到邀請」（offerMin/offerAmount/offerAt）——新單＝邀請已接、送達/回待命＝邀請早已結束；
  /// mode "offer" 視同待命（items 空 → standby）。
  @discardableResult
  static func apply(
    to activity: Activity<PandaTimerAttributes>, items: [Item], note: String?, alert: AlertConfiguration?
  ) async -> Item? {
    var state = activity.content.state
    state.offerMin = nil
    state.offerAmount = nil
    state.offerAt = nil
    guard let main = items.first else {
      if state.heartbeat != nil || state.mode == "standby" || state.mode == "stopped" || state.mode == "offer" {
        state.mode = state.mode == "stopped" ? "stopped" : "standby"
        state.others = nil
        if let note = note { state.diag = trimmed("\(note) · \(state.diag ?? "")") }
        await activity.update(ActivityContent(state: state, staleDate: nil))
      } else {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
      return nil
    }
    state.mode = "countdown"
    state.deadline = main.deadline
    state.estimateMinutes = main.estimateMin
    state.others = othersText(Array(items.dropFirst()))
    if let note = note { state.diag = trimmed(note) }
    let content = ActivityContent(state: state, staleDate: main.deadline)
    if let alert = alert {
      await activity.update(content, alertConfiguration: alert)
    } else {
      await activity.update(content)
    }
    return main
  }

  /// 送達/取消一單之後（鏡像已移除該單）：這張卡還掛著單 → 切到下一單；沒有 → 偵測卡回待命、一般卡結束。
  static func afterFinish(activityId: String, note: String) async {
    for activity in Activity<PandaTimerAttributes>.activities where activity.id == activityId && isAlive(activity) {
      await apply(to: activity, items: items(cardId: activityId), note: note, alert: nil)
    }
  }

  static func trimmed(_ text: String) -> String {
    text.count > maxDiag ? String(text.prefix(maxDiag)) : text
  }
}
