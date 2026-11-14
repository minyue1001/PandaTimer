import Foundation

// v0.7「接單後才開始倒數」：新單邀請畫面的狀態機（純邏輯，只在 BroadcastDetector 的 workQueue 上用）。
// ⚠️ 與 src/offerTracker.ts 同一套規則。Swift 在 WSL 不能跑、CI 也沒有 Swift 單元測試 →
//    **以 TS 版為準**（node --test 跑 test/fixtures/offer-cases.json 的樣本）；改一邊就改另一邊。
//
// 狀態：
//   idle ──看到邀請（接單鈕＋分鐘數）──▶ offered（不送訂單訊號，只回報 offer_seen、送 offer.pending.<分>）
//   offered ──連續 goneAfterMisses 次 OCR 沒有接單鈕──▶ deciding(goneAt＝第一次沒看到的時間)
//   offered ──邀請直接換成另一張（分鐘/金額不同）──▶ 前一張「未接」(replaced)，新一張 offered
//   deciding（decideWindowSec 秒內持續看畫面）：
//     只命中 acceptedKeywords → 接單（acceptedAt＝goneAt）；只命中 rejectedKeywords → 未接；
//     兩邊都命中或都沒命中 → 繼續看；視窗到期 → 依 ambiguousAs（預設 accept：寧可多記也不要漏倒數）；
//     同一張（分鐘, 金額）又出現 → 回 offered（只是被短暫切走）；
//     出現另一張邀請 → 前一張依 ambiguousAs (superseded)，再進新一張的 offered。
//   接單的（分鐘, 金額）dedupeSeconds 內又出現 → dup（不算新邀請）。
//   v0.7 實機修正：「同一張」＝分鐘相同且（金額相同或任一方沒抓到金額）；offered 期間後來才抓到金額 → 補齊，不算新單。
//   廣播停止 → offered 當未接、deciding 依 ambiguousAs (stopped)。
//   v0.8 夾單：同一張邀請任一次 OCR 看到「夾單」（offer.stackedKeywords）→ offer.stacked=true（之後不會變回 false）。
//   v1.1 OCR 誤讀防護：分鐘 < suspectBelowMinutes（3）且同畫面命中接單後字樣（offerAccepted）、又不是目前這張 →
//     不當新邀請（.suspect，不送 pending），當成「有接單鈕但分鐘還讀不出來」。0＝關閉。
//   v1.2（11/14 實機；規則＝src/offerTracker.ts＋src/offerBundle.ts，以 TS 測試為準）：
//     ① 分鐘相同、其中一個金額 < fare(分鐘)−0.01（誤讀）→ 同一張，保留合理的金額；兩個都合理但不同 → 不同張。
//     ② 判定時只命中常駐字（offer.weakAcceptedKeywords：筆訂單/取餐體驗）→ 邀請前 baselineSec 秒內沒看過常駐字、
//        或「N筆訂單」比邀請前大才算接單，否則當沒命中。
//     ③ Offer 記「送餐資訊」最大次數（bundle）與小費（tip）；接單後 BundleSplit 拆單。ScreenOrdersWatch：送單畫面 N 筆訂單去抖。

/// 遠端設定 "offer" 區塊（預設＝src/offerTracker.ts 的 DEFAULT_OFFER＝server/config.default.json；範圍同 RANGES）
struct OfferSettings {
  // ⚠️ 待實測調整：pandarider 接單後畫面還沒看過，先猜；調整改 server/config.json 的 offer.*，不用重裝
  static let defaultAcceptedKeywords =
    "前往取餐|抵達(?:店家|餐廳)|抵达(?:店家|餐厅)|確認取餐|确认取餐|已抵達|已抵达|取餐|導航|导航|訂單詳情|订单详情|聯絡店家|联络店家|联系店家|即將準備完成|即将准备完成|準備完成|准备完成|筆訂單|笔订单|取餐體驗|取餐体验"
  static let defaultRejectedKeywords = "已拒絕|已拒绝|訂單已取消|订单已取消|逾時|逾时|已過期|已过期|上線中|上线中"
  /// v0.8 夾單邀請（上方小字「夾單訂單依系統顯示金額為主」）
  static let defaultStackedKeywords = "夾單|夹单"
  /// v1.2 送單中畫面常駐的接單字（單獨命中不算證據）、組合單每位客人一個的「送餐資訊」
  static let defaultWeakAcceptedKeywords = "筆訂單|笔订单|取餐體驗|取餐体验"
  static let defaultBundleKeywords = "送餐資訊|送餐资讯|送餐資讯|送餐资訊"

