'use strict';

// Dev/CI-only static server for the parity suite (A1-P1).
//
// WHY THIS EXISTS INSTEAD OF THE REAL NGINX IMAGE
// -----------------------------------------------
// The PWA update-flow test needs a byte-different /sw.js on the SAME origin,
// while app/sw.js and its CACHE_VERSION stay untouched on disk. An immutable
// nginx container cannot do that, and serving the variant from a second origin
// would register a different service worker, making the test meaningless.
//
// The cost of that choice is drift risk against app/nginx.conf. That risk is
// paid down by tests/delivery-contract.spec.js, which parses app/nginx.conf and
// fails when the rules mirrored below diverge from it. Read HEADER_RULES as a
// claim about production that a test is obliged to keep honest.
//
// Nothing here ships: app/Dockerfile COPYs an explicit file list that does not
// include tests/, and app/.dockerignore keeps this out of the build context.

const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

// Mirrors app/nginx.conf. Each entry names the nginx location it reflects so the
// drift guard can pair them up. `test` runs against the URL pathname.
const HEADER_RULES = [
  {
    id: 'sw',
    nginxLocation: '= /sw.js',
    test: (p) => p === '/sw.js',
    headers: {
      'Cache-Control': 'no-cache, must-revalidate',
      'Service-Worker-Allowed': '/',
    },
  },
  {
    id: 'manifest',
    nginxLocation: '= /manifest.json',
    test: (p) => p === '/manifest.json',
    headers: {
      'Cache-Control': 'public, max-age=3600, must-revalidate',
      'Content-Type': 'application/manifest+json',
    },
  },
  {
    id: 'kb',
    nginxLocation: '~ ^/kb-v[0-9]+\\.json$',
    test: (p) => /^\/kb-v[0-9]+\.json$/.test(p),
    headers: {
      'Cache-Control': 'public, immutable, max-age=31536000',
      Vary: 'Accept-Encoding',
    },
  },
  {
    id: 'static',
    nginxLocation: '~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$',
    test: (p) => /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$/i.test(p),
    headers: {
      'Cache-Control': 'public, immutable, max-age=2592000',
      Vary: 'Accept-Encoding',
    },
  },
  {
    id: 'root',
    nginxLocation: '/',
    test: () => true,
    headers: {
      'Cache-Control': 'public, max-age=3600, must-revalidate',
      Vary: 'Accept-Encoding',
    },
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The first matching rule wins, as in nginx: exact (=) and regex (~) locations
// are ordered ahead of the prefix location.
function resolveHeaders(pathname) {
  const rule = HEADER_RULES.find((r) => r.test(pathname));
  return { rule, headers: Object.assign({}, rule.headers) };
}

// Serves a CACHE_VERSION-mutated copy of app/sw.js so the browser sees a
// byte-different worker and runs the real update path. app/sw.js on disk is
// never written to; CACHE_VERSION stays v8 in the shipped file.
const SW_TEST_VERSION = 'v8-parity-next';

function mutatedServiceWorker() {
  const source = fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8');
  const re = /const CACHE_VERSION = '([^']+)';/;
  if (!re.test(source)) {
    // Loud failure: if sw.js is restructured, the update-flow test must not
    // silently degrade into serving an identical worker and passing anyway.
    throw new Error('sw-bump: CACHE_VERSION declaration not found in app/sw.js');
  }
  return source.replace(re, `const CACHE_VERSION = '${SW_TEST_VERSION}';`);
}

// The bump is keyed by a cookie rather than by server state on purpose: every
// Playwright worker shares this one server process, so a global flag would leak
// the mutated worker into unrelated tests. A cookie scopes it to the one browser
// context that asked for it.
const SW_BUMP_COOKIE = 'parity_sw_bump';

function wantsBumpedServiceWorker(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `${SW_BUMP_COOKIE}=1`);
}

function createServer() {
  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // --- nginx: location /health -------------------------------------------
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('healthy');
      return;
    }

    // --- nginx: location ~ /\. { deny all; } -------------------------------
    if (pathname.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    const { headers } = resolveHeaders(pathname);

    if (pathname === '/sw.js' && wantsBumpedServiceWorker(req)) {
      let body;
      try {
        body = mutatedServiceWorker();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err.message));
        return;
      }
      res.writeHead(200, Object.assign({ 'Content-Type': MIME['.js'] }, headers));
      res.end(body);
      return;
    }

    // Resolve within APP_ROOT; reject traversal.
    const rel = pathname.replace(/^\/+/, '');
    let filePath = path.resolve(APP_ROOT, rel);
    if (filePath !== APP_ROOT && !filePath.startsWith(APP_ROOT + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        stat = fs.statSync(filePath);
      } catch {
        stat = null;
      }
    }

    // --- nginx: try_files $uri $uri/ /index.html ---------------------------
    if (!stat) {
      filePath = path.join(APP_ROOT, 'index.html');
      // A missing asset must 404 rather than fall back to the shell, otherwise
      // the kb-load error path could never be observed.
      if (path.extname(pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const finalHeaders = Object.assign(
      { 'Content-Type': MIME[ext] || 'application/octet-stream' },
      headers
    );

    let body;
    try {
      body = fs.readFileSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    res.writeHead(200, finalHeaders);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(`parity server listening on http://127.0.0.1:${port}\n`);
  });
}

module.exports = {
  createServer,
  HEADER_RULES,
  resolveHeaders,
  SW_TEST_VERSION,
  SW_BUMP_COOKIE,
  APP_ROOT,
};
