import ExpoModulesCore
import ReplayKit
import UIKit

/// 包住 RPSystemBroadcastPickerView（系統「螢幕廣播」選擇器）。
/// preferredExtension 指定熊貓偵測 extension（targets/broadcast，bundle id com.pandatimer.app.broadcast），
/// 跳出的系統視窗只會列出它，使用者按「開始直播」即可。
/// 程式觸發：系統沒有公開 API，常見做法是找出 picker 內部的 UIButton 送 touchUpInside（Jitsi 等都這樣做）；
/// 找不到按鈕時 triggerBroadcastPicker 回傳 false，使用者仍可直接點這個 view（picker 本身就是可點的按鈕）。
final class BroadcastPickerView: ExpoView {
  static let extensionBundleId = "com.pandatimer.app.broadcast"

  private let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.preferredExtension = BroadcastPickerView.extensionBundleId
    picker.showsMicrophoneButton = false
    picker.backgroundColor = .clear
    addSubview(picker)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    picker.frame = bounds
    // 讓內部按鈕填滿整個 view，整塊都可以點
    if let button = findFirstButton(in: picker) {
      button.frame = picker.bounds
    }
  }
}

// 用全域函式（非 view 的成員）：module 的 AsyncFunction closure 是 nonisolated，
// 呼叫 view 子類別自己的方法會碰到 MainActor 隔離檢查；UIKit 本身的 API 在 Swift 5 模式只會是警告。
// 實際呼叫端有 .runOnQueue(.main)，確實在主執行緒。

/// 程式點一下 picker 的內部按鈕；找到並送出回傳 true
func triggerBroadcastPicker(_ root: UIView) -> Bool {
  guard let button = findFirstButton(in: root) else { return false }
  button.sendActions(for: .touchUpInside)
  return true
}

func findFirstButton(in view: UIView) -> UIButton? {
  for sub in view.subviews {
    if let button = sub as? UIButton { return button }
    if let found = findFirstButton(in: sub) { return found }
  }
  return nil
}
