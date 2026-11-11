// scripts/deploy-updates-server.sh 的遠端回滾邏輯（restore-prev / nginx-restore）本機模擬：
// 從腳本抽出單引號 heredoc 的遠端 lib，BASE/SYSTEMD_DIR/NGINX 都指到暫存目錄，systemctl/curl/journalctl 換成 stub（PATH 最前面），
// 絕不碰真的 systemd、nginx 或任何遠端主機。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = fs.readFileSync(new URL('../scripts/deploy-updates-server.sh', import.meta.url), 'utf8');
const m = /cat <<'REMOTE_EOF'\n([\s\S]*?)\nREMOTE_EOF\n/.exec(SCRIPT);
assert.ok(m, '找不到 REMOTE_EOF heredoc');
const LIB_BODY = m[1];

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-deploy-'));
  roots.push(root);
  const dirs = { base: path.join(root, 'opt'), unitDir: path.join(root, 'systemd'), stub: path.join(root, 'stub'), backup: path.join(root, 'bk') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const log = path.join(root, 'calls.log');
  const nginx = path.join(root, 'site.conf');
  fs.writeFileSync(nginx, 'server { listen 443; }\n');
  // stub：記錄呼叫；is-active 依 STUB_ACTIVE；curl 依 STUB_HEALTH 回 ok
  fs.writeFileSync(path.join(dirs.stub, 'systemctl'),
    `#!/bin/bash\necho "systemctl $*" >> "${log}"\nif [[ "$1" == is-active ]]; then [[ "\${STUB_ACTIVE:-1}" == 1 ]]; exit $?; fi\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dirs.stub, 'curl'), `#!/bin/bash\necho "curl $*" >> "${log}"\nprintf '%s' "\${STUB_HEALTH:-ok}"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dirs.stub, 'journalctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dirs.stub, 'nginx'), `#!/bin/bash\necho "nginx $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  // sleep 0.5 × 20 太慢 → stub
  fs.writeFileSync(path.join(dirs.stub, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const prefix = [
    `DOMAIN=example.invalid`, `SITE_NAME=site`, `BASE='${dirs.base}'`, `PORT=1`, `SVC=pandatimer-updates`,
    `PUBLIC_URL=https://example.invalid/p`, `NGINX_ENABLED='${nginx}'`, `BACKUP_DIR='${dirs.backup}'`,
    `REMOTE_NODE_BIN=`, `SYSTEMD_DIR='${dirs.unitDir}'`,
  ].join('\n') + '\n';
  const run = (args, env = {}) => {
    const r = spawnSync('bash', ['-s', '--', ...args], {
      input: prefix + LIB_BODY + '\n',
      env: { ...process.env, PATH: `${dirs.stub}:${process.env.PATH}`, ...env },
      encoding: 'utf8',
    });
    return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  };
  const put = (rel, text) => { const p = path.join(dirs.base, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const read = (rel) => fs.readFileSync(path.join(dirs.base, rel), 'utf8');
  const exists = (rel) => fs.existsSync(path.join(dirs.base, rel));
  return { root, dirs, run, put, read, exists, nginx, unit: path.join(dirs.unitDir, 'pandatimer-updates.service') };
}

test('restore-prev：換版前就失敗（.last-swap 是舊部署的）且原服務健康 → 保持原狀、不重啟、回報 restored', () => {
  const s = setup();
  s.put('server/index.mjs', 'v1');
  s.put('.last-swap', '20260101-000000\n');
  const r = s.run(['restore-prev', '20261112-120000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^@@restored ok$/m);
  assert.equal(s.read('server/index.mjs'), 'v1');
  assert.doesNotMatch(r.calls, /restart|daemon-reload/);
});

test('restore-prev：換版前就失敗但原服務不健康 → 不回報 restored（外層會停用）', () => {
  const s = setup();
  s.put('server/index.mjs', 'v1');
  const r = s.run(['restore-prev', '20261112-120000'], { STUB_ACTIVE: '0' });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /@@restored ok/);
});

test('restore-prev：已換版（重跑）→ 換回上一版程式、unit、server.env，daemon-reload＋restart，失敗版留在 server.failed', () => {
  const s = setup();
  const ts = '20261112-120000';
  s.put('.last-swap', ts + '\n');
  s.put('server/index.mjs', 'v2');
  s.put('server.prev/index.mjs', 'v1');
  s.put('server.env', 'NEW');
  s.put('server.env.prev', 'OLD');
  s.put('unit.prev', '[Service]\nExecStart=v1\n');
  fs.writeFileSync(s.unit, '[Service]\nExecStart=v2\nEnvironmentFile=x\n');
  const r = s.run(['restore-prev', ts]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^@@restored ok$/m);
  assert.equal(s.read('server/index.mjs'), 'v1');
  assert.equal(s.read('server.failed/index.mjs'), 'v2');
  assert.equal(s.read('server.env'), 'OLD');
  assert.equal(fs.readFileSync(s.unit, 'utf8'), '[Service]\nExecStart=v1\n');
  assert.equal(s.exists('.last-swap'), false);
  assert.match(r.calls, /systemctl daemon-reload[\s\S]*systemctl restart pandatimer-updates/);
});

test('restore-prev：v1→v0.6 第一次重跑（v1 沒有 server.env）→ 換回 v1 程式與 unit，server.env 留著無害', () => {
  const s = setup();
  const ts = '20261112-120000';
  s.put('.last-swap', ts + '\n');
  s.put('server/index.mjs', 'v2');
  s.put('server.prev/index.mjs', 'v1');
  s.put('server.env', 'NEW');
  s.put('unit.prev', 'v1-unit');
  const r = s.run(['restore-prev', ts]);
  assert.match(r.stdout, /^@@restored ok$/m);
  assert.equal(s.read('server/index.mjs'), 'v1');
  assert.equal(fs.readFileSync(s.unit, 'utf8'), 'v1-unit');
});

test('restore-prev：首次部署（已換版但沒有上一版）→ 不回報 restored（外層停用服務）', () => {
  const s = setup();
  const ts = '20261112-120000';
  s.put('.last-swap', ts + '\n');
  s.put('server/index.mjs', 'v2');
  const r = s.run(['restore-prev', ts]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /@@restored ok/);
  assert.equal(s.read('server/index.mjs'), 'v2');
});

test('restore-prev：換回後仍起不來 → 不回報 restored', () => {
  const s = setup();
  const ts = '20261112-120000';
  s.put('.last-swap', ts + '\n');
  s.put('server/index.mjs', 'v2');
  s.put('server.prev/index.mjs', 'v1');
  const r = s.run(['restore-prev', ts], { STUB_HEALTH: 'down' });
  assert.doesNotMatch(r.stdout, /@@restored ok/);
});

test('nginx-restore：這次沒改 nginx（沒有本次時間戳的備份）→ 不動檔案、不 reload（重跑不影響保衛小麥）', () => {
  const s = setup();
  const before = fs.readFileSync(s.nginx, 'utf8');
  fs.writeFileSync(path.join(s.dirs.backup, 'site.20200101-000000'), 'OLD BACKUP\n');
  const r = s.run(['nginx-restore', '20261112-120000']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /略過還原/);
  assert.equal(fs.readFileSync(s.nginx, 'utf8'), before);
  assert.doesNotMatch(r.calls, /reload|nginx -t/);
});
