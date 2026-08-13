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
//
// SECOND SWITCH since EMV-P3. The same same-origin argument applies once more,
// in the other direction: to prove that a client ALREADY INSTALLED on the
// previous generation ends up on the current mount, that generation has to be
// installable from this origin. So a second cookie serves the previously
// published shell and worker (tests/support/prev-generation.js), staged from the
// bytes on disk rather than committed as a copy. Both switches are cookie-keyed
// and mutually exclusive; setting both is a 500.

// TWO PROFILES since L1-P1. The server above describes the nginx channel; the
// Capacitor channel is a different delivery surface serving the same bytes, and
// the parity suite has to be able to boot the app under BOTH or "the Android
// build behaves identically" is an untested claim.
//
//   profile 'nginx'     — everything documented above: HEADER_RULES, the
//                         try_files fallback, the /sw.js bump cookie. Serves
//                         app/ on disk.
//   profile 'capacitor' — what a Capacitor WebView actually provides: local
//                         assets, no cache/Service-Worker headers, and NO SPA
//                         fallback. Serves the staged native/www/.
//
// The absent fallback is the point rather than an omission. Capacitor's local
// asset handler is not nginx, and a shell that had come to depend on
// `try_files $uri $uri/ /index.html` would boot in the browser and fail in the
// APK. Under this profile that dependency is a red test instead of a
// device-only surprise.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { PREV_GEN_COOKIE, previousGeneration } = require('./support/prev-generation');

const APP_ROOT = path.resolve(__dirname, '..');

const PROFILE = process.env.PARITY_PROFILE === 'capacitor' ? 'capacitor' : 'nginx';
const SERVE_ROOT = process.env.PARITY_WEB_ROOT
  ? path.resolve(process.env.PARITY_WEB_ROOT)
  : APP_ROOT;

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
  // The base image's mime.types maps js -> application/javascript (verified
  // against the built container, nginx 1.31.3), NOT text/javascript. Both are
  // JavaScript MIME essences and either loads a module, but the mirror must
  // claim what production actually sends.
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
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
// never written to; the shipped CACHE_VERSION is unaffected by this mutation.
const SW_TEST_VERSION = 'v9-parity-next';

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

function hasCookie(req, name) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `${name}=1`);
}

function wantsBumpedServiceWorker(req) {
  return hasCookie(req, SW_BUMP_COOKIE);
}

// The SECOND context-scoped switch (EMV-P3). Where the bump cookie serves a
// byte-different FUTURE worker to the current shell, this one serves the
// PREVIOUS generation of both — the shell and worker an already-installed
// client is still running — so a spec can install that generation, then take the
// switch away and observe what the current build actually delivers to it. See
// tests/support/prev-generation.js for what is staged and how faithful it is.
function wantsPreviousGeneration(req) {
  return hasCookie(req, PREV_GEN_COOKIE);
}

function createServer({ profile = PROFILE, root = SERVE_ROOT } = {}) {
  const isNginx = profile === 'nginx';

  return http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    // --- nginx: location /health -------------------------------------------
    // Harness-only in both profiles: Playwright's webServer needs a readiness
    // URL. It is not a claim about what Capacitor serves.
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('healthy');
      return;
    }

    // --- nginx: location ~ /\. { deny all; } -------------------------------
    if (pathname.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) {
      res.writeHead(403).end('forbidden');
      return;
    }

    // The Capacitor profile issues none of the nginx cache/MIME policy: those
    // headers are the web channel's contract, and claiming them here would make
    // the native run assert something the APK does not do.
    const { headers } = isNginx ? resolveHeaders(pathname) : { headers: {} };

    // The two switches are mutually exclusive, and this is a 500 rather than a
    // precedence rule on purpose: composed, they would serve a worker that is
    // neither generation — the shape of a test that passes while asserting
    // something nobody designed.
    if (isNginx && wantsPreviousGeneration(req) && wantsBumpedServiceWorker(req)) {
      res
        .writeHead(500, { 'Content-Type': 'text/plain' })
        .end(`both ${PREV_GEN_COOKIE} and ${SW_BUMP_COOKIE} are set; they stage different generations`);
      return;
    }

    let staged = null;
    if (isNginx && wantsPreviousGeneration(req)) {
      try {
        staged = previousGeneration(APP_ROOT);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err.message));
        return;
      }
      if (!staged) {
        // Not a quiet fallthrough to the current build: a spec that asked for
        // the previous generation and silently got this one would assert the
        // upgrade of a client that never existed.
        res
          .writeHead(500, { 'Content-Type': 'text/plain' })
          .end('prev-generation: only one mount generation is shipped — there is nothing to upgrade from');
        return;
      }
    }

    // Derived per request rather than cached in module scope, like the bump
    // path above: the mutation runs that establish this fixture's soundness edit
    // app/index.html while the server is already up (reuseExistingServer), and a
    // memoised copy would keep serving the pre-mutation bytes.
    if (staged && pathname === '/sw.js') {
      res.writeHead(200, Object.assign({ 'Content-Type': MIME['.js'] }, headers));
      res.end(staged.worker);
      return;
    }

    if (isNginx && pathname === '/sw.js' && wantsBumpedServiceWorker(req)) {
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

    // Resolve within the served root; reject traversal.
    const rel = pathname.replace(/^\/+/, '');
    let filePath = path.resolve(root, rel);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) {
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
    // Capacitor has no equivalent, so under that profile an unknown path 404s
    // whether or not it carries an extension. See the profile note at the top.
    if (!stat) {
      if (!isNginx || path.extname(pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      filePath = path.join(root, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const finalHeaders = Object.assign(
      { 'Content-Type': MIME[ext] || 'application/octet-stream' },
      headers
    );

    // Wherever the shell would be served — the root, a directory index, or the
    // try_files fallback — the staged generation serves ITS shell instead. Keyed
    // on the resolved file rather than on the pathname so a service-worker
    // navigation fetch of a deep route gets the same generation the parent is
    // looking at, which is what a real client would have.
    if (staged && filePath === path.join(root, 'index.html')) {
      res.writeHead(200, finalHeaders);
      res.end(req.method === 'HEAD' ? undefined : staged.shell);
      return;
    }

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
    process.stdout.write(
      `parity server (${PROFILE}) listening on http://127.0.0.1:${port} serving ${SERVE_ROOT}\n`
    );
  });
}

module.exports = {
  createServer,
  HEADER_RULES,
  resolveHeaders,
  SW_TEST_VERSION,
  SW_BUMP_COOKIE,
  PREV_GEN_COOKIE,
  APP_ROOT,
  PROFILE,
  SERVE_ROOT,
};
