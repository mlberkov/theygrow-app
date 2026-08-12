#!/usr/bin/env node
'use strict';

// Capacitor web-root stager (L1-P1).
//
// Assembles native/www/ — the directory Capacitor copies into the APK — from
// the EXACT `COPY` list in app/Dockerfile. It is a file copy and nothing else:
// no bundler, no transpiler, no minifier, no rewrite of a single byte. The
// production web path stays buildless in both channels (ADR-037), and
// LSC-P1-INV-002 asserts byte-identity so that claim is checkable rather than
// merely stated.
//
// WHY DERIVE THE LIST INSTEAD OF WRITING ONE.
// Pointing Capacitor's `webDir` at app/ would sweep node_modules/, tests/, the
// Dockerfile and the parity baselines into the APK. Hand-maintaining a second
// list in capacitor.config.json would be a second thing to forget on every
// extraction packet — and the failure it hides (the image and the APK
// disagreeing about what is shipped) is silent in both directions. Deriving
// from app/Dockerfile makes the ship list the single source of truth for BOTH
// delivery channels: a file added to one is added to the other, or CI reds.
//
// WHAT IS DELIBERATELY NOT COPIED. shippedPaths() skips every COPY whose
// destination falls outside the nginx web root, which is exactly nginx.conf
// (-> /etc/nginx) and docker-entrypoint.sh (-> /). Both are nginx-channel
// machinery — the same-origin /api proxy, its ID-token minting, its config
// rendering. None of it has any meaning inside a WebView reading local assets,
// and docker-entrypoint.sh in particular must never reach a distributed APK.
// That exclusion is a property of the parser, not a special case here.
//
// Dev/CI only. Nothing in native/tools/ is ever packaged.

const fs = require('fs');
const path = require('path');

const { shippedPaths, expandShippedFiles } = require('../../app/tests/support/ship-list');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_ROOT = path.join(REPO_ROOT, 'app');
const WWW_ROOT = path.join(__dirname, '..', 'www');

// Rebuild from empty every run. An incremental copy would leave a file that
// app/Dockerfile stopped shipping sitting in the APK indefinitely — and
// LSC-P1-INV-002's "no extra file" direction would then fail on a machine that
// had staged before and pass on a fresh clone, which is the worst shape a gate
// can take.
function resetWebDir() {
  fs.rmSync(WWW_ROOT, { recursive: true, force: true });
  fs.mkdirSync(WWW_ROOT, { recursive: true });
}

function stage() {
  const dockerfile = fs.readFileSync(path.join(APP_ROOT, 'Dockerfile'), 'utf8');
  const files = expandShippedFiles(shippedPaths(dockerfile), APP_ROOT);

  if (!files.length) {
    // Fail closed, in the house style: an empty staging directory would let
    // `cap sync` succeed and produce an APK that renders nothing.
    throw new Error('stage-webdir: app/Dockerfile yielded no shipped files — refusing to stage an empty web root');
  }

  resetWebDir();

  for (const urlPath of files) {
    const from = path.join(APP_ROOT, urlPath.replace(/^\//, ''));
    const to = path.join(WWW_ROOT, urlPath.replace(/^\//, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  return files;
}

if (require.main === module) {
  const staged = stage();
  process.stdout.write(`stage-webdir: ${staged.length} files -> ${path.relative(REPO_ROOT, WWW_ROOT)}/\n`);
}

module.exports = { stage, APP_ROOT, WWW_ROOT };
