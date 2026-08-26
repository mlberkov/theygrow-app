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
const { currentMount } = require('./support/ship-list');

const NGINX_CONF = path.resolve(__dirname, '..', 'nginx.conf');

// The mount the SHELL references, never the literal 'v1' (EMV-DL-001). The
// live-response assertions below are about the generation the app actually
// boots from: after a copy-forward bump the frozen one is still shipped and
// still answers 200, so a pinned URL would keep this contract green while
// saying nothing about the bytes in use.
const MOUNT = currentMount(
  fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8')
);

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
    // Comments are stripped first (A3-P1). The scan is a text match over the whole
    // file, and `[^{]+?` crosses newlines — so a COMMENT that merely mentions the word
    // "location" is reported as a phantom location spanning everything up to the next
    // real `{`. That is a false RED with a baffling failure message, and A3-P1's proxy
    // comment triggered it. Stripping `#` to end-of-line is a heuristic (it would also
    // strip a `#` inside a quoted value), which is safe here because nginx directives
    // in this file carry none, and wrong in the harmless direction if one ever appears:
    // a stripped directive can only under-report, which the mirrored-rule assertions
    // above would then catch.
    const directives = conf.replace(/#.*$/gm, '');
    const declared = Array.from(directives.matchAll(/location\s+([^{]+?)\s*\{/g)).map((m) => m[1].trim());
    const mirrored = HEADER_RULES.map((r) => r.nginxLocation);
    // /health and the dotfile deny rule are behavioural, not header rules; the
    // server implements both directly and they carry no add_header.
    // `^~ /api/` (A3-P1) is exempt for the same reason and one more: it is a reverse
    // proxy to a live Cloud Run service, which the parity server deliberately does not
    // mirror — there is nothing to proxy to locally. Its own contract is asserted by
    // the config-shape block below instead.
    // `= /privacy/` (PPR-P1) is exempt on the same footing as /health: it carries
    // no add_header at all — it is one `return 301` to the canonical address, so
    // there is no header contract for the mirror to hold. Its behaviour IS
    // asserted, in the live-response block below and in the mirror branch it
    // pairs with; what it has no business being is a HEADER_RULES entry with an
    // empty header set, which would read as "this location sends nothing" rather
    // than "this location is a redirect".
    // PPR-P4 adds the half this exemption did not cover and did not claim to:
    // the FORM of the Location that redirect sends. See the redirect-form block
    // below — static over app/nginx.conf, executed against the mirror.
    // `= /privacy.html` (UIP-P2) joins it on exactly the same footing: one
    // `return 301` to the canonical address, no add_header, behaviour asserted
    // in the live-response block below rather than as an empty header set.
    const exempt = ['/health', '~ /\\.', '^~ /api/', '= /privacy/', '= /privacy.html'];
    const unknown = declared.filter((l) => !mirrored.includes(l) && !exempt.includes(l));
    expect(
      unknown,
      'app/nginx.conf grew a location the parity server does not mirror'
    ).toEqual([]);
  });
});

