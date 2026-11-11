import Foundation

// 新單畫面偵測（純函式）。⚠️ 與 src/ocrPick.ts 的 hasAcceptButton / detectNewOrderMinutes 同一套規則，
// 改一邊就改另一邊，並跑 `node --test`（Swift 在 WSL 無法執行，TS 版即為測試替身）。
// 新單畫面的特徵＝畫面上有「接受訂單」按鈕；OCR 可能字間插空白或辨成簡體 → 去空白後比對繁/簡；
// 前面緊接「已」的（已接受訂單…）不算。分鐘數交給 MinutePicker（與 native/intents 那份逐字相同）。
enum OrderDetector {
  private static let markerPattern = "(?<!已)接受(?:訂單|订单)"

  static func hasAcceptButton(_ raw: String) -> Bool {
    let compact = ScreenInfo.compact(raw)
    guard !compact.isEmpty, let marker = try? NSRegularExpression(pattern: markerPattern, options: []) else {
      return false
    }
    let range = NSRange(location: 0, length: (compact as NSString).length)
    return marker.firstMatch(in: compact, options: [], range: range) != nil
  }

  /// 新單畫面 → 預估分鐘數；不是新單畫面或挑不出分鐘數 → nil
  static func detect(_ raw: String) -> Int? {
    guard hasAcceptButton(raw) else { return nil }
    return MinutePicker.pick(raw)
  }
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
  ]

  private static let kmPattern = "(?<![0-9.])([0-9]{1,2}(?:\\.[0-9]{1,2})?)\\s*(?:公里|km)"

  struct Summary: Equatable {
    let accept: Bool
    let minutes: Int?
    let amount: Double?
    let km: Double?
    let kw: [String]
    let screen: String
  }

  /// 正規化（全形數字/空白）後去掉所有空白
  static func compact(_ raw: String) -> String {
    let text = MinutePicker.normalize(raw)
    guard let spaces = try? NSRegularExpression(pattern: "\\s+", options: []) else { return text }
    return spaces.stringByReplacingMatches(
      in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
  }

  static func matchKeywords(_ raw: String) -> [String] {
    let text = compact(raw)
    guard !text.isEmpty else { return [] }
    return keywords.filter { forms in forms.contains { text.contains($0) } }.map { $0[0] }
  }

  static func extractKm(_ raw: String) -> Double? {
    let text = MinutePicker.normalize(raw)
    let ns = text as NSString
    guard let regex = try? NSRegularExpression(pattern: kmPattern, options: [.caseInsensitive]),
          let match = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
          match.range(at: 1).location != NSNotFound,
          let value = Double(ns.substring(with: match.range(at: 1))),
          value >= 0, value < 100
    else { return nil }
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

  /// OCR 文字 → 結構化摘要。minutes 只在有接單鈕時才挑（同 OrderDetector.detect）
  static func analyze(_ raw: String) -> Summary {
    let accept = OrderDetector.hasAcceptButton(raw)
    let kw = matchKeywords(raw)
    return Summary(
      accept: accept,
      minutes: accept ? MinutePicker.pick(raw) : nil,
      amount: MinutePicker.pickAmount(raw),
      km: extractKm(raw),
      kw: kw,
      screen: classify(accept: accept, hits: kw))
  }

  /// 金額 → 訊號/去重用的整數鍵（四捨五入，0~999；抓不到或超出範圍 → 0）。同 src/ocrPick.ts 的 amountKey
  static func amountKey(_ amount: Double?) -> Int {
    guard let a = amount, a.isFinite else { return 0 }
    let k = Int(a.rounded())
    return (k >= 1 && k <= 999) ? k : 0
  }
}
