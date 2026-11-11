import Foundation

// OCR 文字 → 預估分鐘數的挑選規則（純函式，無副作用）。
// ⚠️ 這個檔案有兩份，必須逐字相同（CI diff 擋）：native/intents/MinutePicker.swift、targets/broadcast/MinutePicker.swift。
// ⚠️ 與 src/ocrPick.ts 的 pickMinutes 是同一套規則；改一邊就改另一邊，並跑 `node --test` 驗樣本
//    （Swift 在 WSL 無法執行，TS 版即為這份規則的測試替身）。
// v0.6：正則/範圍/費率改成參數物件 PickerConfig（預設值＝原本的常數＝server/config.default.json 的 "picker"）；
//    遠端設定（GET /api/config，RemoteConfig.swift 快取在 UserDefaults "pandatimer.remoteConfig.v1"）可覆寫，不用重裝。
//    欄位缺漏或不合法 → 該欄位用預設（範圍與 src/remoteConfig.ts 的 RANGES 相同）。
//
// 規則：
//  1. 正規化：\r\n/\r → \n；全形數字 ０-９ → 0-9；全形空白 → 半形空白。
//  2. 候選＝minutePattern（預設「1~3 位整數 + 空白(含換行) + 分鐘|分钟|分|min」，數字前後不得緊鄰數字或小數點），
//     第 1 個捕捉群組＝分鐘數；不分大小寫。
//  3. 數值不在 minMinutes~maxMinutes 的候選丟棄。
//  4. 優先序：數字所在行含關鍵字（tier 0）> 上一行或下一行含關鍵字（tier 1）> 其他（tier 2）；
//     同 tier 取最先出現者。全無候選 → 規則 5（金額回推）。
struct PickerConfig {
  static let defaultMinutePattern = "(?<![0-9.])([0-9]{1,3})(?![0-9.])\\s*(?:分鐘|分钟|分|min)"
  static let defaultAmountAfterPattern = "(?<![0-9.])([0-9]{2,4}(?:\\.[0-9]{1,2})?)\\s*(?:\\$|＄|元)"
  static let defaultAmountBeforePattern = "(?:NT)?(?:\\$|＄)\\s*([0-9]{2,4}(?:\\.[0-9]{1,2})?)(?![0-9])"
  static let defaultKeywords: [String] = [
    "送達", "預計", "預估", "抵達", "完成", "剩餘",
    // 簡體（OCR 偶爾會辨成簡體字形）
    "送达", "预计", "预估", "抵达", "剩余",
  ]
  /// 遠端設定快取（RemoteConfig.swift 寫入；同一程序的 UserDefaults.standard）
  static let cacheKey = "pandatimer.remoteConfig.v1"

  var minutePattern = PickerConfig.defaultMinutePattern
  var minMinutes = 1
  var maxMinutes = 90
  var keywords = PickerConfig.defaultKeywords
  var amountAfterPattern = PickerConfig.defaultAmountAfterPattern
  var amountBeforePattern = PickerConfig.defaultAmountBeforePattern
  var minAmount = 30.0
  var maxAmount = 600.0
  // 依 583 筆報酬單驗證：預估報酬 = max(45, 預估分鐘 × 4.08355)。金額 ≤45 分不出分鐘數 → shortOrderMinutes。
  var ratePerMinute = 4.08355
  var minFare = 45.0
  var shortOrderMinutes = 8

  static let standard = PickerConfig()

  init() {}

  /// 遠端設定的 "picker" 區塊 → 設定；缺漏/不合法的欄位用預設
  init(json: [String: Any]?) {
    let d = json ?? [:]
    minutePattern = Self.regex(d["minutePattern"], groups: 1) ?? minutePattern
    amountAfterPattern = Self.regex(d["amountAfterPattern"], groups: 1) ?? amountAfterPattern
    amountBeforePattern = Self.regex(d["amountBeforePattern"], groups: 1) ?? amountBeforePattern
    minMinutes = Self.int(d["minMinutes"], 1, 90) ?? minMinutes
    maxMinutes = Self.int(d["maxMinutes"], 1, 90) ?? maxMinutes
    if minMinutes > maxMinutes {
      minMinutes = 1
      maxMinutes = 90
    }
    if let list = d["keywords"] as? [String], (1...40).contains(list.count),
       list.allSatisfy({ (1...10).contains($0.count) })
    {
      keywords = list
    }
    minAmount = Self.number(d["minAmount"], 0, 10000) ?? minAmount
    maxAmount = Self.number(d["maxAmount"], 1, 10000) ?? maxAmount
    if minAmount >= maxAmount {
      minAmount = 30
      maxAmount = 600
    }
    ratePerMinute = Self.number(d["ratePerMinute"], 0.1, 100) ?? ratePerMinute
    minFare = Self.number(d["minFare"], 0, 1000) ?? minFare
    shortOrderMinutes = Self.int(d["shortOrderMinutes"], 1, 90) ?? shortOrderMinutes
  }

