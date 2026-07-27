'use strict';

// Drift guard for the parity suite (A1-P1).
//
// tests/server.js mirrors app/nginx.conf so the suite can serve a mutated
// /sw.js on the same origin (the PWA update flow cannot be tested otherwise).
// A mirror is a claim about production, and claims rot. This spec parses the
// real app/nginx.conf and fails when the mirror diverges from it — turning a
// silent-divergence risk into a red test.
//
// It also asserts the LIVE responses carry those headers, so the mirror is
// checked as configuration AND as behaviour.

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { HEADER_RULES } = require('./server');

const NGINX_CONF = path.resolve(__dirname, '..', 'nginx.conf');

// Extracts the body of `location <loc> { ... }` by brace matching.
function locationBlock(conf, location) {
  const needle = `location ${location} {`;
  const start = conf.indexOf(needle);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start + needle.length - 1; i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1;
    else if (conf[i] === '}') {
      depth -= 1;
      if (depth === 0) return conf.slice(start + needle.length, i);
    }
  }
  return null;
}

// Collects `add_header <name> <value>;` pairs, quoted or bare.
function addHeaders(block) {
  const out = {};
  const re = /add_header\s+([A-Za-z0-9-]+)\s+(?:"([^"]*)"|([^;\s]+))\s*;/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

const conf = fs.readFileSync(NGINX_CONF, 'utf8');

