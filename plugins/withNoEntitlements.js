/**
 * 鐵律：SideStore（免費 Apple ID）簽不了任何特殊 entitlement。
 * 這個 plugin 確保主 App 的 entitlements 永遠是空 dict：
 *  1) withEntitlementsPlist：清空所有 key（aps-environment、application-groups…）
 *  2) withFinalizedMod：所有 mod 寫完檔之後，再掃一次 ios/ 下所有 *.entitlements
 *     （不含 Pods），若還有任何 key 就清空重寫，與 plugin 執行順序無關。
 */
const fs = require('fs');
const path = require('path');
const { withEntitlementsPlist, withFinalizedMod } = require('expo/config-plugins');
const plist = require('@expo/plist').default ?? require('@expo/plist');

function findEntitlements(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'Pods' || ent.name === 'build' || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) findEntitlements(p, out);
    else if (ent.name.endsWith('.entitlements')) out.push(p);
  }
  return out;
}

const withNoEntitlements = (config) => {
  config = withEntitlementsPlist(config, (cfg) => {
    const keys = Object.keys(cfg.modResults);
    if (keys.length) console.log(`[withNoEntitlements] 移除主 App entitlements: ${keys.join(', ')}`);
    cfg.modResults = {};
    return cfg;
  });
  config = withFinalizedMod(config, [
    'ios',
    async (cfg) => {
      const iosRoot = cfg.modRequest.platformProjectRoot;
      for (const file of findEntitlements(iosRoot)) {
        const parsed = plist.parse(fs.readFileSync(file, 'utf8')) || {};
        const keys = Object.keys(parsed);
        if (keys.length) {
          console.log(`[withNoEntitlements] 清空 ${path.relative(iosRoot, file)}: ${keys.join(', ')}`);
          fs.writeFileSync(file, plist.build({}));
        }
      }
      return cfg;
    },
  ]);
  return config;
};

module.exports = withNoEntitlements;