  /// 本程序快取的遠端設定（沒有或壞掉 → 預設）
  static func cached() -> PickerConfig {
    guard let text = UserDefaults.standard.string(forKey: cacheKey), let data = text.data(using: .utf8),
          let root = (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
    else { return .standard }
    return PickerConfig(json: root["picker"] as? [String: Any])
  }

  static func number(_ v: Any?, _ lo: Double, _ hi: Double) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    let x = n.doubleValue
    return x.isFinite && x >= lo && x <= hi ? x : nil
  }

  static func int(_ v: Any?, _ lo: Int, _ hi: Int) -> Int? {
    guard let x = number(v, Double(lo), Double(hi)), x == x.rounded() else { return nil }
    return Int(x)
  }

  /// 編得過且捕捉群組數 ≥ groups 才收
  static func regex(_ v: Any?, groups: Int) -> String? {
    guard let p = v as? String, !p.isEmpty, p.count <= 300,
          let r = try? NSRegularExpression(pattern: p, options: [.caseInsensitive]),
          r.numberOfCaptureGroups >= groups
    else { return nil }
    return p
  }
}

enum MinutePicker {
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

  private static func lineHasKeyword(_ lines: [String], _ index: Int, _ keywords: [String]) -> Bool {
    guard index >= 0, index < lines.count else { return false }
    let line = lines[index]
    return keywords.contains { line.contains($0) }
  }

  private static func compile(_ pattern: String, fallback: String) -> NSRegularExpression? {
    (try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]))
      ?? (try? NSRegularExpression(pattern: fallback, options: [.caseInsensitive]))
  }

  static func pick(_ raw: String, config: PickerConfig = .standard) -> Int? {
    let text = normalize(raw)
    guard !text.isEmpty,
          let regex = compile(config.minutePattern, fallback: PickerConfig.defaultMinutePattern)
    else { return nil }
    let ns = text as NSString
    let lines = text.components(separatedBy: "\n")
    var bestTier = Int.max
    var bestValue: Int?
    for match in regex.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length)) {
      guard match.numberOfRanges > 1 else { continue }
      let numberRange = match.range(at: 1)
      guard numberRange.location != NSNotFound,
            let value = Int(ns.substring(with: numberRange)),
            value >= config.minMinutes, value <= config.maxMinutes
      else { continue }
      let lineIndex = ns.substring(to: numberRange.location).components(separatedBy: "\n").count - 1
      let tier: Int
      if lineHasKeyword(lines, lineIndex, config.keywords) {
        tier = 0
      } else if lineHasKeyword(lines, lineIndex - 1, config.keywords)
        || lineHasKeyword(lines, lineIndex + 1, config.keywords)
      {
        tier = 1
      } else {
        tier = 2
      }
      if tier < bestTier {
        bestTier = tier
        bestValue = value
      }
    }
    return bestValue ?? pickFromAmount(text, config: config)
  }

  // ── 規則 5（備援）：畫面沒有「XX 分鐘」時，用新單金額回推（與 src/ocrPick.ts 同規則）──
  static func minutes(fromAmount amount: Double, config: PickerConfig = .standard) -> Int? {
    guard amount >= config.minAmount, amount <= config.maxAmount else { return nil }
    if amount <= config.minFare + 0.005 { return config.shortOrderMinutes }
    let m = Int((amount / config.ratePerMinute).rounded())
    return (m >= config.minMinutes && m <= config.maxMinutes) ? m : nil
  }

  static func pickFromAmount(_ text: String, config: PickerConfig = .standard) -> Int? {
    guard let amount = firstAmount(text, config: config) else { return nil }
    return minutes(fromAmount: amount, config: config)
  }

  /// 畫面上的第一個金額（「110.26 $」優先，其次「$ 110.26」）；沒有 → nil。
  /// v0.6：螢幕廣播偵測用它當新單的第二個辨識鍵（分鐘數＋金額），與 src/ocrPick.ts 的 pickAmount 同規則。
  static func pickAmount(_ raw: String, config: PickerConfig = .standard) -> Double? {
    firstAmount(normalize(raw), config: config)
  }

  private static func firstAmount(_ text: String, config: PickerConfig) -> Double? {
    let ns = text as NSString
    let patterns = [
      (config.amountAfterPattern, PickerConfig.defaultAmountAfterPattern),
      (config.amountBeforePattern, PickerConfig.defaultAmountBeforePattern),
    ]
    for (pattern, fallback) in patterns {
      guard let regex = compile(pattern, fallback: fallback),
            let match = regex.firstMatch(in: text, options: [], range: NSRange(location: 0, length: ns.length)),
            match.numberOfRanges > 1,
            match.range(at: 1).location != NSNotFound,
            let amount = Double(ns.substring(with: match.range(at: 1)))
      else { continue }
      return amount
    }
    return nil
  }
}
