#!/usr/bin/env node
'use strict';

// POL-P1 — the promotion step that MEASURES instead of remembering.
//
// WHY THIS FILE EXISTS. On 2026-08-29 the NAV merge deployed a revision at 0%
// traffic — the designed behaviour (vault ADR-020) — and for about an hour the
// live site kept serving the previous build, including policy edition 1.2,
// while the repository, the merge and the APK all said 1.3. Nothing measured
// the gap; it was found by hand. The published document is a public promise
// about a family's data (vault PDR-035, annotation 2026-08-27), and a live
// edition older than the live code is a defect of that promise rather than a
// caching nuance. This script is the check that makes the gap loud: it fetches
// the LIVE document, reads the edition out of it, and compares that with the
// edition this tree ships.
//
// WHAT IT IS NOT. It does not promote, does not run gcloud, and reads no
// credential. It also carries no live-infra identifier: the Cloud Run service
// URL is passed in with --origin, because docs/RUNBOOK.md is the sole carrier
// of those names (M1-P3-INV-002). The public address is not written down here
// either — it is derived from the shipped mount's CHANNEL_CONFIG.policyUrl, so
// the tool cannot go on checking an address the product stopped declaring.
//
// TWO TIERS, NAMED APART, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
//   --origin  the Cloud Run service URL: what the promoted revision itself
//             serves. Bypasses the CDN, so it answers "did the promotion
//             happen?".
//   --edge    the public address a parent actually opens. It answers "does the
//             edge still hold an older copy?" — and Cloudflare sits in front of
//             it and answers a plain client with a challenge, which this tool
//             reports as UNMEASURABLE rather than passing off as agreement.
//
// EXIT CODES ARE THE POINT, so they are three and not two:
//   0  every measured tier serves the edition this tree ships, in a class no
//      cache may store.
//   1  STALE or WRONG — a measured tier serves a different edition or date, or
//      a cache class that permits a stored copy, or the app shell.
//   2  UNMEASURABLE — a network error, a timeout, a non-200, a bot challenge,
//      or a body that is not the policy document. A tier that could not be
//      measured is NEVER counted as a pass; "no answer" and "the right answer"
//      are different facts and this tool refuses to merge them.
//   3  BROKEN — the SHIPPED side could not be read. The tool fails closed: if
//      it cannot say what the image carries, it says nothing about the live
//      document either.
// The process exits with the WORST verdict of the measured tiers.
//
// EVERY PARSER HERE FAILS CLOSED, on the rule app/tests/support/ship-list.js
// states: a skipped input is a loud false negative, a mis-parse is a silent
// false positive, and this tool exists to prevent exactly the silent kind.

const fs = require('fs');
const path = require('path');

// Derived, never pinned: the same helper app/tests/*.spec.js and
// native/tools/stage-webdir.js already use, for the same reason — a literal
// mount version would keep the tool reading a frozen generation's knobs.
const { currentMount } = require('../app/tests/support/ship-list');

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_ROOT = path.join(REPO_ROOT, 'app');

// The one knob this tool has. It is an ops-tool default with no shipped
// counterpart, so its single documented place is here (the maxDiffPixels
// precedent in app/playwright.config.js): raise it HERE, or per run with
// --timeout-ms, never silently per call site. It is deliberately NOT on any of
// the product's typed config surfaces (ADR-013 / contract §4.7) — nothing the
// app runs reads it.
const DEFAULT_TIMEOUT_MS = 10000;

const EXIT = { OK: 0, STALE: 1, UNMEASURABLE: 2, BROKEN: 3 };

// A browser-shaped request, because the edge answers a bare client with a
// challenge. This is not an attempt to defeat one: when the challenge comes
// anyway the tool says so and exits UNMEASURABLE.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

// The marker docs/RUNBOOK.md's own smoke uses for "the catch-all answered and a
// parent is reading the skills table under the word «конфиденциальность»".
const SHELL_MARKER = 'mainTable';

// What a challenge/interstitial looks like. Any ONE of these is enough; the
// verdict it produces is UNMEASURABLE, never a pass and never a mismatch.
const CHALLENGE_MARKERS = [
  'cf-mitigated',
  'challenge-platform',
  '__cf_chl',
  'cf_chl_opt',
  'Just a moment',
  'Enable JavaScript and cookies to continue',
  'Attention Required',
];

// --- parsers -------------------------------------------------------------

// Comments are stripped before matching, for the reason
// app/tests/privacy-page.spec.js:54 gives: the page explains its own contents
// in its head comment, and an explanation must not be read as the thing.
function stripComments(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, '');
}

