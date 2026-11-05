#!/usr/bin/env node
// Zero-dependency static dev server for the repository.
//   npm run dev                          → http://0.0.0.0:8000/
//   PORT=3000 npm run dev
//   SERVE_ROOT=apps/ofuq PORT=8001 npm run dev   (serve one app standalone)
// Binds 0.0.0.0 so it also works behind a container/preview proxy.
//
// Diagnostics: every request is logged with its status, and `GET /healthz`
// reports what is being served (used to verify the live preview).
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROOT = process.env.SERVE_ROOT ? path.resolve(REPO, process.env.SERVE_ROOT) : REPO;
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';
const STARTED_AT = Date.now();

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

// Browsers always probe /favicon.ico; answer it instead of logging a 404.
const FAVICON_CANDIDATES = ['icon-192.png', 'apps/ofuq/assets/icon-192.png'];

const NOT_FOUND = `<!DOCTYPE html><html lang="ar" dir="rtl"><meta charset="utf-8">
<title>404</title><body style="font:16px/1.7 system-ui;background:#050d1f;color:#eaf1ff;padding:40px">
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

async function firstExisting(relatives, base) {
  for (const relative of relatives) {
    const candidate = path.join(base, relative);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

async function healthz() {
  const apps = [];
  for (const [id, entry] of [
    ['faksab', 'index.html'],
    ['ofuq', 'apps/ofuq/index.html']
  ]) {
    apps.push({ id, entry, available: Boolean(await firstExisting([entry], ROOT)) });
  }
  return {
    status: 'ok',
    root: path.relative(REPO, ROOT) || '.',
    port: PORT,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    apps
  };
}

const server = createServer(async (req, res) => {
  const startedAt = process.hrtime.bigint();
  const urlPath = (req.url || '/').split('?')[0] || '/';

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `${new Date().toISOString()} ${res.statusCode} ${req.method} ${urlPath} ` +
        `${ms.toFixed(1)}ms${req.headers.host ? ` host=${req.headers.host}` : ''}`
    );
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  }

  if (urlPath === '/healthz') {
    return send(res, 200, JSON.stringify(await healthz(), null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
  }

  const redirect = REDIRECTS.get(urlPath.replace(/\/$/, ''));
  if (redirect) {
    res.writeHead(302, { Location: redirect, 'Cache-Control': 'no-store' });
    return res.end();
  }

  const file = urlPath === '/favicon.ico' ? await firstExisting(FAVICON_CANDIDATES, ROOT) : await resolveFile(urlPath);
  if (!file) return send(res, 404, NOT_FOUND, { 'Cache-Control': 'no-store' });

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

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use — stop the other dev server or set PORT=<free port>`);
  } else {
    console.error('dev server error:', error);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (ROOT === REPO) {
    console.log(`dev server → http://localhost:${PORT}/            (FAKSAB)`);
    console.log(`dev server → http://localhost:${PORT}/apps/ofuq/   (OFUQ)`);
  } else {
    console.log(`dev server → http://localhost:${PORT}/           (standalone: ${path.relative(REPO, ROOT)})`);
  }
  console.log(`serving ${ROOT}`);
  console.log(`health    → http://localhost:${PORT}/healthz`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n${signal} received — closing dev server`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
