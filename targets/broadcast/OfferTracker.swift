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

/// 遠端設定 "offer" 區塊（預設＝src/offerTracker.ts 的 DEFAULT_OFFER＝server/config.default.json；範圍同 RANGES）
struct OfferSettings {
  // ⚠️ 待實測調整：pandarider 接單後畫面還沒看過，先猜；調整改 server/config.json 的 offer.*，不用重裝
  static let defaultAcceptedKeywords =
    "前往取餐|抵達(?:店家|餐廳)|抵达(?:店家|餐厅)|確認取餐|确认取餐|已抵達|已抵达|取餐|導航|导航|訂單詳情|订单详情|聯絡店家|联络店家|联系店家"
  static let defaultRejectedKeywords = "已拒絕|已拒绝|訂單已取消|订单已取消|逾時|逾时|已過期|已过期|上線中|上线中"

  var goneAfterMisses = 2
  var decideWindowSec = 25
  var acceptedKeywords = OfferSettings.defaultAcceptedKeywords
  var rejectedKeywords = OfferSettings.defaultRejectedKeywords
  var ambiguousAs = "accept"

  init() {}

  init(root: [String: Any]) {
    let o = RemoteConfig.section(root, "offer")
    goneAfterMisses = RemoteConfig.int(o["goneAfterMisses"], 1, 20, goneAfterMisses)
    decideWindowSec = RemoteConfig.int(o["decideWindowSec"], 5, 60, decideWindowSec)
    acceptedKeywords = RemoteConfig.offerRegex(o["acceptedKeywords"], acceptedKeywords)
    rejectedKeywords = RemoteConfig.offerRegex(o["rejectedKeywords"], rejectedKeywords)
    ambiguousAs = RemoteConfig.choice(o["ambiguousAs"], ["accept", "reject"], ambiguousAs)
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

  init(_ s: ScreenInfo.Summary) {
    accept = s.accept
    minutes = s.minutes
    amount = s.amount
    offerAccepted = s.offerAccepted
    offerRejected = s.offerRejected
    offerHit = s.offerHit
    kw = s.kw
  }
}

struct Offer {
  let minutes: Int
  var amount: Double?
  /// 「分鐘/金額取整」；金額補齊時一起更新
  var key: String
  let firstSeen: Date
  var lastSeen: Date
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

  static func key(_ minutes: Int, _ amount: Double?) -> String {
    "\(minutes)/\(ScreenInfo.amountKey(amount))"
  }

  /// 同一張邀請？分鐘相同，且金額相同或任一方沒抓到（amountKey＝0）。同 TS sameOffer
  static func same(_ minutesA: Int, _ amountA: Double?, _ minutesB: Int, _ amountB: Double?) -> Bool {
    guard minutesA == minutesB else { return false }
    let a = ScreenInfo.amountKey(amountA)
    let b = ScreenInfo.amountKey(amountB)
    return a == 0 || b == 0 || a == b
  }

  /// 先前沒抓到金額、這次抓到 → 補上（key 一起更新）
  static func filled(_ offer: Offer, _ amount: Double?) -> Offer {
    guard ScreenInfo.amountKey(offer.amount) == 0, ScreenInfo.amountKey(amount) != 0 else { return offer }
    var out = offer
    out.amount = amount
    out.key = key(offer.minutes, amount)
    return out
  }

  static func round1(_ x: Double) -> Double {
    (x * 10).rounded() / 10
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
      guard let minutes = o.minutes else {
        // 有接單鈕但還挑不出分鐘數（動畫中）：offered 視為仍在畫面上；其他狀態等下一次 OCR
        if case .offered(let offer, _, _) = state {
          var seen = offer
          seen.lastSeen = now
          state = .offered(seen, misses: 0, firstMissAt: nil)
        }
        return tick(now)
      }
      switch state {
      case .offered(let offer, _, _):
        if Self.same(offer.minutes, offer.amount, minutes, o.amount) {
          var seen = Self.filled(offer, o.amount)
          seen.lastSeen = now
          state = .offered(seen, misses: 0, firstMissAt: nil)
          return out
        }
        out.append(decide(now, offer, accept: false, reason: "replaced", goneAt: nil, kw: o.kw, hit: []))
      case .deciding(let offer, let goneAt, _):
        if Self.same(offer.minutes, offer.amount, minutes, o.amount) {
          var seen = Self.filled(offer, o.amount)
          seen.lastSeen = now
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
      let offer = Offer(
        minutes: minutes, amount: o.amount, key: Self.key(minutes, o.amount), firstSeen: now, lastSeen: now)
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
    if o.offerAccepted && !o.offerRejected {
      out.append(decide(now, offer, accept: true, reason: "accepted", goneAt: goneAt, kw: o.kw, hit: o.offerHit))
      return out
    }
    if o.offerRejected && !o.offerAccepted {
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
