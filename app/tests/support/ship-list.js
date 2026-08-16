'use strict';

// Ship-list parsing primitives (L1-P1).
//
// WHY THIS FILE EXISTS. Until L1-P1 every parser below lived inline in
// app/tests/delivery-contract.spec.js, where it had exactly one consumer. The
// Capacitor shell adds a second: native/tools/stage-webdir.js assembles the
// APK's web root from the SAME app/Dockerfile COPY list, because the two
// delivery channels must ship the same bytes or neither guarantee is worth
// anything. A second, independently written parser would be a second thing to
// forget — and the failure it would hide (the APK and the image disagreeing
// about what is shipped) is precisely what LSC-P1-INV-002 exists to catch.
//
// So the functions are moved here VERBATIM and re-exported. The only change is
// mechanical: moduleDependencies() takes its app root as an argument instead of
// closing over a module-scope constant. No parsing rule, no regex and no
// fail-closed throw is altered — the drift guard's behaviour is identical
// before and after the extraction, which the unchanged test count proves.
//
// EVERY PARSER HERE FAILS CLOSED. Any input form a parser does not fully
// understand throws rather than being skipped: a skipped line is a loud false
// negative (recoverable), a mis-parse is a silent false positive (the bug these
// guards exist to prevent).

const fs = require('fs');
const path = require('path');

// Where app/Dockerfile puts the served tree. A COPY whose destination is
// outside this prefix (nginx.conf -> /etc/nginx, docker-entrypoint.sh -> /) is
// not part of the web root and is skipped by shippedPaths() — which is also
// what keeps those two nginx-only files out of the APK.
const WEB_ROOT = '/usr/share/nginx/html';

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
// Verified exhaustive against the real shell — the only value this skips is the
// external gtag script (DIA-P2 removed the Telegram link, and the download
// control it replaced carries no href in the markup at all: the release address
// is set at runtime from the declared knob), and there are no data: URIs,
// relative refs or srcset attributes. Assets referenced from JS string literals
// (fetch('/kb-v1.json')) are out of reach by construction; see A1-P3-INV-001.
function htmlAssetRefs(html) {
  return Array.from(html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/g))
    .map((m) => m[1])
    .filter((v) => v.startsWith('/'));
}

