/**
 * v0.6 遠端狀態回報＋遠端設定：把 app.json 的 extra.telemetryKey / extra.telemetryUrl / extra.configUrl 與 runtimeVersion
 * 寫進主 App 的 Info.plist：PandaTelemetryKey / PandaTelemetryURL / PandaConfigURL / PandaRuntimeVersion
 * 原生（modules/live-activity/ios/PandaTelemetry.swift）從 Info.plist 讀；螢幕廣播 extension 讀「所屬 App」的 Info.plist
 * （.appex 往上兩層），所以不用改 targets/broadcast/Info.plist。
 * 寫入金鑰會進 App（可接受：只能寫、不能讀；讀取金鑰只在本機與伺服器）。不是 entitlement。
 */
const { withInfoPlist } = require('expo/config-plugins');

const withTelemetry = (config) =>
  withInfoPlist(config, (cfg) => {
    const extra = cfg.extra || {};
    const key = typeof extra.telemetryKey === 'string' ? extra.telemetryKey.trim() : '';
    const url = typeof extra.telemetryUrl === 'string' ? extra.telemetryUrl.trim() : '';
    const configUrl = typeof extra.configUrl === 'string' ? extra.configUrl.trim() : '';
    if (!key || !url) throw new Error('[withTelemetry] app.json 缺 extra.telemetryKey 或 extra.telemetryUrl');
    if (!/^https:\/\//.test(url)) throw new Error('[withTelemetry] extra.telemetryUrl 必須是 https');
    if (!/^https:\/\//.test(configUrl)) throw new Error('[withTelemetry] extra.configUrl 缺漏或不是 https');
    cfg.modResults.PandaTelemetryKey = key;
    cfg.modResults.PandaTelemetryURL = url;
    cfg.modResults.PandaConfigURL = configUrl;
    const rv = typeof cfg.runtimeVersion === 'string' ? cfg.runtimeVersion : '';
    if (rv) cfg.modResults.PandaRuntimeVersion = rv;
    return cfg;
  });

module.exports = withTelemetry;
