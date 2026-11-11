import Foundation

// OCR 文字 → 預估分鐘數的挑選規則（純函式，無副作用）。
// ⚠️ 與 src/ocrPick.ts 的 pickMinutes 是同一套規則；改一邊就改另一邊，並跑 `node --test` 驗樣本
//    （Swift 在 WSL 無法執行，TS 版即為這份規則的測試替身）。
//
// 規則：
//  1. 正規化：\r\n/\r → \n；全形數字 ０-９ → 0-9；全形空白 → 半形空白。
//  2. 候選＝「1~3 位整數 + 空白(含換行) + 分鐘|分钟|分|min」，數字前後不得緊鄰數字或小數點
//     （排除 3.2 公里、1234 這類）；容忍 OCR 把「18」與「分鐘」拆成兩行。
//  3. 數值不在 1~90 的候選丟棄。
//  4. 優先序：數字所在行含關鍵字（tier 0）> 上一行或下一行含關鍵字（tier 1）> 其他（tier 2）；
//     同 tier 取最先出現者。全無候選 → nil。
enum MinutePicker {
  static let minMinutes = 1
  static let maxMinutes = 90
  static let keywords: [String] = [
    "送達", "預計", "預估", "抵達", "完成", "剩餘",
    // 簡體（OCR 偶爾會辨成簡體字形）
    "送达", "预计", "预估", "抵达", "剩余",
  ]

  private static let candidatePattern = "(?<![0-9.])([0-9]{1,3})(?![0-9.])\\s*(?:分鐘|分钟|分|min)"

  static func normalize(_ raw: String) -> String {
    let unified = raw
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    var scalars = String.UnicodeScalarView()
    for u in unified.unicodeScalars {
      if u.value >= 0xFF10 && u.value <= 0xFF19, let ascii = Unicode.Scalar(u.value - 0xFF10 + 0x30) {
        scalars.append(ascii)
      } else if u.value == 0x3000 {
        scalars.append(" ")
      } else {
        scalars.append(u)
      }
    }
    return String(scalars)
  }

  private static func lineHasKeyword(_ lines: [String], _ index: Int) -> Bool {
    guard index >= 0, index < lines.count else { return false }
    let line = lines[index]
    return keywords.contains { line.contains($0) }
  }

  static func pick(_ raw: String) -> Int? {
    let text = normalize(raw)
    guard !text.isEmpty,
          let regex = try? NSRegularExpression(pattern: candidatePattern, options: [.caseInsensitive])
    else { return nil }
    let ns = text as NSString
    let lines = text.components(separatedBy: "\n")
    var bestTier = Int.max
    var bestValue: Int?
    for match in regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
      let numberRange = match.range(at: 1)
      guard numberRange.location != NSNotFound,
            let value = Int(ns.substring(with: numberRange)),
            value >= minMinutes, value <= maxMinutes
      else { continue }
      let lineIndex = ns.substring(to: numberRange.location).components(separatedBy: "\n").count - 1
      let tier: Int
      if lineHasKeyword(lines, lineIndex) {
        tier = 0
      } else if lineHasKeyword(lines, lineIndex - 1) || lineHasKeyword(lines, lineIndex + 1) {
        tier = 1
      } else {
        tier = 2
      }
      if tier < bestTier {
        bestTier = tier
        bestValue = value
      }
    }
    return bestValue ?? pickFromAmount(text)
  }

  // ── 規則 5（備援）：畫面沒有「XX 分鐘」時，用新單金額回推（與 src/ocrPick.ts 同規則）──
  // 依 583 筆報酬單驗證：預估報酬 = max(45, 預估分鐘 × 4.08355)。金額 ≤45 分不出分鐘數 → shortOrderMinutes。
  static let ratePerMinute = 4.08355
  static let minFare = 45.0
  static let shortOrderMinutes = 8
  private static let amountAfterPattern = "(?<![0-9.])([0-9]{2,4}(?:\\.[0-9]{1,2})?)\\s*(?:\\$|＄|元)"
  private static let amountBeforePattern = "(?:NT)?(?:\\$|＄)\\s*([0-9]{2,4}(?:\\.[0-9]{1,2})?)(?![0-9])"

  static func minutes(fromAmount amount: Double) -> Int? {
    guard amount >= 30, amount <= 600 else { return nil }
    if amount <= minFare + 0.005 { return shortOrderMinutes }
    let m = Int((amount / ratePerMinute).rounded())
    return (m >= minMinutes && m <= maxMinutes) ? m : nil
  }

  static func pickFromAmount(_ text: String) -> Int? {
    let ns = text as NSString
    for pattern in [amountAfterPattern, amountBeforePattern] {
      guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
            let match = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
            match.range(at: 1).location != NSNotFound,
            let amount = Double(ns.substring(with: match.range(at: 1)))
      else { continue }
      return minutes(fromAmount: amount)
    }
    return nil
  }
}