  var goneAfterMisses = 2
  var decideWindowSec = 25
  var acceptedKeywords = OfferSettings.defaultAcceptedKeywords
  var rejectedKeywords = OfferSettings.defaultRejectedKeywords
  var ambiguousAs = "accept"
  var stackedKeywords = OfferSettings.defaultStackedKeywords
  /// v1.1 分鐘數小於這個值又同時有接單後字樣 → 疑似誤讀（0＝關閉）
  var suspectBelowMinutes = 3
  /// v1.2
  var weakAcceptedKeywords = OfferSettings.defaultWeakAcceptedKeywords
  var bundleKeywords = OfferSettings.defaultBundleKeywords
  var maxBundle = 4

  init() {}

  init(root: [String: Any]) {
    let o = RemoteConfig.section(root, "offer")
    goneAfterMisses = RemoteConfig.int(o["goneAfterMisses"], 1, 20, goneAfterMisses)
    decideWindowSec = RemoteConfig.int(o["decideWindowSec"], 5, 60, decideWindowSec)
    acceptedKeywords = RemoteConfig.offerRegex(o["acceptedKeywords"], acceptedKeywords)
    rejectedKeywords = RemoteConfig.offerRegex(o["rejectedKeywords"], rejectedKeywords)
    ambiguousAs = RemoteConfig.choice(o["ambiguousAs"], ["accept", "reject"], ambiguousAs)
    stackedKeywords = RemoteConfig.offerRegex(o["stackedKeywords"], stackedKeywords)
    suspectBelowMinutes = RemoteConfig.int(o["suspectBelowMinutes"], 0, 10, suspectBelowMinutes)
    weakAcceptedKeywords = RemoteConfig.offerRegex(o["weakAcceptedKeywords"], weakAcceptedKeywords)
    bundleKeywords = RemoteConfig.offerRegex(o["bundleKeywords"], bundleKeywords)
    maxBundle = RemoteConfig.int(o["maxBundle"], 1, 4, maxBundle)
  }
}

/// 狀態機只吃這些（ScreenInfo.Summary 的子集合）；OCR 原文不進來
struct OfferObservation {
  let accept: Bool
  let minutes: Int?
  let amount: Double?
  let offerAccepted: Bool
  let offerRejected: Bool
  let offerHit: [String]
  let kw: [String]
  /// v0.8 這次 OCR 看到夾單字樣
  let stacked: Bool
  /// v1.2
  let acceptStrong: Bool
  let acceptWeak: Bool
  let orders: Int?
  let bundle: Int
  let tip: Int?

  init(_ s: ScreenInfo.Summary) {
    accept = s.accept
    minutes = s.minutes
    amount = s.amount
    offerAccepted = s.offerAccepted
    offerRejected = s.offerRejected
    offerHit = s.offerHit
    kw = s.kw
    stacked = s.stacked
    acceptStrong = s.acceptStrong
    acceptWeak = s.acceptWeak
    orders = s.orders
    bundle = s.bundle
    tip = s.tip
  }
}

struct Offer {
  let minutes: Int
  var amount: Double?
  /// 「分鐘/金額取整」；金額補齊時一起更新
  var key: String
  let firstSeen: Date
  var lastSeen: Date
  /// v0.8 夾單
  var stacked = false
  /// v1.2 組合單張數（「送餐資訊」最大次數）、小費（最近讀到的）、邀請前有沒有常駐字/最大「N筆訂單」
  var bundle = 0
  var tip: Int?
  var baseWeak = false
  var baseOrders: Int?
}