// The edition block, from the page's .meta paragraph. ONE parser for TWO
// inputs — the file this tree ships and the document the live address answers
// with — because a second, independently written parser would be a second
// thing to forget (the L1-P1 rule that produced app/tests/support/ship-list.js).
// Fails CLOSED on either half: a document whose version or date this cannot
// find is a document this tool must not pronounce upon.
function editionFromHtml(html, where = 'the document') {
  const code = stripComments(html);
  const version = /<strong>Версия:<\/strong>\s*([^\s<]+)/.exec(code);
  if (!version) throw new Error(`${where}: no «Версия» in the edition block`);
  const date = /<strong>Дата вступления в силу:<\/strong>\s*([^\s<]+)/.exec(code);
  if (!date) throw new Error(`${where}: no «Дата вступления в силу» in the edition block`);
  return { version: version[1], date: date[1] };
}

// The Cache-Control app/nginx.conf DECLARES for the canonical policy address.
// Read rather than restated, on the rule app/tests/update-check.spec.js:49
// follows for the shipped knobs: a tool that wrote the class down again would
// agree with itself after the class changed. Fails CLOSED, and that closure is
// load-bearing twice over — it also throws on `add_header … always;`, the form
// the drift guard's parser cannot read either (named as a debt in POL-DL-001).
function declaredCacheControl(conf) {
  const needle = 'location = /privacy {';
  const start = conf.indexOf(needle);
  if (start === -1) throw new Error('app/nginx.conf: no `location = /privacy {` block');
  let depth = 0;
  let block = null;
  for (let i = start + needle.length - 1; i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1;
    else if (conf[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        block = conf.slice(start + needle.length, i);
        break;
      }
    }
  }
  if (block === null) throw new Error('app/nginx.conf: `location = /privacy` block is unterminated');
  const header = /add_header\s+Cache-Control\s+"([^"]*)"\s*;/.exec(block);
  if (!header) throw new Error('app/nginx.conf: `location = /privacy` declares no readable Cache-Control');
  return header[1];
}

// Does this class let ANY cache — browser or shared — keep a copy that could
// outlive the release? Only `no-store` forbids storing; `no-cache` permits a
// stored copy and merely requires revalidating it, and an absent header permits
// heuristic freshness. Fails CLOSED: no header, or one this cannot read, is
// "yes, it may be stored".
function permitsAStoredCopy(cacheControl) {
  if (cacheControl === undefined || cacheControl === null) return true;
  const value = String(cacheControl).trim();
  if (value === '') return true;
  return !value
    .toLowerCase()
    .split(',')
    .map((t) => t.trim())
    .includes('no-store');
}

function looksLikeChallenge(status, headers, body) {
  const haystack = `${JSON.stringify(headers || {})}\n${String(body || '')}`;
  return CHALLENGE_MARKERS.some((m) => haystack.includes(m));
}

// --- what this tree ships ------------------------------------------------

// The image COPYs app/privacy.html (app/Dockerfile) and nothing else carries
// the edition into the container, so this file IS the shipped edition.
function shippedExpectation(appRoot = APP_ROOT) {
  const page = fs.readFileSync(path.join(appRoot, 'privacy.html'), 'utf8');
  const { version, date } = editionFromHtml(page, 'app/privacy.html');
  const cacheControl = declaredCacheControl(fs.readFileSync(path.join(appRoot, 'nginx.conf'), 'utf8'));
  return { version, date, cacheControl };
}

// The public address, from the mount the shell actually boots.
function policyUrlFromMount(appRoot = APP_ROOT) {
  const mount = currentMount(fs.readFileSync(path.join(appRoot, 'index.html'), 'utf8'));
  const configPath = path.join(appRoot, 'm', mount.dir, 'channel', 'config.js');
  const config = fs.readFileSync(configPath, 'utf8');
  const url = /policyUrl:\s*'([^']+)'/.exec(config);
  if (!url) throw new Error(`${configPath}: no policyUrl in CHANNEL_CONFIG`);
  return url[1];
}

// --- the measurement -----------------------------------------------------