test.describe('delivery contract — tests/server.js mirrors app/nginx.conf', () => {
  for (const rule of HEADER_RULES) {
    test(`nginx location "${rule.nginxLocation}" matches the mirrored rule "${rule.id}"`, () => {
      const block = locationBlock(conf, rule.nginxLocation);
      expect(
        block,
        `location "${rule.nginxLocation}" not found in app/nginx.conf — the mirror in tests/server.js is stale`
      ).not.toBeNull();

      expect(addHeaders(block)).toEqual(rule.headers);
    });
  }

  test('nginx declares no location the mirror is unaware of', () => {
    const declared = Array.from(conf.matchAll(/location\s+([^{]+?)\s*\{/g)).map((m) => m[1].trim());
    const mirrored = HEADER_RULES.map((r) => r.nginxLocation);
    // /health and the dotfile deny rule are behavioural, not header rules; the
    // server implements both directly and they carry no add_header.
    const exempt = ['/health', '~ /\\.'];
    const unknown = declared.filter((l) => !mirrored.includes(l) && !exempt.includes(l));
    expect(
      unknown,
      'app/nginx.conf grew a location the parity server does not mirror'
    ).toEqual([]);
  });
});

test.describe('delivery contract — live responses', () => {
  test('/sw.js is served no-cache with Service-Worker-Allowed', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-cache, must-revalidate');
    expect(res.headers()['service-worker-allowed']).toBe('/');
  });

  test('/kb-v1.json is served immutable', async ({ request }) => {
    const res = await request.get('/kb-v1.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('public, immutable, max-age=31536000');
  });

  test('/manifest.json carries the manifest content type', async ({ request }) => {
    const res = await request.get('/manifest.json');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/manifest+json');
  });

  test('unknown route falls back to the app shell (try_files)', async ({ request }) => {
    const res = await request.get('/some/deep/route');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<table id="mainTable">');
  });

  test('a missing asset 404s instead of falling back to the shell', async ({ request }) => {
    const res = await request.get('/does-not-exist.json');
    expect(res.status()).toBe(404);
  });

  // A JavaScript MIME essence is what makes a module script load at all;
  // anything else blocks it outright. The exact value is decided by the base
  // image's mime.types, which is not in this repo and which no test can parse
  // (nginx:alpine currently maps js -> application/javascript, not the
  // text/javascript this mirror claimed before A1-P3). So the contract asserted
  // here is the spec class, and the exact production value is pinned by the
  // promotion-smoke curl in docs/RUNBOOK.md.
  const JS_MIME_ESSENCES = new Set([
    'text/javascript',
    'application/javascript',
    'application/ecmascript',
    'text/ecmascript',
    'application/x-javascript',
    'application/x-ecmascript',
  ]);
  const essence = (contentType) => String(contentType).split(';')[0].trim().toLowerCase();

  test('ES module MIME is correct (load-bearing for the split)', async ({ request }) => {
    // A1-P3 extracted the first native ES module; a wrong MIME would make it
    // fail to load outright. Asserted against the real module, not a stand-in.
    const res = await request.get('/m/v1/sw-register.js');
    expect(res.status()).toBe(200);
    expect(JS_MIME_ESSENCES.has(essence(res.headers()['content-type']))).toBe(true);
  });

  test('/sw.js carries a JavaScript MIME (load-bearing for registration)', async ({ request }) => {
    const res = await request.get('/sw.js');
    expect(JS_MIME_ESSENCES.has(essence(res.headers()['content-type']))).toBe(true);
  });

  // The mount deliberately carries no nginx location of its own: the generic
  // static rule already yields the semantics version-in-path wants. These
  // assertions pin that, so a later narrowing of the generic rule cannot
  // silently drop the mount out of the immutable contract.
  for (const assetPath of ['/m/v1/app.css', '/m/v1/sw-register.js']) {
    test(`${assetPath} is served immutable by the generic static rule`, async ({ request }) => {
      const res = await request.get(assetPath);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('public, immutable, max-age=2592000');
    });
  }

  test('/m/v1/app.css carries the stylesheet content type', async ({ request }) => {
    const res = await request.get('/m/v1/app.css');
    // toContain, not equality: the mirror sends `; charset=utf-8`, production
    // nginx sends it bare. Equality would encode a mirror-only fact as contract.
    expect(res.headers()['content-type']).toContain('text/css');
  });
});

// ---------------------------------------------------------------------------
// Ship-list drift guard (A1-P3).
//
// tests/server.js serves from the app/ directory ON DISK, so a file that
// app/Dockerfile forgets to COPY passes this entire suite and 404s only in
// production — a green-CI outage. app/Dockerfile has no wildcard COPY, so that
// is a live hazard on every extraction packet, not a hypothetical one.
//
// Two directions are asserted, and the second is the one with teeth:
//   1. everything the shell references is shipped by the image AND exists;
//   2. everything the shell references is also precached by name.
// (2) exists because a mount bump is copy-forward: both /m/v1/ and /m/v2/ stay
// shipped, so (1) alone would stay green while index.html points at v2 and
// OFFLINE_URLS still lists v1 — installed clients precaching the wrong asset,
// silently, for as long as the install lives.
// ---------------------------------------------------------------------------

const WEB_ROOT = '/usr/share/nginx/html';

// HTML files the image ships and the shell boots from. Parameterised rather
// than hardcoded: offline.html still carries inline <style>/<script> that a
// later A1 packet will extract, and the guard must already be watching it.
const SHIPPED_HTML = ['index.html', 'offline.html'];

// Parses app/Dockerfile COPY lines into the set of paths the image serves.
// Fails CLOSED: any COPY form this parser does not fully understand throws.
// A skipped line would yield a loud false "not shipped" (recoverable); a
// mis-parsed destination would yield a silent false "shipped" — precisely the
// bug this guard exists to prevent.
function shippedPaths(dockerfile) {
  const files = new Set();
  const dirs = [];
  const lines = dockerfile.split('\n');

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!/^COPY(\s|$)/i.test(line)) return;
    const where = `app/Dockerfile:${i + 1}`;

    if (line.endsWith('\\')) throw new Error(`${where}: line-continuation COPY is not understood`);
    if (/^COPY\s*\[/i.test(line)) throw new Error(`${where}: JSON-array COPY is not understood`);
    if (/\s--\w/.test(line)) throw new Error(`${where}: flagged COPY (--from/--chown) is not understood`);

    const parts = line.split(/\s+/).slice(1);
    if (parts.length !== 2) throw new Error(`${where}: expected exactly one source and one destination`);
    if (parts.some((p) => /[*?[\]]/.test(p))) throw new Error(`${where}: wildcard COPY is not understood`);

    const [src, dest] = parts;
    if (!dest.startsWith(WEB_ROOT)) return; // e.g. nginx.conf -> /etc/nginx

    const urlPath = dest.slice(WEB_ROOT.length) || '/';

    // The on-disk existence check below assumes the source path and the served
    // path agree. Enforce that assumption rather than trusting it.
    const norm = (p) => p.replace(/^\/+|\/+$/g, '');
    if (norm(src) !== norm(urlPath)) {
      throw new Error(`${where}: source "${src}" and served path "${urlPath}" differ; the guard cannot map it to disk`);
    }

    if (src.endsWith('/')) dirs.push(urlPath.endsWith('/') ? urlPath : `${urlPath}/`);
    else files.add(urlPath);
  });

  return { files, dirs };
}