struct OfferDecision {
  let offer: Offer
  let accepted: Bool
  /// accepted / rejected / timeout / superseded / replaced / stopped
  let reason: String
  /// 接單時間（＝goneAt，按下接受的時間點）；未接 → nil
  let acceptedAt: Date?
  let decidedAt: Date
  /// 從邀請消失到決定的秒數（0.1 秒）；沒消失過 → 0
  let waitSec: Double
  let kw: [String]
  let hit: [String]
}

enum OfferEvent {
  case seen(Offer)
  case resumed(Offer, awaySec: Double)
  case dup(minutes: Int, amount: Double?)
  case decided(OfferDecision)
  /// v1.1 疑似誤讀的邀請（不送 pending）
  case suspect(minutes: Int)
}

final class OfferTracker {
  enum State {
    case idle
    case offered(Offer, misses: Int, firstMissAt: Date?)
    case deciding(Offer, goneAt: Date, lastKw: [String])
  }

  var settings = OfferSettings()
  var dedupeSeconds: TimeInterval = 90
  private(set) var state: State = .idle
  /// idle 時「出現中但判定為 dup」的那張（同一次出現只回報一次 dup）
  private var ignored: (minutes: Int, amount: Double?)?
  private var idleMisses = 0
  private var recentAccepted: [(minutes: Int, amount: Double?, at: Date)] = []
  /// v1.2 idle 時的畫面紀錄（常駐字/N筆訂單），只留 baselineSec 秒（＝TS BASELINE_SEC）
  static let baselineSec: TimeInterval = 120
  private var idleLog: [(at: Date, weak: Bool, orders: Int?)] = []

  static func key(_ minutes: Int, _ amount: Double?) -> String {
    "\(minutes)/\(ScreenInfo.amountKey(amount))"
  }

  /// 平台報酬（整數分）＝TS fareCents＝src/orders.ts exactFare
  static func fareCents(_ minutes: Int) -> Int {
    max(4500, minutes * 24500 / 60 + 1)
  }

  /// v1.2 金額合理？≥ fare−0.01；沒抓到 → true（＝TS plausibleAmount）
  static func plausible(_ minutes: Int, _ amount: Double?) -> Bool {
    guard let a = amount, a.isFinite else { return true }
    return Int((a * 100).rounded()) >= fareCents(minutes) - 1
  }

  /// 同一張邀請？分鐘相同，且金額相同或任一方沒抓到（amountKey＝0）；v1.2 或一方金額不可能地低。同 TS sameOffer
  static func same(_ minutesA: Int, _ amountA: Double?, _ minutesB: Int, _ amountB: Double?) -> Bool {
    guard minutesA == minutesB else { return false }
    if !plausible(minutesA, amountA) || !plausible(minutesB, amountB) { return true }
    let a = ScreenInfo.amountKey(amountA)
    let b = ScreenInfo.amountKey(amountB)
    return a == 0 || b == 0 || a == b
  }

  /// 先前沒抓到金額、這次抓到 → 補上（key 一起更新）；v1.2 先前的是誤讀、這次合理 → 換成這次的
  static func filled(_ offer: Offer, _ amount: Double?) -> Offer {
    guard ScreenInfo.amountKey(amount) != 0 else { return offer }
    let missing = ScreenInfo.amountKey(offer.amount) == 0
    let better = !plausible(offer.minutes, offer.amount) && plausible(offer.minutes, amount)
    guard missing || better else { return offer }
    var out = offer
    out.amount = amount
    out.key = key(offer.minutes, amount)
    return out
  }

