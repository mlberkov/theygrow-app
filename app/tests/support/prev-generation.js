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
//            previous mount, and — since DIA-P1 — with any delivery hint the
//            previous mount does not carry pruned out.
//
//            THE HISTORICAL-BYTES CLAIM IS OVER, AND THIS IS WHERE IT ENDED.
//            Until DIA-P1 this paragraph said that every packet editing
//            index.html since EMV-P1 had edited it by mount repoint and by
//            nothing else — EMV-P1 itself, then XPT-P1 — so rewriting the
//            current shell back one generation reproduced the shell that
//            generation actually published (verified byte-for-byte at EMV-P3
//            against 711b5bc). It also said, in as many words, that a later
//            packet editing index.html for any other reason turns this into
//            "the current shell repointed at the previous mount". DIA-P1 is
//            that packet: it added four delivery hints and the handoff controls
//            in #importModal. So the fixture is now the WEAKER of the two
//            things, deliberately and on the record — still the right fixture
//            for the MECHANISM, no longer the historical bytes, and the spec
//            states that bound too.
//   worker — app/sw.js under the same rewrite, with CACHE_VERSION decremented
//            and — since DIA-P1 — with any precache entry the previous mount
//            does not carry pruned out (see the block that does it for why that
//            attribution is sound). Behaviourally the worker that generation
//            shipped; byte-different from it by the comment blocks added since.
//            Byte-difference is not incidental here, it is the mechanism: an
//            installed client only discovers an update because the fetched
//            /sw.js differs from the one it registered.
//
//            ONE RESIDUAL UNFAITHFULNESS, NAMED RATHER THAN LEFT TO BE FOUND:
//            the pruning key is "does this path exist on disk", so a non-mount
//            page the current generation added — /transfer.html at DIA-P1 —
//            DOES exist and is therefore still precached by the staged worker,
//            though the previous generation never listed it. It costs the
//            fixture nothing: cache.addAll succeeds, and every property the
//            upgrade-path spec asserts is about getting OFF the previous mount,
//            which this does not touch. Reconstructing the previous list
//            exactly would mean re-deriving it from the staged shell, i.e.
//            reimplementing the worker instead of rewriting it.
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

  const rewrittenShell = rewriteMount(shellSource, current, previous, 'app/index.html');
  const worker = rewriteMount(workerSource, current, previous, 'app/sw.js').replace(
    `const CACHE_VERSION = '${version.current}';`,
    `const CACHE_VERSION = '${version.prior}';`
  );

  // cache.addAll is atomic: one missing path fails the staged install outright,
  // and the browser reports that as an unhandled rejection inside the worker
  // rather than as anything naming this file.
  //
  // DIA-P1 — THIS USED TO THROW, AND THE THROW WAS RIGHT UNTIL A GENERATION ADDED
  // A MODULE. The sentence that stood here said "the two mounts have identical
  // file sets today; if a future generation adds a module the previous one never
  // had, this throws with the path instead of leaving a mystery." That is exactly
  // what happened: DIA-P1 added the handoff page and its three modules, and the
  // rewrite produced a previous-generation worker precaching /m/v{prev}/transfer/…
  // — paths that generation never carried and never listed. It threw with the
  // path, as designed, and the mystery was avoided.
  //
  // The right repair is to make the fixture FAITHFUL rather than to relax it: the
  // previous generation's worker did not precache what the previous generation
  // did not ship, so an entry that does not resolve after the rewrite is dropped.
  // That attribution is sound rather than convenient, and only because it is
  // established elsewhere: app/tests/delivery-contract.spec.js already asserts
  // that EVERY entry of the CURRENT OFFLINE_URLS is shipped by app/Dockerfile and
  // exists on disk. So by the time this runs, an entry that is missing after the
  // rewrite cannot be a typo — the only thing it can be is a path the current
  // generation introduced. What is dropped is returned rather than swallowed, so
  // the spec can print it and a reader can see the fixture is smaller than the
  // current worker and why.
  // The SHELL has the same problem the precache does, and it shows up
  // differently: a modulepreload hint pointing at a module the previous
  // generation never carried does not fail an install — it 404s, four times, in
  // a page the spec is watching for console errors. Same attribution as below
  // (the delivery guard already proves every CURRENT hint resolves), same
  // remedy: the previous generation did not hint what it did not ship.
  const droppedHints = [];
  const shell = rewrittenShell.replace(
    /^[ \t]*<link rel="modulepreload" href="([^"]+)">\n/gm,
    (line, href) => {
      if (fs.existsSync(path.join(appRoot, href.replace(/^\//, '')))) return line;
      droppedHints.push(href);
      return '';
    }
  );

  const added = [];
  const precache = [];
  for (const url of offlineUrls(worker)) {
    if (fs.existsSync(path.join(appRoot, url.replace(/^\//, '')))) {
      precache.push(url);
      continue;
    }
    added.push(url);
  }
  const staged = added.length
    ? worker.replace(
        /const OFFLINE_URLS = \[[\s\S]*?\n\];/,
        `const OFFLINE_URLS = [\n${precache.map((url) => `  '${url}',`).join('\n')}\n];`
      )
    : worker;

  // The rewrite missing an entry is a different failure from the one above and
  // must not hide inside it: a current-mount path surviving into the staged
  // worker would install the CURRENT generation while the fixture claimed to be
  // installing the previous one, and every assertion built on it would be about
  // the wrong bytes.
  // offlineUrls() returns a Set — the delivery guard consumes it with .has().
  const survived = Array.from(offlineUrls(staged)).filter((url) =>
    url.includes(`m/${current.version}/`)
  );
  if (survived.length) {
    throw new Error(
      `prev-generation: the mount rewrite left ${survived.join(', ')} at the CURRENT generation — the staged worker is not the previous one`
    );
  }
  // Anti-vacuity: a repair that dropped everything would stage a worker that
  // precaches nothing, install cleanly, and make the upgrade path assert nothing.
  if (!offlineUrls(staged).has(`/m/${previous.version}/app.css`)) {
    throw new Error(
      'prev-generation: the staged precache no longer carries the previous mount stylesheet — the fixture would prove nothing'
    );
  }

  return {
    mount: previous,
    currentMount: current,
    cacheName: `theygrow-${version.prior}`,
    currentCacheName: `theygrow-${version.current}`,
    shell,
    worker: staged,
    // What the current generation added and the previous one therefore never
    // precached or hinted. Returned rather than swallowed — see the blocks above.
    addedSincePrevious: added,
    droppedHints,
  };
}

module.exports = {
  PREV_GEN_COOKIE,
  previousGeneration,
};
