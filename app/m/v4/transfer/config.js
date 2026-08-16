// Browser-to-native history transfer knobs (DIA-P1).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob this transfer
// introduces lives HERE, once, with changed_in provenance — never as a literal
// scattered through the handoff page or the bridge seam. This is a THIRD
// device-local config surface beside store/config.js ("every qualitative knob
// THE STORE introduces") and export/config.js ("...the export contour..."),
// following the same precedent chain: CACHE_VERSION in app/sw.js (PWA-DL-001),
// then store/config.js (LSC-DL-002), then export/config.js (LSC-DL-003). The
// typed versioned surface of ADR-013 is api/theygrow_api/parameters.py, which is
// server-side and untouched by a device-local packet.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002)
// and is inert on both: nothing here reads, writes or requests anything.
//
// WHAT THE TRANSFER IS, in one paragraph, because every number below is a
// consequence of it. The family's real history lives in localStorage under the
// production origin, in the parent's browser. The native app cannot see it: the
// Capacitor WebView's origin is https://localhost, a different storage
// partition. So the app opens a page under the production origin, that page
// reads the history and hands it back through a link the app registered, and
// the existing L1-P4 importer takes it from there — unchanged, idempotent, and
// writing nothing to the source (LSC-P4-INV-002). ADR-048.

export const TRANSFER_CONFIG = Object.freeze({
    // changed_in: DIA-DL-001 — the custom scheme and host the app registers an
    // intent-filter for. The CHOICE inside ADR-048 §4's bounds is a custom
    // scheme rather than https App Links: App Links require a stable release
    // signature to verify against, the Release workflow has never run
    // (ADR-047), and the family's history exists now. A custom scheme works on
    // the debug signature the device is holding today. App Links stay an
    // allowed later addition, not a precondition.
    linkScheme: 'theygrow',
    linkHost: 'transfer',

    // changed_in: DIA-DL-001 — the package the link is addressed to.
    //
    // THIS IS A PRIVACY MECHANISM, NOT PLUMBING. A bare `theygrow://` link is
    // deliverable to ANY app that registered the same scheme, and Android would
    // offer the parent a disambiguation dialog carrying their child's history to
    // whichever entry they pressed. Chrome's `intent://` form with an explicit
    // `package=` resolves to this package or to nothing at all — there is no
    // dialog and no second candidate. The same form is what supplies
    // `browser_fallback_url`, which is how "no link handler" is DETECTED rather
    // than guessed at (see fallbackFlag).
    linkPackage: 'app.theygrow',

    // changed_in: DIA-DL-001 — the ONLY query keys the link may carry. Mirrored
    // as the declared key set in the receiving plugin, which refuses a key it
    // does not declare before it stages anything — the same fail-closed shape
    // ExportSinkPlugin.createDocument applies to the picker-launching call
    // (XPT-DL-001 (c)). The two languages share no config surface, so the set is
    // written in both places and asserted equal off-device.
    linkParams: Object.freeze({
        payload: 'payload',
        bytes: 'bytes',
        digest: 'sha256',
        version: 'v',
    }),

    // changed_in: DIA-DL-001 — the ceiling on the ENCODED payload the link may
    // carry. Over it, the page does not build a link at all: it emits the
    // fallback file instead, deciding BEFORE the link exists rather than trying
    // one and seeing (ADR-048 §3, and the XPT-P1 shape of guarding before the
    // intent is built).
    //
    // WHERE 16384 COMES FROM — measured against the real corpus with the
    // SHIPPED builder, not chosen for roundness. One profile with ALL 174 skills
    // of app/kb-v1.json ticked, put through buildEnvelope/encodePayload in
    // ./format.js, is 1 669 bytes of envelope and a 2 226-character base64url
    // payload. So this ceiling is 7.4x the worst case for one profile — about
    // seven profiles at maximum completion — and 64x under the ~1 MB binder
    // limit that killed this repository at a 4 630 924-byte parcel (XPT-DL-001).
    // (Measured with the module, deliberately: an earlier figure here came from
    // a JSON serialiser whose default separators insert spaces JSON.stringify
    // does not, and was 11% high — a number that is not the measurement it
    // claims to be is worse than no number.)
    //
    // WHAT IS NOT MEASURED, STATED HERE BECAUSE THIS IS WHERE A READER MEETS THE
    // NUMBER. The 16 KiB is measured on the PAYLOAD side only. **No test
    // exercises a link longer than the fixture** — the instrumented leg fires a
    // synthetic Intent straight at MainActivity rather than driving Chrome, and
    // the owner smoke runs on a real history of roughly 2.5 KB — so how a real
    // browser behaves on a URI between the fixture size and this ceiling is
    // UNOBSERVED. It is not, however, unhandled: a browser that truncates a long
    // URI produces a payload whose length or digest disagrees with the declared
    // `bytes` / `sha256`, the plugin refuses it as `size_mismatch` or
    // `checksum_mismatch` BEFORE staging, and the app falls automatically to the
    // file path. That refusal IS executed — by
    // HistoryTransferTest.the_receiver_refuses_a_truncated_link (DIA-P1), which
    // builds the truncated input in-run. Truncation therefore costs the parent
    // one line of instruction, never a partial history.
    linkMaxBytes: 16384,

    // changed_in: DIA-DL-001 — the query flag Chrome's `browser_fallback_url`
    // carries back to this page when NO app handled the link. It is the whole
    // no-handler detector: the browser tells us, so the page never has to guess
    // whether the app is installed, and the parent is never asked.
    fallbackFlag: 'fallback',

    // changed_in: DIA-DL-001 — the name of the file the fallback path emits.
    // Carries NO child's name, for exactly the reason
    // EXPORT_CONFIG.filenamePattern does not: a filename is visible in file
    // managers, share sheets and download lists.
    fallbackFilename: 'theygrow-transfer.json',
    fallbackMimeType: 'application/json',
});

// The transitional envelope's identity.
//
// READ THIS BEFORE REUSING EITHER VALUE. This format is TRANSITIONAL and its
// only consumer is the L1-P4 importer at the other end of this one transfer. It
// is NOT the long-lived artefact and carries none of its promises: the archive
// (EXPORT_CONFIG.formatId / formatVersion) is a PUBLIC commitment that must keep
// meaning what it meant once a copy is in a family's hands, and is built to be
// readable in decades with no tooling (LSC-P3-INV-001). This one is a wire shape
// between two halves of the same product, versioned only so the receiver can
// refuse bytes it does not understand. PDR-020 §1/§2 separates the two, and they
// must not be merged: dressing a snapshot as the artefact would promise
// longevity nothing here delivers.
//
// changed_in: DIA-DL-001 — both values, at the format's introduction.
export const ENVELOPE_FORMAT_ID = 'theygrow-transfer';
export const ENVELOPE_FORMAT_VERSION = 1;
