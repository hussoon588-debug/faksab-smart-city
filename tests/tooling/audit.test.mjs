import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepo } from '../../tools/lib/audit.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

async function fixture(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ofuq-audit-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return dir;
}

const baseApp = (overrides = {}) => ({
  'config/apps.json': JSON.stringify({
    apps: [
      {
        id: 'demo',
        label: 'Demo',
        version: '1.0.0',
        root: '.',
        entry: 'index.html',
        manifest: 'manifest.json',
        serviceWorker: 'sw.js',
        requiredFiles: ['index.html'],
        copy: ['index.html']
      }
    ]
  }),
  'index.html': `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تجربة</title></head>
<body><div id="root"></div><script>document.getElementById('root').textContent = 'ok';</script></body></html>`,
  'manifest.json': JSON.stringify({
    name: 'Demo',
    short_name: 'Demo',
    lang: 'ar',
    dir: 'rtl',
    display: 'standalone',
    theme_color: '#000',
    version: '1.0.0',
    icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }]
  }),
  'icon-192.png': 'not-a-real-png',
  'sw.js': `const CACHE_NAME = 'demo-v1.0.0';
const APP_SHELL = ['./index.html'];
self.addEventListener('install', () => {});`,
  'README.md': '# demo',
  'SECURITY.md': '# security',
  'CONTRIBUTING.md': '# contributing',
  '.gitignore': 'node_modules/\ndist/\n',
  ...overrides
});

test('the repository passes its own audit', async () => {
  const report = await auditRepo(ROOT);
  assert.deepEqual(report.errors, [], `audit errors:\n${report.errors.join('\n')}`);
});

test('a clean fixture passes', async (t) => {
  const dir = await fixture(baseApp());
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const report = await auditRepo(dir);
  assert.deepEqual(report.errors, []);
});

test('detects duplicate ids, broken references and unresolved placeholders', async (t) => {
  const dir = await fixture(
    baseApp({
      'index.html': `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تجربة</title></head>
<body><div id="dup"></div><div id="dup"></div>
<img src="./missing.png" alt="">
<p>__FONT_AR__</p>
<script>document.getElementById('dup').textContent = 'ok';</script></body></html>`
    })
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const report = await auditRepo(dir);
  const joined = report.errors.join('\n');
  assert.match(joined, /duplicate id "dup"/);
  assert.match(joined, /broken local reference "\.\/missing\.png"/);
  assert.match(joined, /unresolved template placeholder __FONT_AR__/);
});

test('detects a missing element id and a stale service worker cache', async (t) => {
  const dir = await fixture(
    baseApp({
      'index.html': `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تجربة</title></head>
<body><div id="root"></div><script>document.getElementById('nope').textContent = 'x';</script></body></html>`,
      'sw.js': `const CACHE_NAME = 'demo-v0.9.0';
const APP_SHELL = ['./index.html'];
self.addEventListener('install', () => {});`
    })
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const report = await auditRepo(dir);
  const joined = report.errors.join('\n');
  assert.match(joined, /missing element id "nope"/);
  assert.match(joined, /CACHE_NAME "demo-v0\.9\.0" does not carry app version "1\.0\.0"/);
});

test('detects escaped newline leaks and committed secrets', async (t) => {
  const dir = await fixture(
    baseApp({
      'index.html': `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>تجربة</title></head>
<body><div id="root"></div>\\n<style>body{}</style></body></html>`,
      'docs/leak.txt': 'SERVICE_ROLE' + '_KEY = "0123456789abcdef0123456789abcdef"'
    })
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const report = await auditRepo(dir);
  const joined = report.errors.join('\n');
  assert.match(joined, /literal "\\n" escape/);
  assert.match(joined, /assigned service_role key/);
});
