# TheyGrow

TheyGrow is a **closed-corpus family-memory** application: a parent marks what their
child can do, writes about it in their own words, and keeps the result. Its future chat
surface will answer only from two grounded sources — the family's own memory and a
defined canon — never from open-web or parametric model knowledge; when those sources do
not cover a question, it says so rather than synthesizing an answer.

## Where a family's data lives

**On the device.** On the Android app the family's marks and diary entries are held in an
on-device, encrypted, append-only store, and **that store is the source of truth** for
them (`ADR-043` / `PDR-026`). There is no cloud copy, no account and no subscription
behind any of it. The browser's own storage is a losable cache, never the persistent home
of family data.

**And the way out is a file, not an API.** The app produces a keyless archive on the
phone, on the parent's command, and sends it nowhere: an ordinary `.zip` holding UTF-8
text files, a JSON index, a verbatim copy of the format's own field-by-field description,
and a **PDF/A-2b** print layer with the font and colour profile embedded — readable in
decades with no app, no key, no account and no company still standing. It carries the
marks, the journal, and the exporting participant's **own** diary text; another
participant's diary entries never travel in it, in any layer (`declaration.json`
`scope.diary`).

## The two delivery channels

The **native Android app is the product**; the **web is an informational showcase and an
entry point** (`PDR-034`). Both ship **byte-identical assets** — the APK's web root is
assembled from the same `COPY` list the container image uses — so a channel difference is
a runtime branch, never a second build. The web channel therefore offers no diary and no
archive: it has no store to read and nothing to write one from, and it says so on screen
rather than offering a control that cannot act.

## Current state

- `app/` — the PWA, served buildless: the shell plus a versioned module mount at
  `app/m/v{N}/`, no bundler and no transpiler on the production path.
- `native/` — the Capacitor Android shell, the local encrypted store, the diary, and the
  export contour. This is where the product runs.
- `api/` — the Python / FastAPI service. Deployed, health-checked, and reached only
  through the PWA's own origin; no family data passes through it.
- Delivery ladders: `L1` local structured core → `L2` local diary and search → `L3` first
  live-install UX (**current**). The `M1`–`M5` engine spine and the `А`/`Б`/`В` tracks are
  mapped in `AGENTS.md` §6 and tracked in `docs/execution-map.md`.

## Where to read next

- [`AGENTS.md`](AGENTS.md) — product, architecture, scope and invariants (source of truth).
- [`docs/execution-map.md`](docs/execution-map.md) — where the work actually is, packet by packet.
- [`docs/decision-log.md`](docs/decision-log.md) — every decision and why it was taken.
- [`docs/INVARIANTS.md`](docs/INVARIANTS.md) — the properties that must keep holding, and the test that holds each.
- [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — operational reality: build, deploy, release, and the owner-run smokes.
- [`docs/product/BuildPlan.md`](docs/product/BuildPlan.md) — milestone-level delivery plan.
