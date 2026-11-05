// Static audit helpers shared by tools/check.mjs (CI gate) and tools/build.mjs (pre-flight).
// Zero dependencies: node core only, so the checks run anywhere Node 20+ is available.
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import vm from 'node:vm';

export const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.arena', '.cache', 'coverage']);
const TEXT_EXT = new Set(['.html', '.js', '.mjs', '.cjs', '.json', '.css', '.md', '.txt', '.yml', '.yaml', '.sql', '.svg', '.webmanifest']);

export class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.notes = [];
    this.checked = 0;
  }
  error(scope, message) {
    this.errors.push(`${scope}: ${message}`);
  }
  warn(scope, message) {
    this.warnings.push(`${scope}: ${message}`);
  }
  note(scope, message) {
    this.notes.push(`${scope}: ${message}`);
  }
  get ok() {
    return this.errors.length === 0;
  }
}

export const rel = (root, file) => path.relative(root, file).split(path.sep).join('/') || '.';

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(file) {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

/** Recursively list files under `dir`, skipping build output and dependency folders. */
export async function walk(dir, { skip = SKIP_DIRS, filter = () => true } = {}) {
  const out = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, { skip, filter })));
    else if (filter(full)) out.push(full);
  }
  return out;
}

export async function loadConfig(root) {
  const configPath = path.join(root, 'config', 'apps.json');
  const config = await readJsonFile(configPath);
  if (!Array.isArray(config.apps) || config.apps.length === 0) {
    throw new Error('config/apps.json must contain a non-empty "apps" array');
  }
  return config.apps;
}

/* ------------------------------------------------------------------ HTML --- */

const EXTERNAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const scriptCache = new Map();

function extractBlocks(html, tag) {
  const blocks = [];
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html))) blocks.push({ attrs: m[1] || '', body: m[2] || '', index: m.index });
  return blocks;
}

function attributeValue(attrs, name) {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** Collect local references from an HTML document. */
function collectHtmlRefs(html) {
  const refs = [];
  const attrRe = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    const value = (m[1] ?? m[2] ?? '').trim();
    if (!value || EXTERNAL_HREF.test(value)) continue;
    refs.push(value.split(/[?#]/)[0]);
  }
  const srcsetRe = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = srcsetRe.exec(html))) {
    for (const part of (m[1] ?? m[2] ?? '').split(',')) {
      const value = part.trim().split(/\s+/)[0];
      if (value && !EXTERNAL_HREF.test(value)) refs.push(value);
    }
  }
  for (const block of extractBlocks(html, 'style')) refs.push(...collectCssRefs(block.body));
  refs.push(...collectInlineStyleRefs(html));
  return [...new Set(refs)];
}

function collectInlineStyleRefs(html) {
  const out = [];
  const re = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html))) out.push(...collectCssRefs(m[1] ?? m[2] ?? ''));
  return out;
}

