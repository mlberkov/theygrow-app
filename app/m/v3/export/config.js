// Export-contour knobs (L1-P3).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob the export
// contour introduces lives HERE, once, with changed_in provenance — never as a
// literal scattered through build.js or zip.js. This is a SECOND device-local
// config surface rather than an extension of store/config.js, whose docstring
// scopes it to "every qualitative knob THE STORE introduces". The typed
// versioned surface of ADR-013 is api/theygrow_api/parameters.py, which is
// server-side and untouched by a device-local packet; the front-side precedent
// chain is CACHE_VERSION in app/sw.js (PWA-DL-001) then store/config.js
// (LSC-DL-002), and this module follows it.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002).
// It is inert on the web: nothing here reads or writes anything by itself.

export const EXPORT_CONFIG = Object.freeze({
    // changed_in: LSC-DL-003 — the artifact's format identifier, written into
    // MANIFEST.json and into the embedded declaration. It is a PUBLIC, long-lived
    // commitment: once an artifact carrying this string is in a family's hands,
    // the string has to keep meaning what it meant.
    formatId: 'theygrow-archive',

    // changed_in: LSC-DL-003 — the format version. Bumps only when the DIRECTORY
    // SHAPE or the FIELD SET changes, never when a value changes. A reader that
    // understands version N must keep understanding artifacts written by it.
    formatVersion: 1,

    // changed_in: LSC-DL-003 — the artifact's self-description, fetched from the
    // app's own origin exactly like the DDL is (store/config.js schemaUrl). It is
    // the single source both the builder and app/tests/export/ read, and a
    // verbatim copy of it is embedded in every artifact.
    // changed_in: EMV-DL-001 — VALUE repointed at the /m/v2/ mount by the
    // copy-forward bump. Mount-relative URL, unchanged bytes; see
    // store/config.js schemaUrl for the same repoint and the same reason.
    // changed_in: XPT-DL-001 — VALUE repointed again, at /m/v3/, by the
    // export-transfer bump. The declaration bytes are unchanged: the artifact's
    // format is frozen and this packet changes only how the bytes travel to the
    // sink.
    declarationUrl: '/m/v3/export/declaration.json',
    declarationName: 'declaration.json',

    // changed_in: LSC-DL-003 — every zip entry is written with this fixed DOS
    // timestamp instead of the wall clock. A real mtime would make two exports
    // of an unchanged journal differ, which is the determinism property this
    // packet promises. 1980-01-01 00:00:00 is the DOS epoch, the earliest value
    // the zip format can represent.
    zipEntryDosDate: 0x0021,
    zipEntryDosTime: 0x0000,

    // changed_in: LSC-DL-003 — no compression, ever (zip method 0, STORED). A
    // compressor is a second thing that has to still exist and still behave
    // identically decades from now, and DEFLATE output is not guaranteed stable
    // across WebView versions — which would break byte-identity between two
    // devices holding the same journal. Media does not travel this channel, so
    // the artifact is small enough that compression buys little.
    zipCompressionMethod: 0,

    // changed_in: LSC-DL-003 — hard wrap for the human-readable text files.
    // Chosen to stay readable in a fixed-width terminal and in a printed page.
    textLineWidth: 78,

    // changed_in: LSC-DL-003 — the default filename offered in the system file
    // picker. Deliberately carries NO child's name: a filename is visible in file
    // managers, share sheets and backup listings. The parent can rename it.
    filenamePattern: 'theygrow-archive-{date}.zip',
    mimeType: 'application/zip',

    // changed_in: LSC-DL-003 — the app version recorded in MANIFEST.json. The
    // shell's inline GA4 shim carries the same literal (app/index.html), which
    // A1-P5 deliberately left inline; app/tests/export-contour.spec.js asserts
    // the two agree, so there is one truth with a drift guard rather than two
    // copies free to diverge.
    appVersion: '1.0.0',

    // changed_in: LSC-DL-003 — the canon artifact whose version is recorded in
    // MANIFEST.json. The skill identifiers in the journal are meaningless without
    // knowing which canon they were written against.
    canonUrl: '/kb-v1.json',

    // --- print layer (checkpoint 2) --------------------------------------

    // changed_in: LSC-DL-003 — the conformance level the print layer CLAIMS and
    // the XMP packet declares. Changing this string without changing what the
    // writer emits would make the artifact lie about itself, which is why the
    // claim is verified by veraPDF in the android-instrumented job rather than
    // trusted.
    pdfConformance: 'PDF/A-2b',

    // changed_in: LSC-DL-003 — the embedded font. PDF/A requires every font to
    // be embedded and there is no Cyrillic base-14 face, so a PDF from this app
    // always carries one. Vendored unmodified; see assets/PROVENANCE.txt.
    // changed_in: EMV-DL-001 — VALUE repointed at the /m/v2/ mount by the
    // copy-forward bump. The font file itself is byte-identical and keeps its
    // pinned SHA-256 in app/tests/export-contour.spec.js.
    // changed_in: XPT-DL-001 — VALUE repointed again, at /m/v3/. Same file,
    // same pinned digest.
    fontUrl: '/m/v3/export/assets/PTSans-Regular.ttf',
    pdfFontName: 'PTSans-Regular',

    // changed_in: LSC-DL-003 — the OutputIntent destination profile, required by
    // PDF/A-2b so the file's colour is reproducible without the device that
    // wrote it. 456 bytes; it travels inside every exported artifact.
    // changed_in: EMV-DL-001 — VALUE repointed at the /m/v2/ mount by the
    // copy-forward bump. The profile bytes are unchanged.
    // changed_in: XPT-DL-001 — VALUE repointed again, at /m/v3/. Same profile,
    // same 456 bytes.
    iccUrl: '/m/v3/export/assets/sRGB-v2-micro.icc',

    // changed_in: LSC-DL-003 — page typography. Deliberately conservative: one
    // regular weight, one size, no italics, so the writer needs one font file
    // and the layout has no state a future edit can get subtly wrong.
    pdfFontSize: 9,
    pdfLineLeading: 11,
    pdfMarginPt: 42,

    // changed_in: LSC-DL-003 — FontDescriptor /StemV. TrueType carries no stem
    // width, the key is mandatory, and a wrong value affects nothing a viewer
    // renders; 80 is the conventional value for a regular sans face and is
    // written down here rather than buried as a literal in the writer.
    pdfStemV: 80,

    // changed_in: LSC-DL-003 — /Producer. Names the artifact format rather than
    // a version string, so it does not drift on every release.
    pdfProducer: 'TheyGrow archive',

    // --- the transfer to the sink (XPT-P1) --------------------------------

    // changed_in: XPT-DL-001 — how many RAW bytes of the archive ride one
    // appendChunk call. The measured defect this replaces: the whole archive
    // travelled as one option of the call that opens the file picker, Capacitor
    // persists that call's options into the activity's saved instance state
    // TWICE, and at 1.73 MB of archive the resulting 4.63 MB parcel killed the
    // process at the binder limit before a single byte was written.
    //
    // 256 KiB is an order of magnitude under that ~1 MB limit even after base64
    // inflates it to ~349 KiB, so no single call on this path can approach the
    // limit however a future Capacitor version decides to move or persist it —
    // and an archive the size of a real family history is ~20 calls rather than
    // thousands. It is a transfer knob only: it does not touch one byte of the
    // artifact, which is why two exports chunked differently still produce
    // identical files.
    sinkChunkBytes: 262144,

    // changed_in: XPT-DL-001 — the ceiling the PICKER-LAUNCHING call's options
    // must stay under, enforced by the plugin before it builds the intent. The
    // knob is the app's copy of a bound the native side has to hold, so it is
    // mirrored as LAUNCH_OPTIONS_MAX_BYTES in ExportSinkPlugin.java — the two
    // languages share no config surface, and app/tests/export-contour.spec.js
    // asserts the two numbers agree, exactly as store/config.js's
    // sqliteVersionFloor is mirrored into app/tests/schema/harness.py.
    //
    // 4096 is far above what {transferId, filename, mimeType, totalBytes} can
    // ever serialize to and far below anything a parcel could object to. Its
    // job is not to be tight, it is to make "a payload rode the launching call"
    // impossible to reintroduce silently.
    sinkLaunchOptionsMaxBytes: 4096,
});

// The complete set of methods this app is allowed to call on the export sink.
//
// The same supply-chain boundary store/config.js draws around CapacitorSQLite,
// drawn again around the first-party sink plugin. THE BOUNDARY IS NOT THE COUNT,
// IT IS WHAT THE METHODS CAN REACH: there is no read method, no list method, no
// delete method and no "write to a path" method, so the plugin cannot reach the
// filesystem except through the one document the parent chose in the file picker
// in that moment. Two of the three methods below touch no filesystem at all —
// they hand bytes to a buffer in the app's own process — and the third is the
// one that writes, unchanged in what it may address.
//
// changed_in: XPT-DL-001 — grew from one method to three when the archive
// stopped riding the picker-launching call. app/tests/export-contour.spec.js
// asserts this exact set, so the list still cannot grow quietly.
export const ALLOWED_SINK_METHODS = Object.freeze([
    'beginTransfer',
    'appendChunk',
    'createDocument',
]);