  /// v1.2 組合單張數取最大、小費取最近讀到的（＝TS noteExtras）
  static func noted(_ offer: Offer, _ o: OfferObservation) -> Offer {
    var out = offer
    if o.bundle > out.bundle { out.bundle = o.bundle }
    if let t = o.tip { out.tip = t }
    return out
  }

  /// v1.2 判定中這次畫面算不算「接了」（＝TS acceptEvidence）
  static func acceptEvidence(_ offer: Offer, _ o: OfferObservation) -> Bool {
    guard o.offerAccepted else { return false }
    if o.acceptStrong { return true }
    if !offer.baseWeak { return true }
    guard let n = o.orders, let base = offer.baseOrders else { return false }
    return n > base
  }

  static func round1(_ x: Double) -> Double {
    (x * 10).rounded() / 10
  }

  /// v0.8：offered/deciding 中（extension 用來維持快速 OCR）
  var isActive: Bool {
    if case .idle = state { return false }
    return true
  }

  /// deciding 時：視窗到期的時間（呼叫端排計時器；畫面靜止時 ReplayKit 不送幀，不能只靠 OCR 推進）
  var deadline: Date? {
    if case .deciding(_, let goneAt, _) = state {
      return goneAt.addingTimeInterval(TimeInterval(settings.decideWindowSec))
    }
    return nil
  }

  /// 每次 OCR 完呼叫
  func observe(_ now: Date, _ o: OfferObservation) -> [OfferEvent] {
    var out: [OfferEvent] = []
    let s = settings
    if o.accept {
      idleMisses = 0
      let current: Offer?
      switch state {
      case .offered(let offer, _, _): current = offer
      case .deciding(let offer, _, _): current = offer
      case .idle: current = nil
      }
      var suspect = false
      if let m = o.minutes, s.suspectBelowMinutes > 0, m < s.suspectBelowMinutes, o.offerAccepted {
        suspect = !(current.map { Self.same($0.minutes, $0.amount, m, o.amount) } ?? false)
      }
      if suspect, let m = o.minutes { out.append(.suspect(minutes: m)) }
      guard let minutes = o.minutes, !suspect else {
        // 有接單鈕但還挑不出分鐘數（動畫中）：offered 視為仍在畫面上；其他狀態等下一次 OCR
        if case .offered(let offer, _, _) = state {
          var seen = Self.noted(offer, o)
          seen.lastSeen = now
          if o.stacked { seen.stacked = true }
          state = .offered(seen, misses: 0, firstMissAt: nil)
        }
        return out + tick(now)
      }
      switch state {
      case .offered(let offer, _, _):
        if Self.same(offer.minutes, offer.amount, minutes, o.amount) {
          var seen = Self.noted(Self.filled(offer, o.amount), o)
          seen.lastSeen = now
          if o.stacked { seen.stacked = true }
          state = .offered(seen, misses: 0, firstMissAt: nil)
          return out
        }
        out.append(decide(now, offer, accept: false, reason: "replaced", goneAt: nil, kw: o.kw, hit: []))
      case .deciding(let offer, let goneAt, _):
        if Self.same(offer.minutes, offer.amount, minutes, o.amount) {
          var seen = Self.noted(Self.filled(offer, o.amount), o)
          seen.lastSeen = now
          if o.stacked { seen.stacked = true }
          state = .offered(seen, misses: 0, firstMissAt: nil)
          out.append(.resumed(seen, awaySec: Self.round1(now.timeIntervalSince(goneAt))))
          return out
        }
        out.append(
          decide(now, offer, accept: s.ambiguousAs == "accept", reason: "superseded", goneAt: goneAt, kw: o.kw, hit: []))
      case .idle:
        if let ig = ignored, Self.same(ig.minutes, ig.amount, minutes, o.amount) { return out }
      }
      // 新的一張邀請
      let window = dedupeSeconds
      recentAccepted.removeAll { now.timeIntervalSince($0.at) >= window }
      if recentAccepted.contains(where: { Self.same($0.minutes, $0.amount, minutes, o.amount) }) {
        ignored = (minutes: minutes, amount: o.amount)
        out.append(.dup(minutes: minutes, amount: o.amount))
        return out
      }
      ignored = nil
      let base = idleLog.filter { now.timeIntervalSince($0.at) <= Self.baselineSec }
      var offer = Offer(
        minutes: minutes, amount: o.amount, key: Self.key(minutes, o.amount), firstSeen: now, lastSeen: now,
        stacked: o.stacked)
      offer.baseWeak = base.contains { $0.weak }
      offer.baseOrders = base.compactMap { $0.orders }.max()
      offer = Self.noted(offer, o)
      state = .offered(offer, misses: 0, firstMissAt: nil)
      out.append(.seen(offer))
      return out
    }

    // 畫面上沒有接單鈕
    let offer: Offer
    let goneAt: Date
    switch state {
    case .idle:
      idleMisses += 1
      if idleMisses >= s.goneAfterMisses { ignored = nil }
      idleLog.removeAll { now.timeIntervalSince($0.at) > Self.baselineSec }
      idleLog.append((at: now, weak: o.acceptWeak, orders: o.orders))
      return out
    case .offered(let current, let misses, let firstMissAt):
      let count = misses + 1
      let first = firstMissAt ?? now
      if count < s.goneAfterMisses {
        state = .offered(current, misses: count, firstMissAt: first)
        return out
      }
      offer = current
      goneAt = first
    case .deciding(let current, let gone, _):
      offer = current
      goneAt = gone
    }
    state = .deciding(offer, goneAt: goneAt, lastKw: o.kw)
    let accepted = Self.acceptEvidence(offer, o)
    if accepted && !o.offerRejected {
      out.append(decide(now, offer, accept: true, reason: "accepted", goneAt: goneAt, kw: o.kw, hit: o.offerHit))
      return out
    }
    if o.offerRejected && !accepted {
      out.append(decide(now, offer, accept: false, reason: "rejected", goneAt: goneAt, kw: o.kw, hit: o.offerHit))
      return out
    }
    return tick(now)
  }

