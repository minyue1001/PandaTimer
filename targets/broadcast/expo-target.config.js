/**
 * v0.3/v0.4 螢幕廣播自動偵測（ReplayKit Broadcast Upload Extension，@bacons/apple-targets 的 broadcast-upload 型別）。
 * ⚠️ 不要加 entitlements（broadcast upload extension 本身不需要；免費 Apple ID 簽不了 App Group）。
 * Bundle id：com.pandatimer.app.broadcast（App 端 RPSystemBroadcastPickerView.preferredExtension 用同一個字串）。
 * 目錄內的 .swift 全自動編進此 target（資料夾同步）。
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'broadcast-upload',
  name: 'PandaBroadcast',
  displayName: '熊貓偵測',
  bundleIdentifier: '.broadcast',
  deploymentTarget: '17.0',
  // v0.4：不再用 ActivityKit（實測 extension 內不可用）與 CoreImage（改直接讀亮度平面，省記憶體）
  frameworks: ['Vision', 'UserNotifications', 'CoreMedia', 'CoreVideo'],
};