// The mount version the SHELL currently references, as a URL prefix
// ("/m/v2/") and as a directory name ("v2").
//
// WHY THIS EXISTS (EMV-DL-001). A mount bump is copy-forward: `/m/v1/` stays on
// disk byte-untouched while the shell moves to `/m/v2/`. Every guard that named
// the mount as a LITERAL therefore kept asserting against the frozen generation
// after the bump — shipped, present on disk, and no longer the bytes anyone
// runs. That is a guard staying green for the wrong reason, which is the exact
// failure class the export-modal defect belonged to, so the literal is replaced
// by a derivation from the one artifact that decides the answer: the shell.
//
// Derived from the stylesheet <link>, not from any `/m/` reference: the shell
// names exactly one stylesheet, it is the first mount asset the browser
// resolves, and it cannot be a delivery hint. Fails CLOSED like every parser in
// this file — no match, or more than one distinct mount version among the
// shell's own references, throws rather than picking one.
function currentMount(html, where = 'app/index.html') {
  const link = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/i.exec(html);
  if (!link) throw new Error(`${where}: no stylesheet <link> — the mount cannot be derived`);
  const href = /\bhref\s*=\s*["'](\/m\/(v\d+)\/[^"']+)["']/.exec(link[0]);
  if (!href) throw new Error(`${where}: the stylesheet <link> names no /m/v{N}/ asset`);

  const versions = new Set(Array.from(html.matchAll(/\/m\/(v\d+)\//g)).map((m) => m[1]));
  if (versions.size !== 1) {
    throw new Error(
      `${where}: references ${versions.size} mount versions (${[...versions].sort().join(', ')}) — a bump is half-applied, or a hint points at the frozen generation`
    );
  }

  const version = href[2];
  return { version, prefix: `/m/${version}/`, dir: version };
}

// The mount version published BEFORE the one the shell references, read from
// the mount root on disk. Returns the same shape as currentMount(), or null when
// the current generation is the only one shipped.
//
// WHY THIS EXISTS (EMV-DL-003). A copy-forward bump leaves the previous
// generation on disk and shipped, which is what an already-installed client is
// still holding until it updates. The upgrade-path fixture stages that
// generation from these bytes, so it has to be able to name it — generically,
// for the same reason currentMount() replaced 35 mount literals in EMV-P1: a
// fixture pinned to `v1` would keep staging the wrong generation after the next
// bump, and would then be proving the upgrade path of bytes nobody was on.
//
// Fails CLOSED like every parser here: an entry under app/m/ that is not a
// v{N} directory is a mount topology this function does not model, so it throws
// rather than being skipped (a skipped entry could silently make the previous
// generation look absent, which reads as "nothing to upgrade from").
function previousMount(appRoot, current) {
  const mountRoot = path.join(appRoot, 'm');
  const versions = [];
  for (const entry of fs.readdirSync(mountRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      throw new Error(`ship-list: app/m/${entry.name} is not a directory — mount topology not understood`);
    }
    if (!/^v\d+$/.test(entry.name)) {
      throw new Error(`ship-list: app/m/${entry.name} is not a v{N} mount version — topology not understood`);
    }
    versions.push(Number(entry.name.slice(1)));
  }

  const currentNumber = Number(current.version.slice(1));
  const earlier = versions.filter((n) => n < currentNumber).sort((a, b) => a - b);
  if (!earlier.length) return null;

  const version = `v${earlier[earlier.length - 1]}`;
  return { version, prefix: `/m/${version}/`, dir: version };
}

// The shell's EXECUTION roots: same-origin `<script type="module" src>` values.
// This is what direction (3) walks from — deliberately narrower than "every .js
// the shell names", which since A1-P6 also includes delivery hints.
// Fails CLOSED like every other parser here: a same-origin classic <script src>
// would be an evaluation root this walker does not model, so it throws rather
// than being silently dropped from (3) or silently promoted into it.
function htmlModuleEntries(html, where) {
  const out = [];
  for (const tag of html.matchAll(/<script\b([^>]*)>/gi)) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/.exec(tag[1]);
    if (!src) continue; // inline script — no delivery surface of its own
    if (!src[1].startsWith('/')) continue; // cross-origin (the gtag loader)
    const type = /\btype\s*=\s*["']([^"']+)["']/.exec(tag[1]);
    if (!type || type[1].trim().toLowerCase() !== 'module') {
      throw new Error(
        `${where}: same-origin <script src="${src[1]}"> is not type="module" — the ship-list walker models module entries only`
      );
    }
    out.push(src[1]);
  }
  return out;
}

// The shell's DELIVERY hints: `<link rel="modulepreload" href>` values (A1-P6).
// A hint is not an evaluation root — modulepreload fetches and compiles, it
// never evaluates — so these are kept out of the walk's roots and asserted
// against its result instead, by direction (4).
function htmlPreloadHints(html, where) {
  const out = [];
  for (const tag of html.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = /\brel\s*=\s*["']([^"']+)["']/.exec(tag[1]);
    if (!rel || rel[1].trim().toLowerCase() !== 'modulepreload') continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/.exec(tag[1]);
    if (!href) throw new Error(`${where}: <link rel="modulepreload"> carries no href`);
    if (!href[1].startsWith('/')) {
      throw new Error(
        `${where}: modulepreload href "${href[1]}" is not a same-origin absolute path — the mount is version-in-path and hints must track it`
      );
    }
    out.push(href[1]);
  }
  return out;
}

// Static module specifiers of one shipped module. Fails CLOSED, like the COPY
// parser above: any form this walker does not fully understand throws, because a
// silently skipped import is exactly the invisible file this direction exists to
// catch. `[^;]*?` cannot span a statement boundary, so a multi-line
// `import { … } from '…'` is read whole while an `export { … };` block with no
// `from` cannot borrow the next statement's specifier.
function moduleSpecifiers(source, where) {
  if (/\bimport\s*\(/.test(source)) {
    throw new Error(`${where}: dynamic import() is not understood by the ship-list walker`);
  }
  if (/^[ \t]+(?:import|export)\b[^\n]*\bfrom\b/m.test(source)) {
    throw new Error(`${where}: indented module statement is not understood`);
  }
  return Array.from(source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm)).map(
    (m) => m[1]
  );
}

// Resolve a specifier against its importer's URL. The app is buildless: there is
// no import map and no bundler, so a bare specifier could never resolve at all.
function resolveSpecifier(spec, importerUrl) {
  if (spec.startsWith('/')) return spec;
  if (!spec.startsWith('./') && !spec.startsWith('../')) {
    throw new Error(
      `${importerUrl}: bare module specifier "${spec}" — buildless delivery has no import map`
    );
  }
  return path.posix.normalize(importerUrl.slice(0, importerUrl.lastIndexOf('/') + 1) + spec);
}

// Transitive imports of the shell's EXECUTION entry points, entries themselves
// excluded (they are already covered as shell references). `appRoot` is the
// app/ directory the URLs resolve against — an argument since L1-P1, because
// this walker now has two callers.
function moduleDependencies(entryUrls, appRoot) {
  const seen = new Set();
  const queue = [...entryUrls];
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const onDisk = path.join(appRoot, url.replace(/^\//, ''));
    // A missing entry is reported by the shipped/exists assertions below; the
    // walk must not crash before they run.
    if (!fs.existsSync(onDisk)) continue;
    for (const spec of moduleSpecifiers(fs.readFileSync(onDisk, 'utf8'), url)) {
      queue.push(resolveSpecifier(spec, url));
    }
  }
  entryUrls.forEach((url) => seen.delete(url));
  return Array.from(seen);
}

// Expands the shippedPaths() result into the concrete list of served URL paths
// that exist on disk. Directory COPYs (COPY m/, COPY icons/) ship a prefix
// whatever is in it, so the only way to enumerate them is to walk the tree.
//
// Added in L1-P1 for the native stager, which needs FILES rather than the
// files+prefixes shape the assertions consume. The parity suite's own
// assertions do not call it — they keep using isShipped()'s prefix test, so
// this function cannot weaken an existing guard.
function expandShippedFiles(ship, appRoot) {
  const out = new Set();

  for (const urlPath of ship.files) {
    const onDisk = path.join(appRoot, urlPath.replace(/^\//, ''));
    if (!fs.existsSync(onDisk)) {
      throw new Error(`ship-list: app/Dockerfile COPYs "${urlPath}" but it is missing on disk`);
    }
    out.add(urlPath);
  }

  for (const dir of ship.dirs) {
    const dirOnDisk = path.join(appRoot, dir.replace(/^\//, ''));
    if (!fs.existsSync(dirOnDisk)) {
      throw new Error(`ship-list: app/Dockerfile COPYs "${dir}" but it is missing on disk`);
    }
    const walk = (abs, urlPrefix) => {
      for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : 1
      )) {
        const childAbs = path.join(abs, entry.name);
        const childUrl = `${urlPrefix}${entry.name}`;
        if (entry.isDirectory()) walk(childAbs, `${childUrl}/`);
        else if (entry.isFile()) out.add(childUrl);
        else throw new Error(`ship-list: "${childUrl}" is neither a file nor a directory`);
      }
    };
    walk(dirOnDisk, dir);
  }

  return Array.from(out).sort();
}

module.exports = {
  WEB_ROOT,
  shippedPaths,
  offlineUrls,
  currentMount,
  previousMount,
  htmlAssetRefs,
  htmlModuleEntries,
  htmlPreloadHints,
  moduleSpecifiers,
  resolveSpecifier,
  moduleDependencies,
  expandShippedFiles,
};
