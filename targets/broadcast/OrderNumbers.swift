import Foundation

// v1.1 以「#單號」配對送達（extension，只在 BroadcastDetector 的 workQueue 上用）。
// ⚠️ 與 src/orderNumbers.ts（OrderNumbers/OrderNumberBook）、src/deliveryDetector.ts（DeliveryWatch）同一套規則；
//    Swift 在 WSL 不能跑 → 以 TS 測試為準（test/orderNumbers.test.mjs），改一邊改兩邊。
// 隱私：單號只活在 extension 記憶體，**不得上傳 telemetry**（只回報 matched=true/false 與原因）。

enum OrderNumbers {
  /// 「#7318」「＃ 7318」；後面不能再接數字
  static let numberPattern = "[#＃]\\s*([0-9]{1,5})(?![0-9])"
  /// 對話框問句「…(#7318) 是否已送達?」
  static let dialogNumberPattern = "[#＃]\\s*([0-9]{1,5})\\s*[)）]?\\s*是否已?送[達达]"

  struct Scan {
    var numbers: [String]
    var dialogNo: String?
    var dialog: Bool
    /// 命中 finalKeywords（「訂單完成」彈窗在上半部，補掃也要看）
    var finalHit: Bool

    static let empty = Scan(numbers: [], dialogNo: nil, dialog: false, finalHit: false)
  }

  /// 去前導 0；0 不算
  static func canon(_ digits: String) -> String? {
    guard let n = Int(digits), n > 0 else { return nil }
    return String(n)
  }

  static func extract(_ raw: String) -> [String] {
    let text = MinutePicker.normalize(raw)
    guard let regex = try? NSRegularExpression(pattern: numberPattern, options: []) else { return [] }
    let ns = text as NSString
    var out: [String] = []
    for m in regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
      guard m.range(at: 1).location != NSNotFound, let n = canon(ns.substring(with: m.range(at: 1))) else { continue }
      if !out.contains(n) { out.append(n) }
    }
    return out
  }

  /// 先找緊接「是否已送達」的；找不到且畫面上只有一個 #號 → 用它；否則 nil
  static func deliveryNumber(_ raw: String) -> String? {
    let text = MinutePicker.normalize(raw)
    let ns = text as NSString
    if let regex = try? NSRegularExpression(pattern: dialogNumberPattern, options: []),
       let m = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
       m.range(at: 1).location != NSNotFound
    {
      return canon(ns.substring(with: m.range(at: 1)))
    }
    let all = extract(raw)
    return all.count == 1 ? all[0] : nil
  }

  static func scan(_ raw: String, dialogPattern: String, finalPattern: String) -> Scan {
    let compact = ScreenInfo.compact(raw)
    let dialog = ScreenInfo.firstOfferMatch(
      compact, dialogPattern, fallback: RemoteConfig.DeliverySettings.defaultDialogKeywords) != nil
    let isFinal = ScreenInfo.firstOfferMatch(
      compact, finalPattern, fallback: RemoteConfig.DeliverySettings.defaultFinalKeywords) != nil
    return Scan(numbers: extract(raw), dialogNo: deliveryNumber(raw), dialog: dialog, finalHit: isFinal)
  }

  /// v1.2.4 還在送餐/抵達頁（還沒按確認）的字樣／已離開送餐頁的字樣（＝TS DELIVERY_STAY_KEYWORDS / DELIVERY_LEAVE_KEYWORDS）
  static let stayPattern = "即將抵達|即将抵达|抵達(?!店家|餐廳)|抵达(?!店家|餐厅)|已送達|已送达|目的地|樓層|楼层|付款方式|線上付款|线上付款|聯絡(?!店家)|联络(?!店家)|聯繫|联系(?!店家)|無法聯絡|上傳照片|上传照片|拍照|翻譯|翻译|夾單|夹单"
  static let leavePattern = "抵達店家|抵达店家|抵達餐廳|抵达餐厅|前往取餐|即將準備完成|即将准备完成|取餐體驗|取餐体验|上線中|上线中|休息中|訂單完成|订单完成|完成訂單|完成订单|每單收入|每单收入|接受訂單|接受订单"

  /// v1.2.4 這個畫面還是送餐/抵達頁？有接單鈕（新邀請）或離開字樣 → 否（＝TS deliveryStay）
  static func stay(_ raw: String, accept: Bool) -> Bool {
    if accept { return false }
    let text = ScreenInfo.compact(raw)
    return ScreenInfo.firstOfferMatch(text, stayPattern, fallback: stayPattern) != nil
      && ScreenInfo.firstOfferMatch(text, leavePattern, fallback: leavePattern) == nil
  }

  /// 主 OCR 原文 → 畫面摘要＋pandarider 與否＋號碼摘要＋v1.2.4 還在送餐頁（原文只進這一個函式；同 ScreenInfo.analyzeWithPresence）
  static func analyze(_ raw: String, rules: ScreenRules, awayKeywords: String, delivery: RemoteConfig.DeliverySettings)
    -> (summary: ScreenInfo.Summary, panda: Bool, scan: Scan, stay: Bool)
  {
    let analyzed = ScreenInfo.analyzeWithPresence(raw, rules: rules, awayKeywords: awayKeywords)
    return (
      analyzed.summary, analyzed.panda,
      scan(raw, dialogPattern: delivery.dialogKeywords, finalPattern: delivery.finalKeywords),
      stay(raw, accept: analyzed.summary.accept)
    )
  }

  /// 主畫面＋上方補掃：號碼聯集、對話框號碼補掃優先
  static func merge(_ main: Scan, _ extra: Scan?) -> Scan {
    guard let e = extra else { return main }
    var numbers = main.numbers
    for n in e.numbers where !numbers.contains(n) { numbers.append(n) }
    return Scan(
      numbers: numbers, dialogNo: e.dialogNo ?? main.dialogNo, dialog: main.dialog || e.dialog, finalHit: main.finalHit || e.finalHit)
  }
}

