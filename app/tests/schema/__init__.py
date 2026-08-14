"""Desktop schema tests for the native store (L1-P2).

These tests execute the mount's `store/schema/001-core.sql` — the SAME file the JS
store fetches inside the WebView and the Android instrumented test reads out of
`assets/public/` — against the standard library's SQLite. They are the fast
layer of the three-layer validation described in `LSC-DL-002`: schema shape and
behaviour here, CRDT merge semantics in `app/tests/merge-semantics.spec.js`,
real-engine capability in `native/android/app/src/androidTest/`.

The package carries an `__init__.py` so mypy resolves it as the package `schema`
rather than as loose top-level modules, which would collide with `api/tests`.
"""
