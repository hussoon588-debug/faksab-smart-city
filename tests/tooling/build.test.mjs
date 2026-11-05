import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, loadConfig } from '../../tools/lib/audit.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = path.join(ROOT, 'dist');

const runBuild = (options = {}) =>
  spawnSync(process.execPath, ['tools/build.mjs', ...(options.args ?? [])], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) }
  });

test('production build emits a deployable dist/ with a verifiable manifest', async () => {
  const result = runBuild({ args: ['--skip-audit'] });
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);

  const apps = await loadConfig(ROOT);
  for (const app of apps) {
    for (const required of app.requiredFiles) {
      const target =
        required.startsWith(`${app.root}/`) || app.root === '.'
          ? path.join(DIST, required)
          : path.join(DIST, app.root, required);
      assert.ok(await exists(target), `${app.id}: ${required} missing from dist/`);
    }
  }

  const info = JSON.parse(await fs.readFile(path.join(DIST, 'build-info.json'), 'utf8'));
  assert.ok(Array.isArray(info.files) && info.files.length > 0, 'build-info.files is empty');
  assert.ok(info.files.some((file) => file.path === 'index.html'), 'index.html not recorded in build info');
  for (const file of info.files) {
    assert.equal(file.sha256.length, 64, `${file.path}: sha256 malformed`);
    assert.ok(file.bytes > 0, `${file.path}: empty file copied into dist/`);
  }
});

test('build aborts when the audit fails', async (t) => {
  // Isolated fixture tree: a broken asset reference must block the build.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofuq-build-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'config'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config', 'apps.json'),
    JSON.stringify({
      apps: [
        {
          id: 'probe',
          label: 'Probe',
          version: '0.0.1',
          root: '.',
          entry: 'index.html',
          requiredFiles: ['index.html'],
          copy: ['index.html']
        }
      ]
    })
  );
  await fs.writeFile(
    path.join(dir, 'index.html'),
    `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>probe</title></head>
<body><img src="./gone.png" alt=""></body></html>`
  );

  const result = runBuild({ env: { BUILD_ROOT: dir } });
  assert.equal(result.status, 1, 'build must exit non-zero when the audit fails');
  assert.match(result.stderr, /broken local reference "\.\/gone\.png"/);
  assert.ok(!(await exists(path.join(dir, 'dist', 'index.html'))), 'no dist output should be produced');
});