/// 接單 seq ↔ 單號（同 TS OrderNumberBook；時間：Date）
final class OrderNumberBook {
  struct Entry {
    let seq: Int
    let acceptedAt: Date
    var no: String?
  }

  enum Resolution {
    case seq(seq: Int, slot: Int)
    /// noNumber / unbound / slotReused
    case plain(String)
    case repeated
  }

  static let seqSlots = 4  // ＝PandaSignal.seqMod（order 訊號的序號槽）
  static let sentKeep: TimeInterval = 3600
  static let entryKeep: TimeInterval = 4 * 3600
  static let maxEntries = 16
  static let firstSeenGrace: TimeInterval = 2

  var bindWindow: TimeInterval = 300
  private(set) var entries: [Entry] = []
  private var sent: [String: Date] = [:]
  private var firstSeen: [String: Date] = [:]

  static func slot(_ seq: Int) -> Int {
    ((seq % seqSlots) + seqSlots) % seqSlots
  }

  func accepted(seq: Int, at: Date) {
    prune(at)
    entries.removeAll { $0.seq == seq }
    entries.append(Entry(seq: seq, acceptedAt: at, no: nil))
    if entries.count > Self.maxEntries { entries.removeFirst(entries.count - Self.maxEntries) }
  }

  func pendingBind(_ now: Date) -> Bool {
    entries.contains { $0.no == nil && now.timeIntervalSince($0.acceptedAt) <= bindWindow }
  }

  private func sentRecently(_ no: String, _ now: Date) -> Bool {
    sent[no].map { now.timeIntervalSince($0) < Self.sentKeep } ?? false
  }

  func see(_ now: Date, _ numbers: [String]) {
    for n in numbers where firstSeen[n] == nil { firstSeen[n] = now }
  }

