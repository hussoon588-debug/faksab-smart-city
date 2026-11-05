#!/usr/bin/env node
// Zero-dependency static dev server for the repository.
//   npm run dev                          → http://0.0.0.0:8000/
//   PORT=3000 npm run dev
//   SERVE_ROOT=apps/ofuq PORT=8001 npm run dev   (serve one app standalone)
// Binds 0.0.0.0 so it also works behind a container/preview proxy.
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = process.env.SERVE_ROOT ? path.resolve(REPO, process.env.SERVE_ROOT) : REPO;
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.apk': 'application/vnd.android.package-archive',
    '.sql': 'text/plain; charset=utf-8'
  })
);

const REDIRECTS = new Map([['/ofuq', '/apps/ofuq/']]);

const LANDING = `<!DOCTYPE html><html lang="ar" dir="rtl"><meta charset="utf-8">
<title>Not found</title><body style="font:16px/1.7 system-ui;background:#050d1f;color:#eaf1ff;padding:40px">
<h1 style="color:#ffd24a">404</h1>
<p>الملف المطلوب غير موجود.</p>
<ul><li><a style="color:#7ee8ff" href="/">فكسب · SMART CITY</a></li>
<li><a style="color:#7ee8ff" href="/apps/ofuq/">أفق · OFUQ</a></li></ul></body></html>`;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const safePath = path.normalize(decoded).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(ROOT, safePath);
  if (!target.startsWith(ROOT)) return null; // path traversal
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      return (await fs.stat(index)).isFile() ? index : null;
    }
    return stat.isFile() ? target : null;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }
  const urlPath = (req.url || '/').split('?')[0] || '/';
  const redirect = REDIRECTS.get(urlPath.replace(/\/$/, ''));
  if (redirect) {
    res.writeHead(302, { Location: redirect });
    return res.end();
  }

  const file = await resolveFile(urlPath);
  if (!file) return send(res, 404, LANDING);

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': MIME.get(ext) || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  // A service worker registered from a sub-folder may only control that folder
  // unless the server widens its scope; allow it during local development.
  if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  if (ROOT === REPO) {
    console.log(`dev server → http://localhost:${PORT}/            (FAKSAB)`);
    console.log(`dev server → http://localhost:${PORT}/apps/ofuq/   (OFUQ)`);
  } else {
    console.log(`dev server → http://localhost:${PORT}/           (standalone: ${path.relative(REPO, ROOT)})`);
  }
  console.log(`serving ${ROOT}`);
});