// OFFLINE_URLS is read textually: app/sw.js calls self.addEventListener at load,
// so it cannot be require()d. Loud failure on no-match, mirroring the
// mutatedServiceWorker() pattern in tests/server.js — a guard that silently
// yields an empty set when sw.js is restructured is worse than no guard.
function offlineUrls(swSource) {
  const m = /const OFFLINE_URLS = \[([\s\S]*?)\];/.exec(swSource);
  if (!m) throw new Error('ship-list: OFFLINE_URLS declaration not found in app/sw.js');
  return new Set(Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]));
}

// Same-origin asset references: every href=/src= value starting with "/".
// Verified exhaustive against the real shell — the only values this skips are
// the external gtag script and the Telegram link, and there are no data: URIs,
// relative refs or srcset attributes. Assets referenced from JS string literals
// (fetch('/kb-v1.json')) are out of reach by construction; see A1-P3-INV-001.
function htmlAssetRefs(html) {
  return Array.from(html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g))
    .map((m) => m[1])
    .filter((v) => v.startsWith('/'));
}

const APP_ROOT = path.resolve(__dirname, '..');
const SHIP = shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8'));
const PRECACHED = offlineUrls(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));

const SHELL_REFS = Array.from(
  new Set([
    ...SHIPPED_HTML.flatMap((f) => htmlAssetRefs(fs.readFileSync(path.join(APP_ROOT, f), 'utf8'))),
    // manifest.json icon sources: a 404 here breaks the install prompt silently.
    ...JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'manifest.json'), 'utf8'))
      .icons.map((icon) => icon.src)
      .filter((src) => src.startsWith('/')),
  ])
);

function isShipped(urlPath) {
  const target = urlPath === '/' ? '/index.html' : urlPath;
  if (!SHIP.files.has(target) && !SHIP.dirs.some((d) => target.startsWith(d))) return false;
  // Prefix-shipped is not file-exists: COPY m/ ships the prefix whatever is in
  // it, so a typo'd path would otherwise pass.
  return fs.existsSync(path.join(APP_ROOT, target.replace(/^\//, '')));
}

test.describe('ship list — app/Dockerfile ships everything the shell needs', () => {
  for (const ref of SHELL_REFS) {
    test(`shell reference "${ref}" is shipped by the image`, () => {
      expect(
        isShipped(ref),
        `"${ref}" is referenced by the shipped shell but app/Dockerfile does not COPY it (or it is missing on disk) — it would 404 in production while this suite stays green`
      ).toBe(true);
    });

    test(`shell reference "${ref}" is precached by name`, () => {
      expect(
        PRECACHED.has(ref),
        `"${ref}" is referenced by the shipped shell but is absent from OFFLINE_URLS in app/sw.js — installed clients would boot offline without it`
      ).toBe(true);
    });
  }

  for (const url of PRECACHED) {
    test(`precached URL "${url}" is shipped by the image`, () => {
      expect(
        isShipped(url),
        `"${url}" is in OFFLINE_URLS but app/Dockerfile does not COPY it (or it is missing on disk) — cache.addAll is atomic, so the service worker would fail to install entirely`
      ).toBe(true);
    });
  }
});