  /// 恰好 1 個沒綁過、沒送過的號碼 → 綁給 bindWindow 內最近一張（seq 最大）還沒綁號的單（號碼要在接單後才第一次出現）
  func bind(_ now: Date, _ numbers: [String]) -> (seq: Int, waitSec: Double)? {
    prune(now)
    see(now, numbers)
    let candidates = numbers.filter { n in !entries.contains { $0.no == n } && !sentRecently(n, now) }
    guard candidates.count == 1 else { return nil }
    var index: Int?
    for (i, e) in entries.enumerated() {
      guard e.no == nil, now.timeIntervalSince(e.acceptedAt) <= bindWindow else { continue }
      if index.map({ e.seq > entries[$0].seq }) ?? true { index = i }
    }
    guard let i = index else { return nil }
    let first = firstSeen[candidates[0]] ?? now
    guard first >= entries[i].acceptedAt.addingTimeInterval(-Self.firstSeenGrace) else { return nil }
    entries[i].no = candidates[0]
    return (seq: entries[i].seq, waitSec: (now.timeIntervalSince(entries[i].acceptedAt) * 10).rounded() / 10)
  }

  func resolve(_ now: Date, _ no: String?) -> Resolution {
    prune(now)
    guard let no = no else { return .plain("noNumber") }
    if sentRecently(no, now) { return .repeated }
    guard let entry = entries.first(where: { $0.no == no }) else { return .plain("unbound") }
    let slot = Self.slot(entry.seq)
    if entries.contains(where: { $0.seq > entry.seq && Self.slot($0.seq) == slot }) { return .plain("slotReused") }
    return .seq(seq: entry.seq, slot: slot)
  }

  func markSent(_ now: Date, no: String?, seq: Int?) {
    if let n = no { sent[n] = now }
    if let s = seq {
      entries.removeAll { $0.seq == s }
    } else if let n = no {
      entries.removeAll { $0.no == n }
    }
  }

  private func prune(_ now: Date) {
    entries.removeAll { now.timeIntervalSince($0.acceptedAt) >= Self.entryKeep }
    sent = sent.filter { now.timeIntervalSince($0.value) < Self.sentKeep }
    firstSeen = firstSeen.filter { now.timeIntervalSince($0.value) < Self.entryKeep }
  }
}

/// v1.1 delivery.mode "disappear"：送達確認對話框/按鈕消失＝按下確認（同 TS DeliveryWatch）
final class DeliveryWatch {
  enum Action {
    /// why：disappear / final / finalAfterDialog / stopped；no＝對話框上的單號
    case send(delay: Int, why: String, no: String?)
    case visible
    case repeatSuppressed
  }

  static let goneAfterMisses = 2  // ＝DeliveryEdge.goneAfterMisses
  static let confirmSeconds: TimeInterval = 1
  static let repeatSeconds: TimeInterval = 60
  /// v1.2.4 退路：對話框最後一次出現後這麼久都沒再出現（且在 pandarider 畫面）→ 照送 stayGone（＝TS DELIVERY_STAY_GONE_SEC）
  static let stayGoneSeconds: TimeInterval = 180
  var stayGoneSec: TimeInterval = DeliveryWatch.stayGoneSeconds
  private var visible = false
  private var misses = 0
  private var firstMissAt: Date?
  private var timerArmed = false
  private var no: String?
  private var lastSentAt: Date?
  private var finalOn = false
  private var finalMisses = 0
  /// v1.2.4 對話框最後一次出現後、第一次沒看到的時間（暫離也照算；對話框/同一單號再出現才清）
  private var absentAt: Date?
  /// v1.2.4 最近一次觀察是不是 pandarider 畫面（退路只在 pandarider 上送）
  private var lastPanda = true

  var active: Bool { visible }
  var knowsNumber: Bool { no != nil }

  /// 剛消失、等確認的到期時間（呼叫端排計時器）
  var deadline: Date? {
    let quick: Date? = visible && timerArmed ? firstMissAt.map { $0.addingTimeInterval(Self.confirmSeconds) } : nil
    guard let stay = stayDeadline else { return quick }
    guard let q = quick else { return stay }
    return min(q, stay)
  }