  /// 計時器/每次 OCR：deciding 視窗到期 → 依 ambiguousAs
  func tick(_ now: Date) -> [OfferEvent] {
    guard case .deciding(let offer, let goneAt, let lastKw) = state,
          now.timeIntervalSince(goneAt) >= TimeInterval(settings.decideWindowSec)
    else { return [] }
    return [
      decide(now, offer, accept: settings.ambiguousAs == "accept", reason: "timeout", goneAt: goneAt, kw: lastKw, hit: [])
    ]
  }

  /// 廣播停止：offered → 未接；deciding → 依 ambiguousAs
  func finish(_ now: Date) -> [OfferEvent] {
    switch state {
    case .idle:
      return []
    case .offered(let offer, _, _):
      return [decide(now, offer, accept: false, reason: "stopped", goneAt: nil, kw: [], hit: [])]
    case .deciding(let offer, let goneAt, let lastKw):
      return [
        decide(
          now, offer, accept: settings.ambiguousAs == "accept", reason: "stopped", goneAt: goneAt, kw: lastKw, hit: [])
      ]
    }
  }

  private func decide(
    _ now: Date, _ offer: Offer, accept: Bool, reason: String, goneAt: Date?, kw: [String], hit: [String]
  ) -> OfferEvent {
    state = .idle
    idleMisses = 0
    if accept { recentAccepted.append((minutes: offer.minutes, amount: offer.amount, at: now)) }
    return .decided(
      OfferDecision(
        offer: offer, accepted: accept, reason: reason,
        acceptedAt: accept ? (goneAt ?? now) : nil, decidedAt: now,
        waitSec: goneAt.map { Self.round1(now.timeIntervalSince($0)) } ?? 0,
        kw: kw, hit: hit))
  }