// A3-P1-INV-001 — same-origin /api proxy, config shape.
//
// This is a config-shape guard and nothing more. It proves what the committed
// nginx config SAYS; it proves nothing about the live token exchange, the IAM
// decision, or that the upstream is reachable — the metadata server does not exist
// off Cloud Run, so those are owner-run smoke assertions (docs/RUNBOOK.md
// "Same-origin /api proxy"). The three properties below are exactly the ones that
// can rot silently in a text file and that no other test would notice.
test.describe('same-origin /api proxy — config shape (A3-P1-INV-001)', () => {
  const API_LOCATION = '^~ /api/';

  test('no location issues a CORS header — the browser reaches /api same-origin', () => {
    const corsHeaders = Array.from(
      conf.matchAll(/add_header\s+(Access-Control-[A-Za-z-]+)/gi)
    ).map((m) => m[1]);
    expect(
      corsHeaders,
      'app/nginx.conf issues a CORS header; the same-origin topology (ADR-007) means none is ever needed'
    ).toEqual([]);
  });

  test('the /api proxy sets Authorization from the container-minted ID token', () => {
    const block = locationBlock(conf, API_LOCATION);
    expect(block, `location "${API_LOCATION}" not found in app/nginx.conf`).not.toBeNull();

    // The literal matters in both halves: a Bearer built from anything other than
    // $api_id_token is not the service-to-service identity, and the absence of this
    // proxy_set_header would silently PASS THROUGH whatever Authorization the client
    // sent — the one failure mode that still returns 200 in a smoke test.
    expect(
      block,
      'the /api proxy must set Authorization from $api_id_token, not forward the client value'
    ).toMatch(/proxy_set_header\s+Authorization\s+"Bearer \$api_id_token"\s*;/);

    // $api_id_token is defined by the entrypoint-written include, never in this file.
    expect(
      block,
      'the /api proxy must include the entrypoint-written token file (it also carries the unconfigured 503)'
    ).toMatch(/include\s+\/etc\/nginx\/conf\.d\/api-id-token\.conf\s*;/);
  });

  test('the /api proxy sends SNI — nginx defaults proxy_ssl_server_name off', () => {
    const block = locationBlock(conf, API_LOCATION);
    expect(block).not.toBeNull();
    expect(
      block,
      'Cloud Run routes by SNI; without proxy_ssl_server_name on, the TLS handshake reaches the wrong service or none'
    ).toMatch(/proxy_ssl_server_name\s+on\s*;/);
  });
});

// ---------------------------------------------------------------------------
// Redirect form — config shape (PPR-P4).
//
// WHAT THIS BLOCK IS FOR. `location = /privacy/` answers `return 301 /privacy;`,
// and until this packet every leg in this suite was green while production sent
//
//     location: http://<the tagged revision's own host>:8080/privacy
//
// measured by the owner smoke against the tagged revision (docs/RUNBOOK.md
// § Promotion + rollback step 3). nginx rewrites ANY Location beginning with `/`
// into scheme://host[:port] + URI: behind Cloud Run the scheme it knows is `http`
// — TLS is terminated in front — and the port is its own `listen 8080`, which is
// not exposed. So the one spelling a visitor is most likely to type by hand
// landed on an address that does not answer, under the word «конфиденциальность».
//
// THE MIRROR WAS NEVER WRONG, which is precisely why nothing reddened:
// tests/server.js has answered that route with a RELATIVE `Location: '/privacy'`
// since PPR-P1. The gap was that no leg compared the two in FORM.
//
// WHAT THIS HALF IS. A parse of the committed app/nginx.conf — it proves what the
// config SAYS. It does not run nginx, does not parse the file the way nginx parses
// it, and observes no response header; nothing in this repository runs the real
// image (AGENTS.md §11). The EXECUTED half is `the redirect names the address, not
// the container` in the live-response block below, against the mirror. The only
// executor of the PRODUCTION behaviour is the owner's curl.
//
// It is a CLASS guard rather than a check on one address: a future route that
// grows a redirect must not be able to repeat this.
// ---------------------------------------------------------------------------

