import Foundation

// 新單畫面偵測（純函式）。⚠️ 與 src/ocrPick.ts 的 hasAcceptButton / detectNewOrderMinutes 同一套規則，
// 改一邊就改另一邊，並跑 `node --test`（Swift 在 WSL 無法執行，TS 版即為測試替身）。
// 新單畫面的特徵＝畫面上有「接受訂單」按鈕；OCR 可能字間插空白或辨成簡體 → 去空白後比對繁/簡；
// 前面緊接「已」的（已接受訂單…）不算。分鐘數交給 MinutePicker（與 native/intents 那份逐字相同）。
// v0.6：接單鈕正則可由遠端設定 detector.acceptPattern 覆寫（編不過 → 用預設）。
enum OrderDetector {
  static let defaultAcceptPattern = "(?<!已)接受(?:訂單|订单)"

  static func hasAcceptButton(_ raw: String, pattern: String = OrderDetector.defaultAcceptPattern) -> Bool {
    let compact = ScreenInfo.compact(raw)
    guard !compact.isEmpty,
          let marker = (try? NSRegularExpression(pattern: pattern, options: []))
            ?? (try? NSRegularExpression(pattern: defaultAcceptPattern, options: []))
    else { return false }
    let range = NSRange(location: 0, length: (compact as NSString).length)
    return marker.firstMatch(in: compact, options: [], range: range) != nil
  }

  /// 新單畫面 → 預估分鐘數；不是新單畫面或挑不出分鐘數 → nil
  static func detect(_ raw: String, rules: ScreenRules = .standard) -> Int? {
    guard hasAcceptButton(raw, pattern: rules.acceptPattern) else { return nil }
    return MinutePicker.pick(raw, config: rules.picker)
  }
}

/// v0.6：畫面判讀規則（遠端設定 picker / detector.acceptPattern / telemetry.keywords；預設＝內建常數）
/// v0.7：加 offer.acceptedKeywords / rejectedKeywords（邀請消失後判斷接了沒，見 OfferTracker.swift）
struct ScreenRules {
  var picker = PickerConfig.standard
  var acceptPattern = OrderDetector.defaultAcceptPattern
  var keywords = ScreenInfo.keywords
  var acceptedKeywords = OfferSettings.defaultAcceptedKeywords
  var rejectedKeywords = OfferSettings.defaultRejectedKeywords
  var completedKeywords = RemoteConfig.DeliverySettings.defaultCompletedKeywords
  /// v0.8：優先送達字樣（訂單完成）、夾單字樣
  var finalKeywords = RemoteConfig.DeliverySettings.defaultFinalKeywords
  var stackedKeywords = OfferSettings.defaultStackedKeywords

  static let standard = ScreenRules()
}

// v0.6 遠端狀態回報用的畫面摘要：只產生結構化欄位，**OCR 原文不離開這個函式**。
// ⚠️ 與 src/screenInfo.ts 同一套規則；白名單另與 server/index.mjs 的 TELEMETRY_KEYWORDS 一致（test 比對）。
// 隱私鐵律：不得上傳 OCR 原文、地址、店名、顧客資訊。
enum ScreenInfo {
  /// [正式名稱, ...OCR 可能辨成的寫法（簡體）]；回報只用正式名稱
  static let keywords: [[String]] = [
    ["接受訂單", "接受订单"],
    ["拒絕", "拒绝"],
    ["前往取餐"],
    ["抵達餐廳", "抵达餐厅"],
    ["已取餐"],
    ["前往送餐"],
    ["抵達", "抵达"],
    ["送達", "送达"],
    ["完成訂單", "完成订单"],
    ["上線中", "上线中"],
    ["休息中"],
    ["訂單詳情", "订单详情"],
    ["聯絡", "联络", "聯繫", "联系"],
    ["導航", "导航"],
    ["拍照"],
    ["確認取餐", "确认取餐"],
    ["取消"],
    // v0.7 接單/未接判定用（offer.acceptedKeywords / rejectedKeywords 的預設詞；回報只送命中哪些詞）
    ["已拒絕", "已拒绝"],
    ["訂單已取消", "订单已取消"],
    ["逾時", "逾时"],
    ["已過期", "已过期"],
    ["已抵達", "已抵达"],
    ["抵達店家", "抵达店家"],
    ["聯絡店家", "联络店家", "联系店家"],
    ["取餐"],
    // v0.7 自動送達（delivery.completedKeywords 的預設詞；「完成訂單」已在上面）
    ["訂單已完成", "订单已完成"],
    ["已送達", "已送达"],
    ["送達完成", "送达完成"],
    ["確認送達", "确认送达"],
    ["完成送達", "完成送达"],
    // v0.8 首日實測畫面（夾單邀請、接單後、取餐/送達確認、送達後彈窗）
    ["夾單", "夹单"],
    ["訂單完成", "订单完成"],
    ["確認已送達", "确认已送达"],
    ["確認已取餐", "确认已取餐"],
    ["是否已取餐"],
    ["是否已送達", "是否已送达"],
    ["pickedup", "Pickedup", "PICKEDUP"],
    ["即將抵達", "即将抵达"],
    ["上傳照片", "上传照片"],
    ["無法聯繫", "无法联系", "無法聯絡"],
    ["筆訂單", "笔订单"],
    ["即將準備完成", "即将准备完成"],
    ["取餐體驗", "取餐体验"],
    ["每單收入", "每单收入"],
  ]

