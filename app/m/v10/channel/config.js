// Delivery-channel knobs (DIA-P2).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob THE CHANNEL
// COMPOSITION introduces lives HERE, once, with changed_in provenance — never as
// a literal in the shell or in surfaces/channel.js. It arrived as the FOURTH
// device-local config surface, beside store/config.js ("every qualitative knob
// THE STORE introduces"), export/config.js ("...the export contour...") and
// transfer/config.js ("...the browser-to-native transfer..."), following the
// same precedent chain: CACHE_VERSION in app/sw.js (PWA-DL-001), then
// store/config.js (LSC-DL-002), export/config.js (LSC-DL-003) and
// transfer/config.js (DIA-DL-001). PPR-P2 changed the membership without
// changing the count — transfer/config.js retired with the mechanism it
// described and consent/config.js took its place — and UIP-P1 changes the count:
// analytics leaves the web showcase entirely, consent/config.js retires with it,
// and the THREE surfaces shipped under this mount are store/, export/ and
// channel/ — FOUR since NAV-P3, which added nav/config.js for the navigation
// knobs rather than putting a gesture threshold on a surface whose declared
// subject is the channel composition. (This sentence is corrected here, in a
// packet that adds no knob to this file, because leaving a count that the same
// packet falsifies would leave the next reader counting wrong.) The typed versioned surface of ADR-013 is
// api/theygrow_api/parameters.py, which is server-side and untouched by a
// device-local packet.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002)
// and is inert on both: nothing here reads, writes or requests anything. Which
// of the two header actions a parent is offered is decided at runtime from
// window.Capacitor, in surfaces/channel.js — a branch, never a second build
// (PDR-034 §3).
//
// L3-P3 adds a SECOND declaration of the same shape, for the privacy policy —
// same fail-closed rule, same value-in-the-shell / vocabulary-in-the-mount
// split, and one deliberate difference recorded at the knob itself: the policy
// link is offered on BOTH channels, because the person who needs it is the one
// entering data.
//
// NAV-P2 ADDS FOUR MORE, AND THEY ARE THE FIRST KNOBS ON THIS SURFACE THAT
// DESCRIBE A NETWORK REQUEST. Until this packet the app made none at all: every
// `fetch` under the mount addressed a same-origin asset, which inside the
// WebView is a local read. The update check adds exactly one outbound request,
// made only when a parent presses the «Обновление» row, and its address, its
// deadline, the shape of the release asset it reads and the token that means
// «this copy came from Play» are declared here rather than written into the
// surface. The reason is the one LSC-P3-INV-002 already gave for the export
// contour: a new off-device read must be DECLARED before it can compile past the
// gate. There is still no analytics, no counter and no signal behind any of it —
// see surfaces/update.js, which says so where the next reader will look.
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

    // changed_in: FIU-DL-003 — the address of the privacy policy, and the same
    // class of public identifier as apkReleaseUrl and TRANSFER_CONFIG
    // .handoffOrigin: it says where a PUBLIC document is, not where anything is
    // deployed, so it belongs here and not in docs/RUNBOOK.md.
    //
    // Apex, not a subdomain; an HTML page, not a PDF. Both are owner decisions
    // (PDR-035 §2) rather than preferences: the policy is read on a phone, by a
    // parent who has not installed anything yet, and a PDF on a phone is a
    // download and a pinch-zoom rather than a document.
    //
    // WHY THE APP LINKS IT AT ALL, since a showcase page could carry it alone:
    // the person who needs it is the one ENTERING DATA, and that happens inside
    // the app. So the link lives on both channels, which is also why the
    // decision function below takes no channel argument — unlike shouldOfferApk,
    // whose whole subject is that one channel already has the app.
    policyUrl: 'https://theygrow.app/privacy',

    // changed_in: FIU-DL-003 — where the publication state of that document
    // lives, by the same argument as releaseStateMeta above and with one
    // difference that is worth saying out loud.
    //
    // SAME ARGUMENT: the value changes on an OWNER ACT — the day the document is
    // actually published — and the mount is served immutable at a URL whose
    // bytes are never rewritten (A1-DL-004), so a boolean here would cost a
    // generation, a CACHE_VERSION bump and a promotion to flip. The shell is
    // `max-age=3600, must-revalidate` and network-first. So the VALUE is a
    // <meta> in app/index.html and the VOCABULARY is here.
    //
    // THE DIFFERENCE: the shell is also what the APK carries. On the web channel
    // the flip costs a deploy and reaches installed clients on their next
    // navigation; on the native channel it reaches a phone only in the NEXT
    // release build. That asymmetry is stated in docs/RUNBOOK.md rather than
    // engineered around, because engineering around it means a second
    // declaration under /m/v{N}/ — exactly the cost this split exists to avoid.
    //
    // FAIL-CLOSED, and here it is the whole point: until the document exists,
    // any content that is not exactly `policyStatePublished` — a missing tag, an
    // empty value, a typo, a stale `none` — means NOT PUBLISHED, and no policy
    // link is rendered anywhere. A privacy policy is the one link a parent is
    // entitled to trust; a 404 under that word is worse than its absence.
    policyStateMeta: 'theygrow-privacy-policy',

    // changed_in: PPR-DL-002 — THE ONE TOKEN THAT MAKES A VISITOR'S PLATFORM
    // ANDROID, matched case-insensitively as a substring.
    //
    // WHY A SUBSTRING AND NOT A LIST OF PLATFORMS. The question this knob serves
    // is not "which operating system is this" — the product does not care — it is
    // "can this visitor install an .apk". One token answers it, and any answer
    // that is not that token is the same answer: no. Widening this to a list
    // would be widening the set of visitors offered a file, which is the
    // direction that has to stay hard.
    //
    // THE PROBE THAT USES IT IS surfaces/channel.js isAndroidPlatform(), and it
    // fails CLOSED: an absent navigator, an absent user-agent string and an
    // unrecognised platform all return false, and false means the honest
    // sentence rather than a download nobody can use (PDR-034 §1, debt 21).
    // Detection here is a heuristic and is written down as one; what it protects
    // against is a broken offer, not a determined visitor, and a determined
    // visitor still has the release page.
    androidPlatformToken: 'android',

    // changed_in: FIU-DL-003 — the ONE content value that means "the policy is
    // published at policyUrl". Anything else is gated. Deliberately the same
    // token as releaseStatePublished: two declarations of the same shape, and an
    // owner who has learnt one has learnt both.
    policyStatePublished: 'published',

    // changed_in: NAV-DL-002 — THE ONE ADDRESS THE APP EVER REQUESTS, and the
    // first outbound request this product makes at all (vault ADR-052 §1).
    //
    // It is a knob and not a literal in the surface for the reason
    // LSC-P3-INV-002 already established for the export contour: a new
    // off-device read has to be DECLARED here before it can compile past the
    // gate, so "where does this app reach" is answerable by reading one file
    // rather than by trusting a sweep. app/tests/update-contour.spec.js refuses
    // to see this address anywhere else in the shipped tree, and refuses a
    // `fetch(` in surfaces/update.js whose argument is not this knob.
    //
    // UNAUTHENTICATED, AND THAT IS THE WHOLE FORM. No token, no query string, no
    // user, device or install identifier, no cookie, nothing derived from family
    // data. What GitHub observes is the IP address and the standard headers a
    // browser sends, which is named in exactly those words in the published
    // policy (edition 1.3, §6) rather than left for a reader to infer.
    //
    // `releases/latest` and not the listing, on the same argument as
    // apkReleaseUrl above: one answer, about the newest release, is the whole
    // question the row asks. It is the API host, api.github.com, and not the
    // page host — the page is what «Установить» opens, in the browser.
    updateApiUrl: 'https://api.github.com/repos/mlberkov/theygrow-app/releases/latest',

    // changed_in: NAV-DL-002 — how long the check waits before giving up, and
    // the ONLY cancellation there is.
    //
    // ONE LITERAL FOR TWO THINGS ON PURPOSE. This value is both the
    // AbortController's deadline and the duration of the row's progress fill:
    // the fill IS the countdown to this deadline, so a second literal in the
    // stylesheet would be a fill that lies about when the app gives up.
    // surfaces/update.js writes it onto the element as a custom property, and
    // app.css reads that property with no fallback — an unset property means no
    // animation, never a different duration.
    //
    // Nothing retries. A check that ends in a failure ends there, and the only
    // thing that starts another is a parent pressing the row again.
    updateCheckTimeoutMs: 10000,

    // changed_in: NAV-DL-002 — the shape of the published release asset, and
    // through it the ONE number the comparison is made on.
    //
    // WHY THE ASSET NAME AND NOT THE TAG. docs/RUNBOOK.md § Running the release
    // build says it outright: «The tag name does not set the version» — it
    // selects a commit. The asset name is derived from the build's own
    // output-metadata.json and carries `versionCode`, which
    // native/android/app/build.gradle derives from `git rev-list --count HEAD`
    // *because* it is reproducible from the commit and monotone along ancestry,
    // «which is what an update chain needs». So the update chain's own number is
    // what the update check compares.
    //
    // FAIL-CLOSED: a release whose assets do not match this shape yields no
    // number, and no number is reported as an answer that could not be read —
    // never as «обновлений нет», which would be a false all-clear.
    releaseAssetPattern: '^theygrow-v\\d+\\.\\d+\\.\\d+-(\\d+)\\.apk$',

    // changed_in: NAV-DL-002 — the single token that means "this copy came from
    // Google Play", and with it the only reason the row is ever withheld from a
    // native channel.
    //
    // WHY WITHHELD THERE (vault ADR-052 §1.5 leaves this to the packet). The
    // GitHub-channel APK is signed by `theygrow-release` and the Play copy by
    // Google's key (vault ADR-047, annotation 2026-08-25): the two channels
    // carry different signatures, so the release page this row would send a Play
    // user to holds a binary that cannot install over what they have. Offering
    // it is offering something that cannot be acted on, and crossing channels
    // costs the family's local database.
    //
    // THE DIRECTION OF THE GATE IS ARGUED, NOT ASSUMED. The rule is «withhold on
    // this positive token», not «offer only on a positive GitHub token», because
    // there is no positive GitHub token: a sideloaded install reports null, or
    // the browser or file manager it was opened from. Gating on absence would
    // withhold the row from every GitHub-channel user — that is, from everyone
    // this row exists for (vault PDR-022 §2, the only in-app channel for a
    // safety fix). The truth table is executed off-device in
    // app/tests/channel-composition.spec.js.
    playInstallerPackage: 'com.android.vending',
});