  private var stayDeadline: Date? {
    guard visible, lastPanda, stayGoneSec > 0, let at = absentAt else { return nil }
    return at.addingTimeInterval(stayGoneSec)
  }

  /// changed＝這次 OCR 是因為畫面變了（不是同畫面強制重掃）；numbers＝畫面上的 #單號（同一單號還在＝不算消失）
  /// v1.2.4 stay＝還在送餐/抵達頁（OrderNumbers.stay）→ 不算消失
  func observe(
    _ now: Date, dialog: Bool, final isFinal: Bool, panda: Bool, dialogNo: String?, changed: Bool, numbers: [String],
    stay: Bool
  ) -> Action? {
    let finalEdge = edge(isFinal)
    lastPanda = panda
    if dialog {
      let first = !visible
      visible = true
      misses = 0
      firstMissAt = nil
      timerArmed = false
      absentAt = nil
      if let n = dialogNo { no = n }
      if isFinal { return send(now, why: "finalAfterDialog", delay: 0) }
      return first ? .visible : nil
    }
    if visible {
      if isFinal { return send(now, why: "finalAfterDialog", delay: delayFrom(now)) }
      if absentAt == nil { absentAt = now }
      if !panda {
        // 不在 pandarider（切 App、主畫面）＝暫離：不算消失，已開始的確認（含 1 秒計時）也作廢，回來再看（v1.2.4）
        resetMiss()
        return nil
      }
      if let n = no, numbers.contains(n) {
        // 同一單號還在畫面上（還在這張單的頁面）→ 不算消失，已開始的確認也取消
        resetMiss()
        absentAt = nil
        return nil
      }
      if stay {
        // v1.2.4 還在送餐/抵達頁（按鈕被捲走/收合）→ 不算消失；久了沒再看到對話框才走退路
        resetMiss()
        return tick(now)
      }
      misses += 1
      if firstMissAt == nil { firstMissAt = now }
      if changed { timerArmed = true }
      if misses >= Self.goneAfterMisses { return send(now, why: "disappear", delay: delayFrom(now)) }
      return tick(now)
    }
    if finalEdge {
      if let last = lastSentAt, now.timeIntervalSince(last) < Self.repeatSeconds { return .repeatSuppressed }
      no = dialogNo
      return send(now, why: "final", delay: 0)
    }
    return nil
  }

  func tick(_ now: Date) -> Action? {
    if visible, timerArmed, let at = firstMissAt, now.timeIntervalSince(at) >= Self.confirmSeconds {
      return send(now, why: "disappear", delay: delayFrom(now))
    }
    if let stay = stayDeadline, now >= stay, let at = absentAt {
      let d = now.timeIntervalSince(at).rounded()
      return send(now, why: "stayGone", delay: d.isFinite ? min(60, max(0, Int(d))) : 0)
    }
    return nil
  }

  private func resetMiss() {
    misses = 0
    firstMissAt = nil
    timerArmed = false
  }

  /// 廣播停止：剛消失、還在確認 → 送；按鈕還在（沒按）→ 不送
  func finish(_ now: Date) -> Action? {
    let out: Action? = visible && firstMissAt != nil ? send(now, why: "stopped", delay: delayFrom(now)) : nil
    visible = false
    misses = 0
    firstMissAt = nil
    timerArmed = false
    no = nil
    absentAt = nil
    return out
  }

  private func delayFrom(_ now: Date) -> Int {
    let d = now.timeIntervalSince(firstMissAt ?? now).rounded()
    return d.isFinite ? min(60, max(0, Int(d))) : 0
  }

  private func edge(_ hit: Bool) -> Bool {
    if hit {
      finalMisses = 0
      if finalOn { return false }
      finalOn = true
      return true
    }
    if finalOn {
      finalMisses += 1
      if finalMisses >= Self.goneAfterMisses {
        finalOn = false
        finalMisses = 0
      }
    }
    return false
  }

