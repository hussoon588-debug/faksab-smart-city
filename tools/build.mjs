#!/usr/bin/env node
// Reproducible static build: audits the repo, then assembles `dist/` from the
// copy lists in config/apps.json and writes dist/build-info.json with hashes.
// Usage: node tools/build.mjs [--skip-audit]
//        BUILD_ROOT=/path node tools/build.mjs   (build a fixture tree; used by tests/staging)
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepo, loadConfig, exists, rel } from './lib/audit.mjs';

const ROOT = process.env.BUILD_ROOT
  ? path.resolve(process.env.BUILD_ROOT)
  : path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const skipAudit = process.argv.includes('--skip-audit');

async function copyEntry(from, to) {
  const stat = await fs.stat(from);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      await copyEntry(path.join(from, entry.name), path.join(to, entry.name));
    }
    return;
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
}

async function hashTree(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const buffer = await fs.readFile(full);
        out.push({
          path: rel(dir, full),
          bytes: buffer.length,
          sha256: createHash('sha256').update(buffer).digest('hex')
        });
      }
    }
  }
  await walk(dir);
  return out;
}

if (!skipAudit) {
  const report = await auditRepo(ROOT);
  if (!report.ok) {
    console.error('✖ build aborted: repository audit failed');
    for (const error of report.errors) console.error(`  ✖ ${error}`);
    process.exit(1);
  }
  for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
}

const apps = await loadConfig(ROOT);
await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

for (const app of apps) {
  for (const item of app.copy ?? []) {
    const from = path.join(ROOT, item);
    if (!(await exists(from))) {
      console.error(`✖ build: "${item}" is declared in config/apps.json but does not exist`);
      process.exit(1);
    }
    // `apps/ofuq` is published as `/apps/ofuq`, so its relative asset paths keep working.
    await copyEntry(from, path.join(DIST, item));
  }
}

const files = await hashTree(DIST);
const sha = process.env.GITHUB_SHA || process.env.GIT_SHA || 'local';
await fs.writeFile(
  path.join(DIST, 'build-info.json'),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      commit: sha,
      apps: apps.map((app) => ({ id: app.id, version: app.version, entry: app.entry })),
      files
    },
    null,
    2
  ) + '\n'
);

const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
console.log(`✔ build complete — ${files.length} files · ${(totalBytes / 1024 / 1024).toFixed(2)} MB → dist/`);
for (const app of apps) console.log(`  • ${app.label} ${app.version} → /${app.root === '.' ? '' : app.root.replace(/^apps\//, '')}`);
