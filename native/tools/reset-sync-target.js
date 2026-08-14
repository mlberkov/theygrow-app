#!/usr/bin/env node
'use strict';

// Capacitor sync-target reset (EMV-P5, closing LSC-DL-005 side-find (2)).
//
// Empties native/android/app/src/main/assets/public/ — the directory `cap sync`
// copies the staged web root into — so that the copy cannot land ALONGSIDE a
// previous generation's files instead of replacing them. `cap sync` writes over
// that directory rather than clearing it, and the directory is gitignored, so a
// file the ship list stopped shipping survives there indefinitely on any machine
// that has synced before, and is absent on a fresh clone. That is the worst
// shape a build input can take: right in CI, wrong on the developer's box, and
// silent in both.
//
// WHAT THIS DOES NOT FIX, STATED PLAINLY. This is NOT the cause of the red
// android-instrumented run this packet fixes, and shipping it green proves
// nothing about it. In CI the directory is gitignored and therefore absent from
// a fresh checkout, so `cap sync` already writes into an empty target there and
// no stale file was ever possible; run 31750267059's own logcat shows every
// requested URL served with no 404. The cause was a mount address written down
// in an instrumented test (EMV-DL-005). This step closes a recorded side-find
// that named exactly this fix, on the LOCAL hop where it is real.
//
// WHY IT IS NOT PART OF stage-webdir.js, which already rebuilds native/www from
// empty for the same reason. scripts/parity-suite.sh calls that stager DIRECTLY
// and never runs `cap sync` — so folding the reset into it would empty the
// Android project's web root on every parity run and every local dev loop, with
// nothing to refill it. The two hops have different callers, so they get
// different tools. `npm run sync` runs both, in order.
//
// Dev/CI only. Nothing in native/tools/ is ever packaged.

const fs = require('fs');
const path = require('path');

const SYNC_TARGET = path.join(
  __dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'public'
);

function resetSyncTarget() {
  const existed = fs.existsSync(SYNC_TARGET);
  fs.rmSync(SYNC_TARGET, { recursive: true, force: true });
  return existed;
}

if (require.main === module) {
  const existed = resetSyncTarget();
  const rel = path.relative(path.join(__dirname, '..', '..'), SYNC_TARGET);
  process.stdout.write(
    `reset-sync-target: ${existed ? 'cleared' : 'nothing to clear at'} ${rel}/\n`
  );
}

module.exports = { resetSyncTarget, SYNC_TARGET };
