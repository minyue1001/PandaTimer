/**
 * 把 native/intents/*.swift 加進「主 App target」（PandaTimer）的 Sources build phase。
 * 原因：App Intents 的 metadata（捷徑 App 看得到的動作、AppShortcutsProvider）只會從主 App target
 * （或 app intents extension）擷取；放在 CocoaPods 靜態 pod（modules/live-activity）裡系統不會發現。
 *
 * 檔案以相對路徑 ../native/intents/X.swift 參照（不複製進 ios/，prebuild --clean 也不會遺失）。
 * 另外把 AppIntents.framework 明確連結到主 target，確保 Xcode 的
 * 「Extract App Intents Metadata」不會因找不到 AppIntents 依賴而跳過（只靠 import 自動連結也可，這是保險）。
 * 不碰 entitlements（App Intents / App Shortcuts 不需要任何 entitlement）。
 */
const fs = require('fs');
const path = require('path');
const { withXcodeProject, IOSConfig } = require('expo/config-plugins');

const INTENTS_DIR = path.join('native', 'intents');
const FRAMEWORK = 'AppIntents.framework';

function linkSystemFramework(project, targetUuid, name) {
  const phase = project.pbxFrameworksBuildPhaseObj(targetUuid);
  if (!phase) throw new Error(`[withAppIntents] 找不到主 target 的 Frameworks build phase`);
  const buildFileComment = `${name} in Frameworks`;
  if (phase.files.some((f) => f.comment === buildFileComment)) return;

  const objects = project.hash.project.objects;
  const refs = objects.PBXFileReference || (objects.PBXFileReference = {});
  // 已有同名的 SDK framework 參照（例如 widget 那份）就共用
  let fileRef = Object.keys(refs).find(
    (k) => !k.endsWith('_comment') && refs[`${k}_comment`] === name && refs[k].sourceTree === 'SDKROOT',
  );
  if (!fileRef) {
    fileRef = project.generateUuid();
    refs[fileRef] = {
      isa: 'PBXFileReference',
      lastKnownFileType: 'wrapper.framework',
      name,
      path: `System/Library/Frameworks/${name}`,
      sourceTree: 'SDKROOT',
    };
    refs[`${fileRef}_comment`] = name;
  }
  const buildFile = project.generateUuid();
  objects.PBXBuildFile[buildFile] = { isa: 'PBXBuildFile', fileRef, fileRef_comment: name };
  objects.PBXBuildFile[`${buildFile}_comment`] = buildFileComment;
  phase.files.push({ value: buildFile, comment: buildFileComment });
}

const withAppIntents = (config) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const { projectRoot, platformProjectRoot, projectName } = cfg.modRequest;
    const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });

    const dir = path.join(projectRoot, INTENTS_DIR);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.swift'))
      .sort();
    if (!files.length) throw new Error(`[withAppIntents] ${INTENTS_DIR} 沒有 .swift 檔`);

    const added = new Set();
    for (const file of files) {
      const filepath = path.relative(platformProjectRoot, path.join(dir, file)).split(path.sep).join('/');
      added.add(filepath);
      IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
        filepath,
        groupName: projectName,
        project,
        targetUuid: target.uuid,
      });
    }
    // xcode 套件的 pbxFile 會寫出字面 `explicitFileType = undefined;`，Xcode 可能把它當成檔案型別
    // 蓋過 lastKnownFileType = sourcecode.swift → 檔案不被編譯。拿掉，只留 lastKnownFileType。
    const refs = project.hash.project.objects.PBXFileReference;
    for (const [key, ref] of Object.entries(refs)) {
      if (key.endsWith('_comment') || !ref || !added.has(String(ref.path).replace(/"/g, ''))) continue;
      if (ref.explicitFileType === undefined || ref.explicitFileType === 'undefined') delete ref.explicitFileType;
    }
    linkSystemFramework(project, target.uuid, FRAMEWORK);
    return cfg;
  });

module.exports = withAppIntents;