  /// extension → App 的延遲秒數（App 用「收到時間 − 延遲」還原 acceptedAt）：四捨五入、夾在 0…60。同 TS acceptDelaySeconds
  static func delaySeconds(decidedAt: Date, acceptedAt: Date) -> Int {
    let d = decidedAt.timeIntervalSince(acceptedAt).rounded()
    guard d.isFinite else { return 0 }
    return min(60, max(0, Int(d)))
  }
}

// MARK: - v1.2 組合單拆分（＝src/offerBundle.ts splitBundle/evenSplit，以 TS 測試為準）

enum BundleSplit {
  static let maxBundle = 4

  /// 平均分：餘數給前面（23/2 → [12, 11]）
  static func even(_ total: Int, _ n: Int) -> [Int] {
    let base = total / n
    let rest = total - base * n
    return (0..<n).map { base + ($0 < rest ? 1 : 0) }
  }

  /// 總分鐘 T、總金額（含小費）、張數、小費 → 每張分鐘（大的在前）。Σfare 與（金額−小費）差 ≤0.02 的組合恰好一組才用，
  /// 多組/無解 → 平均分；張數 <2 或不夠分 → [T]
  static func split(totalMinutes: Int, amount: Double?, count: Int, tip: Int?) -> [Int] {
    let k = min(maxBundle, count)
    guard totalMinutes >= 1, k >= 2, totalMinutes >= k else { return [totalMinutes] }
    let evenParts = even(totalMinutes, k)
    guard let a = amount, a.isFinite else { return evenParts }
    let target = Int(((a - Double(tip ?? 0)) * 100).rounded())
    var found: [[Int]] = []
    var acc: [Int] = []
    func walk(_ left: Int, _ slots: Int, _ maxPart: Int, _ cents: Int) {
      if found.count > 1 { return }
      if slots == 0 {
        if left == 0 && abs(cents - target) <= 2 { found.append(acc) }
        return
      }
      let hi = min(maxPart, left - (slots - 1))
      let lo = (left + slots - 1) / slots
      guard hi >= lo else { return }
      for m in stride(from: hi, through: lo, by: -1) {
        acc.append(m)
        walk(left - m, slots - 1, m, cents + OfferTracker.fareCents(m))
        acc.removeLast()
      }
    }
    walk(totalMinutes, k, totalMinutes, 0)
    return found.count == 1 ? found[0] : evenParts
  }
}

// MARK: - v1.2 送單畫面「N 筆訂單」去抖（＝src/offerBundle.ts ScreenOrdersWatch，以 TS 測試為準；時間：Date）

final class ScreenOrdersWatch {
  static let minN = 2
  static let maxN = 5
  var repeatSec: TimeInterval = 300
  var minStreak = 2
  var quietSec: TimeInterval = 15
  private var streakN: Int?
  private var streak = 0
  private var quietUntil = Date.distantPast
  private var sentAt: [Int: Date] = [:]

  /// max(「N筆訂單」的 N, 有「疊單」＝2)；都沒有 → nil（＝TS screenOrderCount）
  static func count(orders: Int?, stackScreen: Bool) -> Int? {
    let n = max(orders ?? 0, stackScreen ? 2 : 0)
    return n > 0 ? n : nil
  }

  /// 接單訊號送出時呼叫
  func accepted(_ now: Date) {
    quietUntil = now.addingTimeInterval(quietSec)
    streakN = nil
    streak = 0
  }

  /// 每次 OCR：busy＝邀請進行中或畫面有接單鈕。回傳要送的 N（2~5）或 nil
  func observe(_ now: Date, n: Int?, busy: Bool) -> Int? {
    guard !busy, let raw = n, raw >= Self.minN else {
      streakN = nil
      streak = 0
      return nil
    }
    let v = min(Self.maxN, raw)
    if v == streakN {
      streak += 1
    } else {
      streakN = v
      streak = 1
    }
    if streak < minStreak || now < quietUntil { return nil }
    if let last = sentAt[v], now.timeIntervalSince(last) < repeatSec { return nil }
    sentAt[v] = now
    return v
  }
}
