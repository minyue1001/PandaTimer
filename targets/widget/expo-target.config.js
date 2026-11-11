/**
 * Live Activity widget extension（@bacons/apple-targets）。
 * ⚠️ 不要加 entitlements（沒有 App Group / 推播）：SideStore 免費 Apple ID 簽不了。
 * Bundle id 由 plugin 自動產生為 com.pandatimer.app.widget。
 * @type {import('@bacons/apple-targets/app.plugin').Config}
 */
module.exports = {
  type: 'widget',
  name: 'PandaWidget',
  displayName: '熊貓倒數',
  deploymentTarget: '17.0',
  colors: {
    $accent: '#D70F64',
  },
};
