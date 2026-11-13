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

  /// 主 OCR 原文 → 畫面摘要＋pandarider 與否＋號碼摘要（原文只進這一個函式；同 ScreenInfo.analyzeWithPresence）
  static func analyze(_ raw: String, rules: ScreenRules, awayKeywords: String, delivery: RemoteConfig.DeliverySettings)
    -> (summary: ScreenInfo.Summary, panda: Bool, scan: Scan)
  {
    let analyzed = ScreenInfo.analyzeWithPresence(raw, rules: rules, awayKeywords: awayKeywords)
    return (
      analyzed.summary, analyzed.panda,
      scan(raw, dialogPattern: delivery.dialogKeywords, finalPattern: delivery.finalKeywords)
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
  private var visible = false
  private var misses = 0
  private var firstMissAt: Date?
  private var timerArmed = false
  private var no: String?
  private var lastSentAt: Date?
  private var finalOn = false
  private var finalMisses = 0

  var active: Bool { visible }
  var knowsNumber: Bool { no != nil }

  /// 剛消失、等確認的到期時間（呼叫端排計時器）
  var deadline: Date? {
    guard visible, timerArmed, let at = firstMissAt else { return nil }
    return at.addingTimeInterval(Self.confirmSeconds)
  }

  /// changed＝這次 OCR 是因為畫面變了（不是同畫面強制重掃）；numbers＝畫面上的 #單號（同一單號還在＝不算消失）
  func observe(
    _ now: Date, dialog: Bool, final isFinal: Bool, panda: Bool, dialogNo: String?, changed: Bool, numbers: [String]
  ) -> Action? {
    let finalEdge = edge(isFinal)
    if dialog {
      let first = !visible
      visible = true
      misses = 0
      firstMissAt = nil
      timerArmed = false
      if let n = dialogNo { no = n }
      if isFinal { return send(now, why: "finalAfterDialog", delay: 0) }
      return first ? .visible : nil
    }
    if visible {
      if isFinal { return send(now, why: "finalAfterDialog", delay: delayFrom(now)) }
      if !panda { return tick(now) }  // 不在 pandarider：不算消失
      if let n = no, numbers.contains(n) {
        // 同一單號還在畫面上（還在這張單的頁面）→ 不算消失，已開始的確認也取消
        misses = 0
        firstMissAt = nil
        timerArmed = false
        return nil
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
    guard visible, timerArmed, let at = firstMissAt, now.timeIntervalSince(at) >= Self.confirmSeconds else { return nil }
    return send(now, why: "disappear", delay: delayFrom(now))
  }

  /// 廣播停止：剛消失、還在確認 → 送；按鈕還在（沒按）→ 不送
  func finish(_ now: Date) -> Action? {
    let out: Action? = visible && firstMissAt != nil ? send(now, why: "stopped", delay: delayFrom(now)) : nil
    visible = false
    misses = 0
    firstMissAt = nil
    timerArmed = false
    no = nil
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
    no = nil
    lastSentAt = now
    return .send(delay: delay, why: why, no: n)
  }
}
