// Delivery-channel knobs (DIA-P2).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob THE CHANNEL
// COMPOSITION introduces lives HERE, once, with changed_in provenance — never as
// a literal in the shell or in surfaces/channel.js. This is a FOURTH
// device-local config surface beside store/config.js ("every qualitative knob
// THE STORE introduces"), export/config.js ("...the export contour...") and
// transfer/config.js ("...the browser-to-native transfer..."), following the
// same precedent chain: CACHE_VERSION in app/sw.js (PWA-DL-001), then
// store/config.js (LSC-DL-002), export/config.js (LSC-DL-003) and
// transfer/config.js (DIA-DL-001). The typed versioned surface of ADR-013 is
// api/theygrow_api/parameters.py, which is server-side and untouched by a
// device-local packet.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002)
// and is inert on both: nothing here reads, writes or requests anything. Which
// of the two header actions a parent is offered is decided at runtime from
// window.Capacitor, in surfaces/channel.js — a branch, never a second build
// (PDR-034 §3).
//
// WHAT THIS SURFACE IS FOR, in one paragraph. PDR-034 §1 splits the roles: the
// native app is the product, and the web channel is a showcase and an ENTRY
// POINT that accepts no new family data. So the web channel stops offering the
// archive — it cannot produce one at all, there is no web branch in
// export/sink.js and there never was (LSC-DL-003 (m)) — and starts offering the
// thing a visitor actually needs, which is the APK (ADR-047: distribution is a
// direct APK from GitHub Releases, not a store).

export const CHANNEL_CONFIG = Object.freeze({
    // changed_in: DIA-DL-004 — the public address the download control points
    // at. `/releases/latest` rather than the listing: what a parent needs is one
    // page carrying the newest binary together with the three things
    // docs/RUNBOOK.md requires to travel WITH it — the versioned filename, the
    // SHA-256 beside the download, and the "allow installs from unknown
    // sources" instruction (ADR-047 §8). The RUNBOOK rule that a static `latest`
    // must never name a binary is about the FILENAME, which this URL does not
    // set; the page it opens shows the versioned name.
    //
    // This is a PUBLIC address, like TRANSFER_CONFIG.handoffOrigin and unlike
    // the live-infra identifiers docs/RUNBOOK.md withholds: it says where the
    // product is distributed, not where anything is deployed. Verified public
    // and unauthenticated before it shipped: `gh api repos/{owner}/{repo} --jq
    // .private` returned `false` (DIA-DL-004). A private repository would make
    // this link a 404 for every visitor even after a release, which is a broken
    // distribution channel rather than a markup defect.
    apkReleaseUrl: 'https://github.com/mlberkov/theygrow-app/releases/latest',

    // changed_in: DIA-DL-004 — WHERE THE PUBLICATION STATE LIVES, and why it is
    // not a boolean in this file.
    //
    // The state changes on an OWNER ACT: the first time the Release workflow
    // runs and its two files are published by hand. This module ships under
    // /m/v{N}/, served `public, immutable, max-age=2592000` at a URL whose bytes
    // are never rewritten (A1-DL-004) — so a boolean here would cost a
    // copy-forward mount generation, a CACHE_VERSION bump and a promotion to
    // flip, for one owner act, with five generations already shipped. The shell
    // is served `max-age=3600, must-revalidate` and network-first by the worker,
    // so the same flip there costs a deploy and reaches installed clients on
    // their next navigation.
    //
    // So the VALUE lives in app/index.html as a <meta> declaration and the
    // VOCABULARY lives here: this knob names the meta tag, the next one names
    // the single content value that means "an asset exists". The logic and the
    // URL stay in the module, so nothing about module discipline moves — what
    // moved is one string whose whole nature is that an owner changes it.
    //
    // FAIL-CLOSED, and this is the load-bearing half: any content that is not
    // exactly `releaseStatePublished` — a missing tag, an empty value, a typo,
    // a stale `none` — means NOT PUBLISHED and the control is not offered. The
    // web channel must never present a visitor with a 404 or an empty releases
    // page dressed as a download, and "undeclared means gated" is the only shape
    // of that promise a mistake cannot break.
    releaseStateMeta: 'theygrow-apk-release',

    // changed_in: DIA-DL-004 — the ONE content value that means "a release is
    // published and its assets are on that page". Anything else is gated.
    releaseStatePublished: 'published',
});