export function collectCssRefs(css) {
  const out = [];
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!value || /^data:/i.test(value) || EXTERNAL_HREF.test(value)) continue;
    out.push(value.split(/[?#]/)[0]);
  }
  const impRe = /@import\s+(?:url\()?\s*["']([^"']+)["']/gi;
  while ((m = impRe.exec(css))) out.push(m[1]);
  return out;
}

export function collectJsImports(source) {
  const out = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gim;
  let m;
  while ((m = re.exec(source))) {
    const spec = m[1];
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue; // bare specifier (import map / vendor alias)
    out.push(spec);
  }
  return out;
}

function checkSyntax(rep, scope, source, { module }) {
  if (module) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      encoding: 'utf8'
    });
    if (result.status !== 0) {
      rep.error(scope, `JavaScript syntax error: ${(result.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
    }
    return;
  }
  try {
    new vm.Script(source, { filename: scope });
  } catch (error) {
    rep.error(scope, `JavaScript syntax error: ${error.message}`);
  }
}

export async function auditHtml(root, entryAbs, rep) {
  const scope = rel(root, entryAbs);
  const html = await fs.readFile(entryAbs, 'utf8');
  const dir = path.dirname(entryAbs);

  if (!/^<!DOCTYPE html>/i.test(html.trimStart())) rep.error(scope, 'missing <!DOCTYPE html>');
  const htmlTag = html.match(/<html\b[^>]*>/i)?.[0] ?? '';
  if (!/\blang\s*=\s*["']ar["']/i.test(htmlTag)) rep.warn(scope, '<html lang="ar"> is expected for the Arabic UI');
  if (!/\bdir\s*=\s*["']rtl["']/i.test(htmlTag)) rep.warn(scope, '<html dir="rtl"> is expected');
  if (!/<meta\s+charset=/i.test(html)) rep.error(scope, 'missing <meta charset>');
  if (!/name=["']viewport["']/i.test(html)) rep.error(scope, 'missing viewport meta tag');
  if (!/<title>[^<]+<\/title>/i.test(html)) rep.error(scope, 'missing or empty <title>');

  // Neglected template placeholders make it into production far too often.
  for (const token of html.match(/__[A-Z][A-Z0-9_]{2,}__/g) ?? []) {
    rep.error(scope, `unresolved template placeholder ${token}`);
  }

  // Escaped newline leaks (`\n<style>`) render as literal text in the page.
  if (/\\n\s*</.test(html)) rep.error(scope, 'literal "\\n" escape found in markup (renders as visible text)');

  // Element ids: unique, and every id the scripts look up must exist.
  const ids = [...html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  for (const [id, count] of seen) if (count > 1) rep.error(scope, `duplicate id "${id}" (${count} uses)`);

  // Local references must resolve on disk.
  for (const ref of collectHtmlRefs(html)) {
    const target = path.resolve(dir, ref);
    if (!(await exists(target))) rep.error(scope, `broken local reference "${ref}"`);
  }

  // Inline scripts: syntax + id lookups.
  const idRefs = new Set();
  for (const block of extractBlocks(html, 'script')) {
    const src = attributeValue(block.attrs, 'src');
    const type = (attributeValue(block.attrs, 'type') || '').toLowerCase();
    if (src) {
      const target = path.resolve(dir, src);
      if (!(await exists(target))) rep.error(scope, `missing script "${src}"`);
      continue;
    }
    if (type === 'importmap') {
      try {
        JSON.parse(block.body);
      } catch {
        rep.error(scope, 'invalid import map (not valid JSON)');
      }
      continue;
    }
    if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
    if (!block.body.trim()) continue;
    rep.checked += 1;
    checkSyntax(rep, `${scope} <script>`, block.body, { module: type === 'module' });
    // Only literal lookups count: `getElementById('v-' + key)` is computed and cannot be verified.
    for (const re of [/getElementById\(\s*['"`]([A-Za-z][\w:-]*)['"`]\s*\)/g, /\$\(\s*['"`]([A-Za-z][\w:-]*)['"`]\s*\)/g]) {
      for (const match of block.body.matchAll(re)) idRefs.add(match[1]);
    }
    for (const spec of collectJsImports(block.body)) {
      if (!(await exists(path.resolve(dir, spec)))) rep.error(scope, `module import not found "${spec}"`);
    }
  }
  for (const id of idRefs) {
    if (!seen.has(id)) rep.error(scope, `script looks up missing element id "${id}"`);
  }

  // Inline CSS: balanced braces.
  for (const block of extractBlocks(html, 'style')) {
    const open = (block.body.match(/{/g) ?? []).length;
    const close = (block.body.match(/}/g) ?? []).length;
    if (open !== close) rep.error(scope, `unbalanced CSS braces in <style> (${open} "{" vs ${close} "}"`);
  }

  return { html, dir, ids };
}

/* -------------------------------------------------------------- manifest --- */

export async function auditManifest(root, manifestAbs, app, rep) {
  const scope = rel(root, manifestAbs);
  let manifest;
  try {
    manifest = await readJsonFile(manifestAbs);
  } catch (error) {
    rep.error(scope, `invalid JSON: ${error.message}`);
    return null;
  }
  if (!manifest.name) rep.error(scope, 'missing "name"');
  if (!manifest.short_name) rep.warn(scope, 'missing "short_name" (install banner quality)');
  if (!['ar', 'ar-*'].includes(manifest.lang) && manifest.lang !== 'ar') rep.warn(scope, 'expected "lang": "ar"');
  if (manifest.dir !== 'rtl') rep.warn(scope, 'expected "dir": "rtl"');
  if (!['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display)) rep.warn(scope, 'display should be an installable mode');
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) rep.error(scope, 'no icons declared');
  for (const icon of manifest.icons ?? []) {
    if (!icon.sizes) rep.warn(scope, `icon ${icon.src} is missing "sizes"`);
    if (!/^[a-z]+:/i.test(icon.src ?? '') && !icon.src?.startsWith('/')) {
      const target = path.resolve(path.dirname(manifestAbs), icon.src ?? '');
      if (!(await exists(target))) rep.error(scope, `icon file not found "${icon.src}"`);
    }
  }
  if (!manifest.theme_color) rep.warn(scope, 'missing "theme_color"');
  if (app?.version && manifest.version && manifest.version !== app.version) {
    rep.error(scope, `manifest version "${manifest.version}" does not match config version "${app.version}"`);
  }
  return manifest;
}

/* --------------------------------------------------------- service worker --- */

export async function auditServiceWorker(root, swAbs, app, rep) {
  const scope = rel(root, swAbs);
  const source = await fs.readFile(swAbs, 'utf8');
  checkSyntax(rep, scope, source, { module: false });

  // CACHE_NAME may be a literal or a template built from a version constant.
  const cacheName = source.match(/CACHE_NAME\s*=\s*['"`]([^'"`]+)['"`]/)?.[1] ?? null;
  const versionConsts = [...source.matchAll(/(?:APP_)?VERSION\s*=\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  if (!cacheName) rep.warn(scope, 'no CACHE_NAME constant found; cache invalidation cannot be verified');
  else if (app?.version) {
    const literalVersion = cacheName.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    const matches = cacheName.includes(app.version) || versionConsts.includes(app.version) || literalVersion === app.version;
    if (!matches) {
      rep.error(scope, `CACHE_NAME "${cacheName}" does not carry app version "${app.version}" — clients would keep stale files`);
    }
  }

  const shell = source.match(/(?:APP_SHELL|PRECACHE\w*|CACHE_ASSETS|ASSETS|SHELL)\s*=\s*\[([\s\S]*?)\]/);
  if (!shell) {
    rep.warn(scope, 'no precache list found (offline shell not verifiable)');
    return;
  }
  const entries = [...shell[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  if (entries.length === 0) rep.warn(scope, 'precache list is empty');
  for (const entry of entries) {
    if (/^[a-z]+:/i.test(entry) || entry.startsWith('//')) continue;
    const target = path.resolve(path.dirname(swAbs), entry);
    if (!(await exists(target))) rep.error(scope, `precached file not found "${entry}"`);
  }
  if (app?.id !== 'faksab') {
    // Comments may legitimately mention the published FAKSAB path; code must not.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    if (/\/faksab-smart-city\//.test(code)) {
      rep.warn(scope, 'hard-coded FAKSAB path found in a non-FAKSAB service worker');
    }
  }
}

/* ------------------------------------------------------------------- repo --- */

// Patterns that indicate real key material. Documentation that merely *mentions*
// `service_role` (as this repository's own guides do) must not trip the scan, so the
// checks target assignments, key formats and decodable JWT role claims.
export const FORBIDDEN_PATTERNS = [
  { re: /sb_secret_[A-Za-z0-9_-]{8,}/, message: 'Supabase secret key in a client file' },
  {
    re: /\b(?:SUPABASE_)?SERVICE_ROLE(?:_KEY)?\b\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/i,
    message: 'assigned service_role key'
  },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: 'private key material' },
  { re: /postgres(?:ql)?:\/\/[^\s'"`]*:[^\s'"`@]+@/i, message: 'database connection string with credentials' },
  { re: /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/, message: 'GitHub access token' }
];

const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function decodeJwtRole(token) {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return typeof json.role === 'string' ? json.role : null;
  } catch {
    return null;
  }
}

export async function secretScan(root, rep) {
  const files = await walk(root, { filter: (f) => TEXT_EXT.has(path.extname(f).toLowerCase()) });
  for (const file of files) {
    const relPath = rel(root, file);
    if (relPath.startsWith('.github/')) continue;
    const text = await fs.readFile(file, 'utf8');
    for (const { re, message } of FORBIDDEN_PATTERNS) {
      if (re.test(text)) rep.error(relPath, message);
    }
    for (const [token] of text.matchAll(JWT_RE)) {
      const role = decodeJwtRole(token);
      if (role === 'service_role') rep.error(relPath, 'JWT with role "service_role" (server-only key)');
      else if (role === null) rep.warn(relPath, 'undecodable JWT-looking string committed');
    }
    rep.checked += 1;
  }
}

export async function auditRepo(root) {
  const rep = new Report();
  const apps = await loadConfig(root);

  for (const app of apps) {
    for (const required of app.requiredFiles ?? []) {
      // Required paths are relative to the app root unless they already include it.
      const target = required.startsWith(`${app.root}/`) || app.root === '.'
        ? path.join(root, required)
        : path.join(root, app.root, required);
      if (!(await exists(target))) {
        rep.error(rel(root, target), `required file missing (declared in config/apps.json for "${app.id}")`);
      }
    }
    const entry = path.join(root, app.entry);
    if (await exists(entry)) {
      await auditHtml(root, entry, rep);
      // External stylesheets and modules referenced by the entry point.
      const html = await fs.readFile(entry, 'utf8');
      for (const block of extractBlocks(html, 'script')) {
        const src = attributeValue(block.attrs, 'src');
        if (!src) continue;
        const file = path.resolve(path.dirname(entry), src);
        if (!(await exists(file))) continue;
        const source = await fs.readFile(file, 'utf8');
        const isModule = (attributeValue(block.attrs, 'type') || '').toLowerCase() === 'module' || file.endsWith('.mjs');
        checkSyntax(rep, rel(root, file), source, { module: isModule });
        for (const spec of collectJsImports(source)) {
          if (!(await exists(path.resolve(path.dirname(file), spec)))) {
            rep.error(rel(root, file), `module import not found "${spec}"`);
          }
        }
      }
      for (const m of html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["']/gi)) {
        const cssFile = path.resolve(path.dirname(entry), m[1]);
        if (!(await exists(cssFile))) continue;
        const css = await fs.readFile(cssFile, 'utf8');
        const open = (css.match(/{/g) ?? []).length;
        const close = (css.match(/}/g) ?? []).length;
        if (open !== close) rep.error(rel(root, cssFile), `unbalanced CSS braces (${open} "{" vs ${close} "}"`);
        for (const ref of collectCssRefs(css)) {
          if (!(await exists(path.resolve(path.dirname(cssFile), ref)))) {
            rep.error(rel(root, cssFile), `broken local reference "${ref}"`);
          }
        }
      }
    }
    if (app.manifest && (await exists(path.join(root, app.manifest)))) {
      await auditManifest(root, path.join(root, app.manifest), app, rep);
    }
    if (app.serviceWorker && (await exists(path.join(root, app.serviceWorker)))) {
      await auditServiceWorker(root, path.join(root, app.serviceWorker), app, rep);
    }
  }

  await secretScan(root, rep);

  // Every module under each app's src/ folder must parse and import existing files.
  for (const app of apps) {
    const srcDir = path.join(root, app.root, 'src');
    const files = await walk(srcDir, { filter: (f) => /\.(?:m?js)$/.test(f) });
    for (const file of files) {
      const source = await fs.readFile(file, 'utf8');
      checkSyntax(rep, rel(root, file), source, { module: true });
      for (const spec of collectJsImports(source)) {
        if (!(await exists(path.resolve(path.dirname(file), spec)))) {
          rep.error(rel(root, file), `module import not found "${spec}"`);
        }
      }
      rep.checked += 1;
    }
  }

  // Documentation guardrails.
  for (const doc of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    if (!(await exists(path.join(root, doc)))) rep.warn(doc, 'missing');
  }
  const gitignore = (await exists(path.join(root, '.gitignore'))) ? await fs.readFile(path.join(root, '.gitignore'), 'utf8') : '';
  for (const ignored of ['node_modules', 'dist']) {
    if (!new RegExp(`^${ignored}/?$`, 'm').test(gitignore)) rep.warn('.gitignore', `"${ignored}" is not ignored`);
  }

  return rep;
}

export { extractBlocks, attributeValue, checkSyntax };