  private static let kmPattern = "(?<![0-9.])([0-9]{1,2}(?:\\.[0-9]{1,2})?)\\s*(?:公里|km)"

  struct Summary: Equatable {
    let accept: Bool
    let minutes: Int?
    let amount: Double?
    let km: Double?
    let kw: [String]
    let screen: String
    /// v0.7：命中 offer.acceptedKeywords / rejectedKeywords（正則，比對去空白後的文字）
    let offerAccepted: Bool
    let offerRejected: Bool
    /// 命中的那段文字裡含哪些白名單詞（正式名稱）；不在白名單的命中只回報布林，不回報文字
    let offerHit: [String]
    /// v0.7 自動送達：命中 delivery.completedKeywords（有接單鈕的邀請畫面不算）
    let delivered: Bool
    let deliveredHit: [String]
    /// v0.8：命中 delivery.finalKeywords（「訂單完成」＝最可信的送達時間）
    let deliveredFinal: Bool
    /// v0.8：邀請畫面上有「夾單」（offer.stackedKeywords）
    let stacked: Bool
  }

  /// 正規化（全形數字/空白）後去掉所有空白
  static func compact(_ raw: String) -> String {
    let text = MinutePicker.normalize(raw)
    guard let spaces = try? NSRegularExpression(pattern: "\\s+", options: []) else { return text }
    return spaces.stringByReplacingMatches(
      in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
  }

  static func matchKeywords(_ raw: String, rows: [[String]] = ScreenInfo.keywords) -> [String] {
    let text = compact(raw)
    guard !text.isEmpty else { return [] }
    return rows.filter { forms in !forms.isEmpty && forms.contains { text.contains($0) } }.map { $0[0] }
  }

  /// OCR 可能把小數點辨成全形句點/中點/逗號（數字之間才換）。同 src/screenInfo.ts 的 KM_DOTS
  private static let kmDotsPattern = "(?<=[0-9])\\s*[．。·•∙・‧,，]\\s*(?=[0-9])"

  /// 第一個「x.x 公里 / km」，0~99。v0.7 實機「6.7公里」回報成 67（小數點被 OCR 吃掉）→ ① 數字間的全形句點/中點/逗號
  /// 當小數點；② 兩位數整數且大於預估分鐘數（給了 minutes 時；時速 >60 不合理）→ 當作漏了小數點（67 → 6.7）
  static func extractKm(_ raw: String, minutes: Int? = nil) -> Double? {
    var text = MinutePicker.normalize(raw)
    if let dots = try? NSRegularExpression(pattern: kmDotsPattern, options: []) {
      text = dots.stringByReplacingMatches(
        in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: ".")
    }
    let ns = text as NSString
    guard let regex = try? NSRegularExpression(pattern: kmPattern, options: [.caseInsensitive]),
          let match = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
          match.range(at: 1).location != NSNotFound
    else { return nil }
    let digits = ns.substring(with: match.range(at: 1))
    guard var value = Double(digits), value >= 0, value < 100 else { return nil }
    if !digits.contains("."), value >= 10, let m = minutes, m > 0, value > Double(m) { value /= 10 }
    return value
  }

  static func classify(accept: Bool, hits: [String]) -> String {
    func has(_ names: String...) -> Bool { names.contains { hits.contains($0) } }
    if accept { return "newOrder" }
    if has("訂單詳情") { return "detail" }
    if has("前往送餐", "已取餐", "完成訂單") { return "delivering" }
    if has("前往取餐", "抵達餐廳", "確認取餐") { return "pickup" }
    if has("上線中", "休息中") { return "idle" }
    return hits.isEmpty ? "none" : "other"
  }

  /// 去空白文字裡第一段命中 pattern 的字（編不過 → 用 fallback；空字串命中當沒命中）。同 src/screenInfo.ts 的 firstOfferMatch
  static func firstOfferMatch(_ compactText: String, _ pattern: String, fallback: String) -> String? {
    guard !compactText.isEmpty,
          let regex = (try? NSRegularExpression(pattern: pattern, options: []))
            ?? (try? NSRegularExpression(pattern: fallback, options: []))
    else { return nil }
    let ns = compactText as NSString
    guard let match = regex.firstMatch(in: compactText, options: [], range: NSRange(location: 0, length: ns.length)),
          match.range.location != NSNotFound, match.range.length > 0
    else { return nil }
    return ns.substring(with: match.range)
  }

  /// OCR 文字 → 結構化摘要。minutes 只在有接單鈕時才挑（同 OrderDetector.detect）
  static func analyze(_ raw: String, rules: ScreenRules = .standard) -> Summary {
    let accept = OrderDetector.hasAcceptButton(raw, pattern: rules.acceptPattern)
    let kw = matchKeywords(raw, rows: rules.keywords)
    let text = compact(raw)
    let acc = firstOfferMatch(text, rules.acceptedKeywords, fallback: OfferSettings.defaultAcceptedKeywords)
    let rej = firstOfferMatch(text, rules.rejectedKeywords, fallback: OfferSettings.defaultRejectedKeywords)
    // 分隔符不是空白：避免兩段黏在一起湊出假命中
    let hitText = [acc, rej].compactMap { $0 }.joined(separator: "|")
    let finalHit: String? = accept
      ? nil
      : firstOfferMatch(text, rules.finalKeywords, fallback: RemoteConfig.DeliverySettings.defaultFinalKeywords)
    let done: String? = accept
      ? nil
      : (firstOfferMatch(text, rules.completedKeywords, fallback: RemoteConfig.DeliverySettings.defaultCompletedKeywords)
        ?? finalHit)
    let stacked = firstOfferMatch(text, rules.stackedKeywords, fallback: OfferSettings.defaultStackedKeywords) != nil
    let minutes = accept ? MinutePicker.pick(raw, config: rules.picker) : nil
    return Summary(
      accept: accept,
      minutes: minutes,
      amount: MinutePicker.pickAmount(raw, config: rules.picker),
      km: extractKm(raw, minutes: minutes),
      kw: kw,
      screen: classify(accept: accept, hits: kw),
      offerAccepted: acc != nil,
      offerRejected: rej != nil,
      offerHit: hitText.isEmpty ? [] : matchKeywords(hitText, rows: rules.keywords),
      delivered: done != nil,
      deliveredHit: done.map { matchKeywords($0, rows: rules.keywords) } ?? [],
      deliveredFinal: finalHit != nil,
      stacked: stacked)
  }

  /// v0.9：摘要＋「畫面上有沒有 pandarider」（特徵詞 away.keywords 或接單鈕；away 模式用，同 src/powerSaver.ts pandaPresent）。
  /// 只回布林，原文同樣不離開這裡
  static func analyzeWithPresence(_ raw: String, rules: ScreenRules, awayKeywords: String) -> (summary: Summary, panda: Bool) {
    let info = analyze(raw, rules: rules)
    let panda = info.accept
      || firstOfferMatch(compact(raw), awayKeywords, fallback: RemoteConfig.AwaySettings.defaultKeywords) != nil
    return (info, panda)
  }

  /// 金額 → 訊號/去重用的整數鍵（四捨五入，0~999；抓不到或超出範圍 → 0）。同 src/ocrPick.ts 的 amountKey
  static func amountKey(_ amount: Double?) -> Int {
    guard let a = amount, a.isFinite else { return 0 }
    let k = Int(a.rounded())
    return (k >= 1 && k <= 999) ? k : 0
  }
}