  private func send(_ now: Date, why: String, delay: Int) -> Action {
    let n = no
    visible = false
    misses = 0
    firstMissAt = nil
    timerArmed = false
    absentAt = nil
    no = nil
    lastSentAt = now
    return .send(delay: delay, why: why, no: n)
  }
}

/// v1.2.3 同一次送達只結一張（同 TS DeliveryGate；DeliveryWatch/DeliveryEdge 送出前都過這一關，只在 workQueue 上用）。
/// 最近一次送達（判定時間）sameDeliverySec 內：plain（沒單號：noNumber/unbound/slotReused）不送、同 seq 不送、不同 seq 照送；
/// plain 先暫緩 plainHoldSec：期間來 seq → 丟 plain 只送 seq；又來 plain → 丟後來的；到期/廣播停止才送，delay＋暫緩秒數（≤60）。
final class DeliveryGate {
  struct Signal {
    /// nil＝plain
    let seq: Int?
    let delay: Int
    /// telemetry result（seq/noNumber/unbound/slotReused）與已組好的欄位
    let result: String
    let fields: [String: Any]
  }

  enum Action {
    /// delay＝原 delay＋暫緩秒數（≤60）；held＝暫緩了幾秒
    case send(Signal, delay: Int, held: Int)
    case hold(Signal)
    /// reason：sameDelivery / sameSeq / superseded / heldPlain / reappeared
    case drop(Signal, reason: String)
  }

  var sameDeliverySec: TimeInterval = 30
  var plainHoldSec: TimeInterval = 12
  private var last: (at: Date, seq: Int?)?
  private var held: (at: Date, signal: Signal)?

  /// 暫緩的 plain 到期時間（呼叫端排計時器）
  var deadline: Date? { held.map { $0.at.addingTimeInterval(plainHoldSec) } }

  func offer(_ now: Date, _ signal: Signal) -> [Action] {
    var out = tick(now)
    if signal.seq == nil {
      if held != nil { return out + [.drop(signal, reason: "heldPlain")] }
      if recent(now) { return out + [.drop(signal, reason: "sameDelivery")] }
      if plainHoldSec <= 0 { return out + [emit(now, decidedAt: now, signal)] }
      held = (at: now, signal: signal)
      return out + [.hold(signal)]
    }
    if let h = held {
      out.append(.drop(h.signal, reason: "superseded"))
      held = nil
    }
    if recent(now), let l = last, l.seq == signal.seq { return out + [.drop(signal, reason: "sameSeq")] }
    return out + [emit(now, decidedAt: now, signal)]
  }

  /// 計時器/每個訊號前：暫緩到期 → 送
  func tick(_ now: Date) -> [Action] {
    guard let h = held, now.timeIntervalSince(h.at) >= plainHoldSec else { return [] }
    return flush(now)
  }

  /// v1.2.7 暫緩期間同一個送達確認畫面又出現（DeliveryWatch visible）＝剛才的「消失」只是閃爍 → 丟掉暫緩中的 plain
  func cancelHeld() -> [Action] {
    guard let h = held else { return [] }
    held = nil
    return [.drop(h.signal, reason: "reappeared")]
  }

  /// 廣播停止：暫緩中的 plain 立刻送（可能是唯一的送達訊號）
  func finish(_ now: Date) -> [Action] {
    held == nil ? [] : flush(now)
  }

  private func flush(_ now: Date) -> [Action] {
    guard let h = held else { return [] }
    held = nil
    return [emit(now, decidedAt: h.at, h.signal)]
  }

  private func recent(_ now: Date) -> Bool {
    guard let l = last else { return false }
    return now.timeIntervalSince(l.at) < sameDeliverySec
  }

  private func emit(_ now: Date, decidedAt: Date, _ signal: Signal) -> Action {
    let d = now.timeIntervalSince(decidedAt).rounded()
    let heldSec = d.isFinite ? max(0, Int(d)) : 0
    last = (at: decidedAt, seq: signal.seq)
    return .send(signal, delay: min(60, signal.delay + heldSec), held: heldSec)
  }
}
