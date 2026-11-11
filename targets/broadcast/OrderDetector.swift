import Foundation

// 新單畫面偵測（純函式）。⚠️ 與 src/ocrPick.ts 的 hasAcceptButton / detectNewOrderMinutes 同一套規則，
// 改一邊就改另一邊，並跑 `node --test`（Swift 在 WSL 無法執行，TS 版即為測試替身）。
// 新單畫面的特徵＝畫面上有「接受訂單」按鈕；OCR 可能字間插空白或辨成簡體 → 去空白後比對繁/簡；
// 前面緊接「已」的（已接受訂單…）不算。分鐘數交給 MinutePicker（與 native/intents 那份逐字相同）。
enum OrderDetector {
  private static let markerPattern = "(?<!已)接受(?:訂單|订单)"

  static func hasAcceptButton(_ raw: String) -> Bool {
    let text = MinutePicker.normalize(raw)
    guard !text.isEmpty,
          let spaces = try? NSRegularExpression(pattern: "\\s+", options: []),
          let marker = try? NSRegularExpression(pattern: markerPattern, options: [])
    else { return false }
    let compact = spaces.stringByReplacingMatches(
      in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
    let range = NSRange(location: 0, length: (compact as NSString).length)
    return marker.firstMatch(in: compact, options: [], range: range) != nil
  }

  /// 新單畫面 → 預估分鐘數；不是新單畫面或挑不出分鐘數 → nil
  static func detect(_ raw: String) -> Int? {
    guard hasAcceptButton(raw) else { return nil }
    return MinutePicker.pick(raw)
  }
}