async function fetchDocument(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });
    const body = await res.text();
    const headers = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, headers, body };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return { error: timedOut ? `no answer within ${timeoutMs} ms` : String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Turns one response into one verdict. Pure, so the spec can drive every
// branch of it without a network.
//   strict: the origin is OUR nginx, so its header must EQUAL the declared
//           class; the edge may normalise the value, so there the requirement
//           is that `no-store` survived. Both print what they observed.
function judge({ label, url, expected, response, strict }) {
  const say = (verdict, lines) => ({ verdict, label, url, lines });

  if (response.error) return say(EXIT.UNMEASURABLE, [`${label}: ${response.error}`]);

  const { status, headers, body } = response;
  const cacheControl = headers['cache-control'];

  if (status !== 200) {
    const challenged = looksLikeChallenge(status, headers, body);
    return say(EXIT.UNMEASURABLE, [
      challenged
        ? `${label}: answered ${status} with a bot challenge, not the document — this is NOT a pass; open ${url} in a browser and read «Версия»`
        : `${label}: answered ${status}, not 200`,
    ]);
  }

  if (String(body).includes(SHELL_MARKER)) {
    return say(EXIT.STALE, [
      `${label}: the APP SHELL answered the policy address (found «${SHELL_MARKER}») — the exact-match location is gone or lost its precedence`,
    ]);
  }

  let live;
  try {
    live = editionFromHtml(body, label);
  } catch (err) {
    return say(EXIT.UNMEASURABLE, [
      looksLikeChallenge(status, headers, body)
        ? `${label}: answered 200 with a challenge page, not the document — this is NOT a pass`
        : `${label}: ${(err && err.message) || err} — the response is not the policy document`,
    ]);
  }

  const lines = [];
  let verdict = EXIT.OK;

  if (live.version !== expected.version || live.date !== expected.date) {
    verdict = EXIT.STALE;
    lines.push(
      `${label}: LIVE edition ${live.version} (${live.date}) is not the edition this tree ships, ${expected.version} (${expected.date})`
    );
  }

  const stored = permitsAStoredCopy(cacheControl);
  const observed = cacheControl === undefined ? '(no Cache-Control header)' : cacheControl;
  if (stored) {
    verdict = EXIT.STALE;
    lines.push(
      `${label}: cache-control ${observed} permits a stored copy — a copy of this document can outlive the release it shipped with`
    );
  } else if (strict && cacheControl !== expected.cacheControl) {
    verdict = EXIT.STALE;
    lines.push(
      `${label}: cache-control ${observed} is not the class app/nginx.conf declares, ${expected.cacheControl}`
    );
  }

  if (verdict === EXIT.OK) {
    lines.push(`${label}: edition ${live.version} (${live.date}), cache-control ${observed} — agrees with this tree`);
  }
  return say(verdict, lines);
}

async function checkTier({ label, url, expected, strict, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const response = await fetchDocument(url, timeoutMs);
  return judge({ label, url, expected, response, strict });
}

// --- CLI -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--origin') out.origin = argv[++i];
    else if (arg === '--edge') out.edge = argv[++i];
    else if (arg === '--no-edge') out.noEdge = true;
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number of milliseconds');
  }
  return out;
}

const USAGE = `check-live-policy-edition — does the LIVE policy document carry the edition this tree ships?

  node scripts/check-live-policy-edition.js [--origin <url>] [--edge <url>] [--no-edge] [--timeout-ms N]

  --origin      the promoted revision's own URL (no default: live-infra names
                live in docs/RUNBOOK.md). Its Cache-Control must EQUAL the class
                app/nginx.conf declares.
  --edge        the public address (default: CHANNEL_CONFIG.policyUrl of the
                current mount). There the requirement is that no-store survived.
  --no-edge     measure the origin only.
  --timeout-ms  per-request deadline (default ${DEFAULT_TIMEOUT_MS}).

  exit 0 agrees · 1 stale or wrong · 2 unmeasurable (challenge, timeout, non-200)
       · 3 the shipped side could not be read.`;

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n\n${USAGE}\n`);
    return EXIT.BROKEN;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.OK;
  }

  let expected;
  try {
    expected = shippedExpectation();
  } catch (err) {
    process.stderr.write(`FAIL (3): this tree could not be read — ${(err && err.message) || err}\n`);
    return EXIT.BROKEN;
  }

  const targets = [];
  if (args.origin) targets.push({ label: 'origin', url: args.origin, strict: true });
  if (!args.noEdge) {
    let edge = args.edge;
    if (!edge) {
      try {
        edge = policyUrlFromMount();
      } catch (err) {
        process.stderr.write(`FAIL (3): the public address could not be derived — ${(err && err.message) || err}\n`);
        return EXIT.BROKEN;
      }
    }
    targets.push({ label: 'edge', url: edge, strict: false });
  }
  if (targets.length === 0) {
    process.stderr.write('FAIL (3): nothing to measure — --no-edge was given without --origin\n');
    return EXIT.BROKEN;
  }

  process.stdout.write(
    `this tree ships edition ${expected.version} (${expected.date}), class "${expected.cacheControl}"\n`
  );

  let worst = EXIT.OK;
  for (const target of targets) {
    /* eslint-disable no-await-in-loop */
    const result = await checkTier({ ...target, expected, timeoutMs: args.timeoutMs });
    const stream = result.verdict === EXIT.OK ? process.stdout : process.stderr;
    for (const line of result.lines) stream.write(`${line}\n`);
    if (result.verdict > worst) worst = result.verdict;
  }

  if (worst === EXIT.OK) process.stdout.write('OK (0): the live document is the edition this tree ships\n');
  else if (worst === EXIT.STALE) process.stderr.write('FAIL (1): the live document does not match this tree\n');
  else process.stderr.write('FAIL (2): a tier could not be measured — this is not a pass\n');
  return worst;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  EXIT,
  SHELL_MARKER,
  checkTier,
  declaredCacheControl,
  editionFromHtml,
  judge,
  main,
  permitsAStoredCopy,
  policyUrlFromMount,
  shippedExpectation,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`FAIL (3): ${(err && err.stack) || err}\n`);
      process.exitCode = EXIT.BROKEN;
    }
  );
}
