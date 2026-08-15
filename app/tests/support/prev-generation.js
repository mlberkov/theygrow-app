'use strict';

// The previously published generation of the shell, staged for the upgrade-path
// spec (EMV-P3, EMV-DL-003).
//
// WHY THIS EXISTS. EMV-P1 fixed a dead surface by copy-forward bump: the rule
// landed in /m/v2/, the shell and the worker were repointed, and /m/v1/ stayed
// on disk byte-untouched because a published immutable mount is never rewritten
// (A1-DL-004). Everything about whether that fix REACHES a parent who already
// has the app installed then rests on the update mechanism behaving as argued —
// and EMV-DL-001 said so in its own caveat: no automated test proved it. This
// module is the half of ending that which can be built out of bytes we have.
//
// WHAT IT STAGES, AND HOW FAITHFUL IT IS. Both artifacts are DERIVED from the
// current ones rather than copied into the repo:
//
//   shell  — app/index.html with every `m/v{cur}/` occurrence rewritten to the
//            previous mount. The identity this buys is stated as of the last
//            bump rather than once and for all: EVERY packet that has edited
//            index.html since EMV-P1 has edited it by mount repoint and by
//            nothing else — EMV-P1 itself, then XPT-P1 — so rewriting the
//            current shell back one generation reproduces the shell that
//            generation actually published. (At EMV-P3 that was verified
//            byte-for-byte against 711b5bc, the last commit on main before
//            EMV-P1; the anchor moves forward with each bump, and the claim
//            holds only while "repoint only" stays true.) A later packet
//            editing index.html for any other reason turns this into "the
//            current shell repointed at the previous mount", which is still the
//            right fixture for the mechanism but is no longer the historical
//            bytes. The spec states this bound too.
//   worker — app/sw.js under the same rewrite, with CACHE_VERSION decremented.
//            Behaviourally the worker that generation shipped; byte-different
//            from it by the one comment block EMV-P1 added. Byte-difference is
//            not incidental here, it is the mechanism: an installed client only
//            discovers an update because the fetched /sw.js differs from the one
//            it registered.
//
// WHAT IT IS NOT. It is not the bytes any PARTICULAR live client holds. A live
// client holds whatever generation was current when it last updated, and its
// HTTP-cache state — how much of the 30-day immutable window on the previous
// mount's assets has elapsed — is invisible from here. The only evidence about
// real bytes on a real installed client is the owner step in docs/RUNBOOK.md
// (Promotion + rollback, step 5). This module makes the MECHANISM executable;
// it does not make that step redundant.
//
// Nothing here ships. It lives under app/tests/, which app/Dockerfile does not
// COPY and app/.dockerignore keeps out of the build context, so it can reach
// neither the image nor the staged APK web root (asserted, statically, in
// app/tests/upgrade-path.spec.js).

const fs = require('fs');
const path = require('path');
const { currentMount, previousMount, offlineUrls } = require('./ship-list');

// Context-scoped switch, exactly like SW_BUMP_COOKIE in tests/server.js and for
// the same reason: every Playwright worker shares one server process, so a
// global flag would leak the staged generation into unrelated tests.
const PREV_GEN_COOKIE = 'parity_prev_generation';

// Rewrites the mount version in a source file. Unanchored on purpose — the
// shell names the mount in href/src attributes AND in one prose comment, and a
// comment naming a mount the file does not use is a false statement about the
// file it sits in (the rule EMV-P1 added to the bump checklist).
function rewriteMount(source, from, to, where) {
  const needle = `m/${from.version}/`;
  if (!source.includes(needle)) {
    throw new Error(`prev-generation: ${where} contains no "${needle}" — the mount rewrite would be a no-op`);
  }
  return source.split(needle).join(`m/${to.version}/`);
}

// The cache generation the previous shell shipped with. Derived by decrementing
// the numeric suffix rather than looked up: what the fixture needs is a cache
// name that is OLDER and byte-different, so that activate() has something to
// purge and the update path has something to supersede. That it also equals the
// value the previous generation actually published is a bonus, not a dependency,
// and it has held at every bump so far because each one moved CACHE_VERSION by
// exactly one (v11 at EMV-P3, verified then against 711b5bc; v12 since XPT-P1).
//
// Loud failure, like mutatedServiceWorker(): if sw.js is restructured, this must
// not silently degrade into staging a worker with the CURRENT cache name — that
// worker would never be superseded and the spec would assert nothing.
function priorCacheVersion(workerSource) {
  const re = /const CACHE_VERSION = '(v(\d+))';/;
  const match = re.exec(workerSource);
  if (!match) {
    throw new Error('prev-generation: CACHE_VERSION declaration not found in app/sw.js');
  }
  const current = Number(match[2]);
  if (current < 2) {
    throw new Error(`prev-generation: CACHE_VERSION is '${match[1]}' — there is no prior generation to stage`);
  }
  return { current: match[1], prior: `v${current - 1}` };
}

// Stages the previous generation, or returns null when the current mount is the
// only one shipped — which is what an owner retiring /m/v{N}/ produces, and is
// correctly a vacuous case rather than a failure: with one generation there is
// no previous generation to upgrade FROM. The spec skips with that reason
// printed rather than passing quietly.
function previousGeneration(appRoot) {
  const shellSource = fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8');
  const workerSource = fs.readFileSync(path.join(appRoot, 'sw.js'), 'utf8');

  const current = currentMount(shellSource);
  const previous = previousMount(appRoot, current);
  if (!previous) return null;

  const version = priorCacheVersion(workerSource);

  const shell = rewriteMount(shellSource, current, previous, 'app/index.html');
  const worker = rewriteMount(workerSource, current, previous, 'app/sw.js').replace(
    `const CACHE_VERSION = '${version.current}';`,
    `const CACHE_VERSION = '${version.prior}';`
  );

  // cache.addAll is atomic: one missing path fails the staged install outright,
  // and the browser reports that as an unhandled rejection inside the worker
  // rather than as anything naming this file. The two mounts have identical file
  // sets today; if a future generation adds a module the previous one never had,
  // this throws with the path instead of leaving a mystery.
  for (const url of offlineUrls(worker)) {
    if (!fs.existsSync(path.join(appRoot, url.replace(/^\//, '')))) {
      throw new Error(
        `prev-generation: the staged worker precaches "${url}", which is not on disk — the previous mount does not carry it`
      );
    }
  }

  return {
    mount: previous,
    currentMount: current,
    cacheName: `theygrow-${version.prior}`,
    currentCacheName: `theygrow-${version.current}`,
    shell,
    worker,
  };
}

module.exports = {
  PREV_GEN_COOKIE,
  previousGeneration,
};
