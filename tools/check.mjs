#!/usr/bin/env node
// Production gate: audits every deployable app in the repository.
// Usage: node tools/check.mjs [--strict] [--json]
//   --strict  treat warnings as failures
//   --json    machine readable output (used by CI summaries)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepo } from './lib/audit.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const asJson = args.has('--json');

const started = Date.now();
const report = await auditRepo(ROOT);
const failed = !report.ok || (strict && report.warnings.length > 0);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ok: !failed,
        checked: report.checked,
        errors: report.errors,
        warnings: report.warnings,
        notes: report.notes,
        durationMs: Date.now() - started
      },
      null,
      2
    )
  );
} else {
  for (const note of report.notes) console.log(`ℹ ${note}`);
  for (const warning of report.warnings) console.log(`⚠ ${warning}`);
  for (const error of report.errors) console.error(`✖ ${error}`);
  const summary = `${report.checked} files inspected · ${report.errors.length} error(s) · ${report.warnings.length} warning(s) · ${Date.now() - started}ms`;
  console.log(failed ? `\n✖ check FAILED — ${summary}` : `\n✔ check passed — ${summary}`);
}

process.exit(failed ? 1 : 0);