// The `server { … }` body, comments stripped. Fails CLOSED — a restructured file
// throws rather than yielding '', which would make every assertion below hold
// over nothing.
function serverBlock(nginxConf) {
  const directives = nginxConf.replace(/#.*$/gm, '');
  const needle = 'server {';
  const start = directives.indexOf(needle);
  if (start === -1) {
    throw new Error('delivery-contract: no `server {` block found in app/nginx.conf');
  }
  let depth = 0;
  for (let i = start + needle.length - 1; i < directives.length; i += 1) {
    if (directives[i] === '{') depth += 1;
    else if (directives[i] === '}') {
      depth -= 1;
      if (depth === 0) return directives.slice(start + needle.length, i);
    }
  }
  throw new Error('delivery-contract: the `server` block in app/nginx.conf is unbalanced');
}

// The server block with every `location { … }` body removed, so what is left is
// what applies to ALL of them — the present ones and the ones this file has not
// grown yet. Server scope is the whole point of the directive: a copy inside one
// location would leave every other location composing absolute URLs.
function serverScopeDirectives(nginxConf) {
  let depth = 0;
  let out = '';
  for (const ch of serverBlock(nginxConf)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (depth === 0) out += ch;
  }
  return out;
}

function hasServerScopeAbsoluteRedirectOff(nginxConf) {
  return /absolute_redirect\s+off\s*;/.test(serverScopeDirectives(nginxConf));
}

// Anywhere in the file — a location that switches it back on re-arms the defect
// for itself while the server-scope leg stays green.
function absoluteRedirectReEnablings(nginxConf) {
  const directives = nginxConf.replace(/#.*$/gm, '');
  return Array.from(directives.matchAll(/absolute_redirect\s+(on)\s*;/g)).map((m) => m[1]);
}

// Every `return 30x <target>;` in the file, as its raw target string.
function redirectTargets(nginxConf) {
  const directives = nginxConf.replace(/#.*$/gm, '');
  return Array.from(directives.matchAll(/return\s+30\d\s+([^;]+);/g)).map((m) =>
    m[1].trim().replace(/^"|"$/g, '')
  );
}

// A target is sound when it is origin-relative (which `absolute_redirect off`
// then keeps relative on the wire) or an absolute https URL (deliberate
// cross-origin, untouched by the directive because it does not begin with `/`).
// Every `location <match> { ... return 30x <target>; ... }` in the config, as
// [match, target]. Comments are stripped first, so a commented-out block cannot
// stand in for a shipped one.
function redirectLocations(nginxConf) {
  const directives = nginxConf.replace(/#.*$/gm, '');
  return Array.from(
    directives.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)
  )
    .map(([, match, body]) => [match.trim(), /return\s+30\d\s+([^;]+);/.exec(body)])
    .filter(([, m]) => m)
    .map(([match, m]) => [match, m[1].trim().replace(/^"|"$/g, '')]);
}

function unsoundRedirectTargets(nginxConf) {
  return redirectTargets(nginxConf).filter(
    (target) => !target.startsWith('/') && !target.startsWith('https://')
  );
}

test.describe('redirects stay inside the origin — config shape (PPR-P4)', () => {
  test('the server block turns absolute redirects off, at server scope', () => {
    expect(
      hasServerScopeAbsoluteRedirectOff(conf),
      'app/nginx.conf does not carry `absolute_redirect off;` at server scope — nginx will rewrite every `return 30x /path` into scheme://host:8080/path, which is what production sent for /privacy/ at e68dc2a: `location: http://<the tagged revision host>:8080/privacy`, an address that does not answer'
    ).toBe(true);
  });

  test('nothing switches absolute redirects back on', () => {
    expect(
      absoluteRedirectReEnablings(conf),
      'a location re-enables `absolute_redirect` — it would compose an absolute URL with the container listen port again, for that location only, while the server-scope leg above stays green'
    ).toEqual([]);
  });

  test('every redirect target is relative or an absolute https URL', () => {
    expect(
      unsoundRedirectTargets(conf),
      'a `return 30x` targets something that is neither origin-relative nor an absolute https URL — an http:// target sends a visitor off TLS, and this file is behind a proxy that terminates it'
    ).toEqual([]);
  });

  test('the scan is looking at real redirects, not an empty list', () => {
    // Anti-vacuity: the class leg above holds trivially over zero targets, which
    // is how a parser that quietly stopped matching would present itself.
    expect(redirectTargets(conf).length, 'no `return 30x` parsed out of app/nginx.conf').toBeGreaterThan(0);
    expect(redirectTargets(conf)).toContain('/privacy');
  });

  // UIP-P2 — THE DIRECTION NOTHING READ, AND THE MUTATION THAT FOUND IT.
  // Deleting `location = /privacy.html` from app/nginx.conf left this whole
  // file green: tests/server.js mirrors the redirect, every live leg runs
  // against the mirror, and the drift guard above only asks whether nginx grew
  // a location the MIRROR lacks — never the reverse. That is the same shape
  // PPR-P4 paid for, one layer over: the mirror is never wrong, so the mirror
  // cannot be the witness for what the shipped config says. This leg is the
  // config-shape half, and it names both redirects rather than the new one, so
  // a future packet cannot delete either in silence.
  test('the non-canonical spellings redirect in the COMMITTED config, not only in the mirror', () => {
    const declared = new Map(redirectLocations(conf));
    for (const location of ['= /privacy/', '= /privacy.html']) {
      expect(
        declared.get(location),
        `app/nginx.conf declares no 30x from \`${location}\` — the mirror in app/tests/server.js would keep every live leg in this file green while production served the document at a second address`
      ).toBe('/privacy');
    }
  });

  test('the redirect-location parser is armed, and proves it on inputs it builds in-run', () => {
    const TWO =
      'http { server { location = /a/ { return 301 /a; } location = /b { add_header X 1; } location = /c { return 302 "/c"; } } }';
    expect(redirectLocations(TWO)).toEqual([
      ['= /a/', '/a'],
      ['= /c', '/c'],
    ]);
    const COMMENTED = 'http { server {\n# location = /a/ { return 301 /a; }\n } }';
    expect(
      redirectLocations(COMMENTED),
      'a commented-out redirect was read as a shipped one'
    ).toEqual([]);
  });

  test('the scan is armed, and proves it on inputs it builds in-run', () => {
    // Self-proving rather than measured by hand: each detector is shown working
    // against a config written here, so no shipped file is mutated and nobody is
    // trusted to put one back.
    const GOOD = 'http { server { listen 8080; absolute_redirect off; location = /a/ { return 301 /a; } } }';
    const MISSING = 'http { server { listen 8080; location = /a/ { return 301 /a; } } }';
    const COMMENTED = 'http { server { listen 8080;\n# absolute_redirect off;\nlocation = /a/ { return 301 /a; } } }';
    const LOCATION_ONLY = 'http { server { listen 8080; location = /a/ { absolute_redirect off; return 301 /a; } } }';
    const RE_ENABLED = 'http { server { listen 8080; absolute_redirect off; location = /b/ { absolute_redirect on; return 301 /b; } } }';
    const INSECURE = 'http { server { listen 8080; absolute_redirect off; location = /c/ { return 301 http://elsewhere/c; } } }';

    expect(hasServerScopeAbsoluteRedirectOff(GOOD)).toBe(true);
    expect(hasServerScopeAbsoluteRedirectOff(MISSING), 'the directive is absent and the scan did not notice').toBe(false);
    expect(hasServerScopeAbsoluteRedirectOff(COMMENTED), 'the directive is only a comment and the scan counted it').toBe(false);
    expect(
      hasServerScopeAbsoluteRedirectOff(LOCATION_ONLY),
      'the directive sits inside one location and the scan read it as server scope — every other location would still compose an absolute URL'
    ).toBe(false);

    expect(absoluteRedirectReEnablings(RE_ENABLED)).toEqual(['on']);
    expect(absoluteRedirectReEnablings(GOOD)).toEqual([]);

    expect(unsoundRedirectTargets(INSECURE)).toEqual(['http://elsewhere/c']);
    expect(unsoundRedirectTargets(GOOD)).toEqual([]);
    expect(unsoundRedirectTargets('http { server { listen 8080; location = /d/ { return 301 https://theygrow.app/d; } } }')).toEqual([]);

    // Fails closed rather than yielding an empty string every membership test
    // would pass against.
    expect(() => serverBlock('http { }')).toThrow(/no `server \{` block/);
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

  // PPR-P1. The two legs above are the try_files contract in both directions;
  // these two are the one address that must escape it. Until this packet
  // /privacy WAS the first leg — an extension-less unknown route, answered 200
  // with the app shell — which is a promise about a family's data with a skills
  // table behind it.
  test('/privacy serves the policy document, not the app shell', async ({ request }) => {
    const res = await request.get('/privacy');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<h1>Политика конфиденциальности TheyGrow</h1>');
    expect(
      body,
      'the shell fallback fired for /privacy — the exact-match location is gone or lost its precedence'
    ).not.toContain('<table id="mainTable">');
  });

  test('/privacy is cached as a document, never as immutable', async ({ request }) => {
    const res = await request.get('/privacy');
    // The shell's class. Never `immutable`: a new redaction of the policy ships
    // at the SAME address — the document is versioned by its own text and its
    // effective date, not by its URL, unlike /kb-v{N}.json or the module mount.
    expect(res.headers()['cache-control']).toBe('public, max-age=3600, must-revalidate');
    expect(res.headers()['cache-control']).not.toContain('immutable');
  });

  test('/privacy/ redirects to the canonical address instead of serving the shell', async ({
    request,
  }) => {
    const res = await request.get('/privacy/', { maxRedirects: 0 });
    expect(res.status()).toBe(301);
    expect(res.headers()['location']).toBe('/privacy');
  });

  // PPR-P4 — the EXECUTED half of the redirect-form guard above, and the reason
  // the two are one property rather than two: the leg immediately above has held
  // since PPR-P1 while production sent an absolute URL carrying the container's
  // listen port, because it asserts what the MIRROR emits and the mirror was
  // never wrong. What this leg adds is that the FORM is the contract — not an
  // accident of how tests/server.js happens to be written — so the static leg
  // over app/nginx.conf and this one are asserting the same sentence at the two
  // layers each can actually reach.
  test('the redirect names the address, not the container (PPR-P4)', async ({ request }) => {
    const res = await request.get('/privacy/', { maxRedirects: 0 });
    const location = res.headers()['location'];

    // Three properties rather than one string comparison, so a red names the
    // class. Production at e68dc2a sent
    // `http://<the tagged revision host>:8080/privacy`: nginx composes
    // an absolute URL from the request Host plus its own listen port unless
    // `absolute_redirect off` is set, and 8080 is not exposed.
    expect(
      location,
      'the redirect Location carries a scheme — it names an origin rather than the address, and the scheme nginx knows behind a TLS-terminating proxy is http'
    ).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    expect(
      location,
      'the redirect Location is not origin-relative — a visitor following it leaves the origin they are already on'
    ).toMatch(/^\//);
    expect(
      location,
      "the redirect Location carries a port — nginx put its own `listen` port into it, and the container's port is not exposed"
    ).not.toMatch(/:\d+/);
  });

  // UIP-P2 — the third spelling. The file ships under its own name, so until
  // this packet `try_files $uri` answered /privacy.html with 200 and the
  // document had TWO addresses, neither of them declared canonical. The three
  // form properties are re-asserted here rather than assumed from the leg
  // above: they are a property of each `return 30x` in the file, and a second
  // redirect added without them is exactly the regression PPR-P4 paid for.
  test('/privacy.html redirects to the canonical address (UIP-P2)', async ({ request }) => {
    const res = await request.get('/privacy.html', { maxRedirects: 0 });
    expect(res.status()).toBe(301);

    const location = res.headers()['location'];
    expect(location).toBe('/privacy');
    expect(location, 'the redirect Location carries a scheme').not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    expect(location, 'the redirect Location is not origin-relative').toMatch(/^\//);
    expect(location, 'the redirect Location carries a port').not.toMatch(/:\d+/);
  });

  test('the canonical address still answers with the document after the redirect (UIP-P2)', async ({
    request,
  }) => {
    // The failure this pairs against: `location = /privacy` answers through
    // `try_files /privacy.html =404`, and if that lookup were re-matched against
    // locations the new redirect would swallow it and /privacy would 301 to
    // itself forever. It is a filesystem lookup and is not, and this leg is what
    // says so from outside rather than from reading nginx documentation.
    const res = await request.get('/privacy', { maxRedirects: 0 });
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<h1>Политика конфиденциальности TheyGrow</h1>');
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
    const res = await request.get(`${MOUNT.prefix}sw-register.js`);
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
  for (const assetPath of [`${MOUNT.prefix}app.css`, `${MOUNT.prefix}sw-register.js`]) {
    test(`${assetPath} is served immutable by the generic static rule`, async ({ request }) => {
      const res = await request.get(assetPath);
      expect(res.status()).toBe(200);
      expect(res.headers()['cache-control']).toBe('public, immutable, max-age=2592000');
    });
  }

  test(`${MOUNT.prefix}app.css carries the stylesheet content type`, async ({ request }) => {
    const res = await request.get(`${MOUNT.prefix}app.css`);
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
// Four directions are asserted, and each later one closes a hole the earlier
// ones leave open:
//   1. everything the shell references is shipped by the image AND exists;
//   2. everything the shell references is also precached by name;
//   3. everything the shell EXECUTES imports, transitively, satisfies both;
//   4. the modulepreload hint set equals that transitive import graph, exactly.
// (2) exists because a mount bump is copy-forward: both /m/v1/ and /m/v2/ stay
// shipped, so (1) alone would stay green while index.html points at v2 and
// OFFLINE_URLS still lists v1 — installed clients precaching the wrong asset,
// silently, for as long as the install lives.
// (3) exists because A1-P4 moved the graph behind `import` statements that no
// HTML attribute mentions. Without the walk, a module missing from the COPY list
// or from OFFLINE_URLS passes (1) and (2) untouched and then 404s in production
// or on the first offline boot.
//
// (4), and the reason (3) is rooted where it is, are A1-P6. The delivery hints
// added there are href= attributes, so htmlAssetRefs() sees them: left alone,
// every hinted module would be promoted into SHELL_REFS, and since
// moduleDependencies() deletes its own entry URLs from the result, a fully
// hinted graph would leave MODULE_DEPS EMPTY — direction (3) would quietly
// degenerate to zero test cases while CI stayed green (A1-DL-006 (g),
// A1-DL-007 (d)). So the walk is rooted at what the shell EXECUTES — its
// <script type="module"> entries — and not at every .js the shell happens to
// name. Hints stay inside SHELL_REFS, because a hint pointing at an unshipped
// path is a real defect that (1) and (2) should catch; they are simply not
// evaluation roots. (4) then keeps the hint list honest in both directions: a
// stale hint is dead weight after a mount bump, and an unhinted module is the
// silent one — a future extraction that adds a module and forgets its hint
// would otherwise cost a round trip nothing in this repo would ever notice.
// ---------------------------------------------------------------------------

// The parsers below moved into tests/support/ship-list.js in L1-P1, verbatim,
// because the Capacitor stager (native/tools/stage-webdir.js) assembles the
// APK's web root from this SAME COPY list — two channels, one parser, so they
// cannot disagree about what is shipped. Nothing about the assertions changed.
const {
  shippedPaths,
  offlineUrls,
  htmlAssetRefs,
  htmlModuleEntries,
  htmlPreloadHints,
  moduleDependencies,
} = require('./support/ship-list');

// HTML files the image ships and the shell boots from. Parameterised rather
// than hardcoded: offline.html still carries inline <style>/<script> that a
// later A1 packet will extract, and the guard must already be watching it.
// DIA-P1 added transfer.html as a third shell with its own module entry and its
// own hints, which is why every direction below unions across shells rather than
// checking one. PPR-P2 retires that page; the union stays, because the reason
// for it is structural and a second entry shell can arrive again.
const SHIPPED_HTML = ['index.html', 'offline.html'];

const APP_ROOT = path.resolve(__dirname, '..');
const SHIP = shippedPaths(fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8'));
const PRECACHED = offlineUrls(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));
const HTML_SOURCES = SHIPPED_HTML.map((file) => ({
  where: `app/${file}`,
  source: fs.readFileSync(path.join(APP_ROOT, file), 'utf8'),
}));

const SHELL_REFS = Array.from(
  new Set([
    ...HTML_SOURCES.flatMap(({ source }) => htmlAssetRefs(source)),
    // manifest.json icon sources: a 404 here breaks the install prompt silently.
    ...JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'manifest.json'), 'utf8'))
      .icons.map((icon) => icon.src)
      .filter((src) => src.startsWith('/')),
  ])
);

const EXEC_ENTRIES = Array.from(
  new Set(HTML_SOURCES.flatMap(({ where, source }) => htmlModuleEntries(source, where)))
);
const PRELOAD_HINTS = Array.from(
  new Set(HTML_SOURCES.flatMap(({ where, source }) => htmlPreloadHints(source, where)))
);

// Every same-origin .js the shell names must be one or the other. A third kind
// would be a delivery surface with no direction covering it — exactly the shape
// of hole this guard exists to close, so it throws instead of being ignored.
{
  const classified = new Set([...EXEC_ENTRIES, ...PRELOAD_HINTS]);
  const unclassified = SHELL_REFS.filter((ref) => ref.endsWith('.js') && !classified.has(ref));
  if (unclassified.length) {
    throw new Error(
      `ship-list: shell references JavaScript that is neither a module entry nor a modulepreload hint: ${unclassified.join(', ')}`
    );
  }
}

// Rooted at EXEC_ENTRIES, NOT at every .js in SHELL_REFS: since A1-P6 the shell
// also names each non-entry module in a modulepreload hint, and rooting the walk
// there would make moduleDependencies() delete the whole graph as "entries".
const MODULE_DEPS = moduleDependencies(EXEC_ENTRIES, APP_ROOT);

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

  for (const dep of MODULE_DEPS) {
    test(`module dependency "${dep}" is shipped by the image`, () => {
      expect(
        isShipped(dep),
        `"${dep}" is imported by a shipped module but app/Dockerfile does not COPY it (or it is missing on disk) — the module graph would fail to load in production while this suite stays green`
      ).toBe(true);
    });

    test(`module dependency "${dep}" is precached by name`, () => {
      expect(
        PRECACHED.has(dep),
        `"${dep}" is imported by a shipped module but is absent from OFFLINE_URLS in app/sw.js — installed clients would boot offline with a broken import graph`
      ).toBe(true);
    });
  }

  // Direction (4): the delivery hints and the walked graph are the same set.
  // Not a subset check in either direction alone — a stale hint is dead weight
  // after a mount bump or a module removal, and an unhinted module silently
  // costs the round trip A1-P6 exists to remove.
  const HINTED = new Set(PRELOAD_HINTS);
  const WALKED = new Set(MODULE_DEPS);

  for (const hint of PRELOAD_HINTS) {
    test(`modulepreload hint "${hint}" names a module in the walked graph`, () => {
      expect(
        WALKED.has(hint),
        `"${hint}" is preloaded by the shell but is not reached by walking the imports of ${EXEC_ENTRIES.join(', ')} — a hint the graph no longer contains is a fetch nothing evaluates`
      ).toBe(true);
    });
  }

  for (const dep of MODULE_DEPS) {
    test(`module dependency "${dep}" is preloaded by the shell`, () => {
      expect(
        HINTED.has(dep),
        `"${dep}" is in the shell's import graph but carries no <link rel="modulepreload"> in app/index.html — it would be discovered only after its importer parses, costing the round trip A1-P6 removed (A1-P6-INV-001)`
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

// ---------------------------------------------------------------------------
// NON_SHELL_PAGES drift guard (PPR-P1).
//
// app/sw.js serves navigations network-first and mirrors the response into the
// cache keyed '/', which is the app shell's offline copy — UNLESS the pathname
// is named in NON_SHELL_PAGES. That list is the whole thing standing between a
// second navigable page and a permanently poisoned shell for every client that
// ever opens it (DIA-DL-005 (m), which repaired exactly this once already).
//
// Until this packet the list's own comment claimed THIS FILE asserted its
// correspondence with app/Dockerfile's COPY list. It did not — nothing did —
// and the page PPR-P1 adds is precisely the omission that sentence was written
// to prevent. So the guard is written rather than the claim deleted, and it
// understands both kinds of entry a navigable page can have:
//   * a shipped .html reachable under its own name (/offline.html,
//     /privacy.html);
//   * an extension-less route that an exact-match nginx location resolves to a
//     shipped .html with try_files (/privacy -> /privacy.html).
// Both directions are asserted. An unlisted page is the poisoning defect; a
// listed page the image does not serve is a stale entry protecting nothing,
// which after a page is retired is the quiet half of the same drift — and
// PPR-P2 is where that half was collected, /transfer.html having been retired
// one packet after this guard was written to notice it.
// ---------------------------------------------------------------------------

// Read textually, like offlineUrls() and for the same reason: app/sw.js
// registers listeners at load and cannot be require()d. Fails CLOSED — a
// restructured declaration throws rather than yielding an empty set, which
// would make every assertion below hold for nothing.
function nonShellPages(swSource) {
  const m = /const NON_SHELL_PAGES = \[([^\]]*)\];/.exec(swSource);
  if (!m) {
    throw new Error('delivery-contract: NON_SHELL_PAGES declaration not found in app/sw.js');
  }
  return new Set(Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]));
}

// Exact-match locations that serve a file under a different name:
// `location = /privacy { try_files /privacy.html =404; }` yields
// '/privacy' -> '/privacy.html'. Comments are stripped first, for the reason
// the unknown-location scan above records.
function exactFileRoutes(nginxConf) {
  const directives = nginxConf.replace(/#.*$/gm, '');
  const out = new Map();
  for (const m of directives.matchAll(/location\s*=\s*(\S+)\s*\{([^}]*)\}/g)) {
    const target = /try_files\s+(\S+)\s+=404\s*;/.exec(m[2]);
    if (target) out.set(m[1], target[1]);
  }
  return out;
}

test.describe('NON_SHELL_PAGES covers every navigable page this image ships', () => {
  const NON_SHELL = nonShellPages(fs.readFileSync(path.join(APP_ROOT, 'sw.js'), 'utf8'));
  const ROUTES = exactFileRoutes(conf);
  const SHIPPED_PAGES = Array.from(SHIP.files).filter(
    (file) => file.endsWith('.html') && file !== '/index.html'
  );

  test('the guard is reading real lists, not empty ones', () => {
    // Anti-vacuity. Every assertion below is a membership test, and all of them
    // pass trivially against empty inputs — which is how a parser that quietly
    // stopped matching would present itself.
    expect(NON_SHELL.size, 'NON_SHELL_PAGES parsed empty').toBeGreaterThan(0);
    expect(SHIPPED_PAGES.length, 'the image ships no page besides the shell').toBeGreaterThan(0);
    expect(SHIPPED_PAGES).toContain('/offline.html');
    expect(ROUTES.size, 'no exact-match file route parsed out of app/nginx.conf').toBeGreaterThan(0);
  });

  for (const page of SHIPPED_PAGES) {
    test(`shipped page "${page}" is named in NON_SHELL_PAGES`, () => {
      expect(
        NON_SHELL.has(page),
        `app/Dockerfile ships "${page}" but app/sw.js does not list it in NON_SHELL_PAGES — one navigation there would overwrite the app shell's offline copy, permanently, for every client that opens it`
      ).toBe(true);
    });
  }

  for (const [route, target] of ROUTES) {
    if (!SHIPPED_PAGES.includes(target)) continue;
    test(`route "${route}" (served by "${target}") is named in NON_SHELL_PAGES`, () => {
      expect(
        NON_SHELL.has(route),
        `app/nginx.conf serves "${target}" at "${route}", but app/sw.js lists only the file name — the fetch handler compares url.pathname, so a visitor arriving at "${route}" would still poison the shell`
      ).toBe(true);
    });
  }

  for (const entry of NON_SHELL) {
    test(`NON_SHELL_PAGES entry "${entry}" is a page this image actually serves`, () => {
      const asFile = SHIPPED_PAGES.includes(entry);
      const asRoute = ROUTES.has(entry) && SHIPPED_PAGES.includes(ROUTES.get(entry));
      expect(
        asFile || asRoute,
        `app/sw.js lists "${entry}" as a non-shell page, but app/Dockerfile ships no such .html and app/nginx.conf declares no exact-match route resolving to one — the entry protects nothing`
      ).toBe(true);
    });
  }
});
