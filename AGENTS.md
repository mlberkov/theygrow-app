# theygrow-app — Operating contract for AI agents

This file is the in-repo operating contract for any AI agent working on `theygrow-app`. The plan of record is **ADR-005** + **roadmap v3** (tracks А/Б/В). The product is closed-corpus family memory: chat answers ONLY from family memory (episodic store) and canon (skill descriptions and future canon content). No web, no model parametric knowledge.

---

## §1 Operating mode

- **Spec-first, harness-enforced.** Plans are first-class artifacts; designs precede edits.
- **Milestone-by-milestone, packet-by-packet.** One bounded packet at a time. Do not chain packets or pull the next packet's work into the current one.
- **Scope never widens.** A new ask is a new packet. Forks that touch scope, contracts, or owner-level decisions surface as questions, not silent guesses.
- **Maximize autonomy inside bounded scope; never beyond it.**

## §2 Product invariants (intent-level)

- **Closed corpus.** Chat answers come only from family memory (episodic) and canon (skill descriptions, future canon content). No web, no model parametric knowledge.
- **Honest degradation.** When the corpus does not contain a grounded answer, say so explicitly; never synthesize one.
- **Per-segment provenance.** Every answer surface carries source attribution at the segment level.
- **Medical boundary.** The product does not give medical advice. Health-adjacent surfaces route to a medical-boundary response, not to a generated answer.

## §3 Architecture invariants (intent-level)

- **Monorepo.** `/app` (the PWA) + `/api` (Python FastAPI) + `/native` (the Capacitor Android shell). The `/app` + `/api` split landed in M2-P1; `/native` landed in L1-P1 and ships the same bytes as `/app` rather than a second web app.
- **Family data lives on the device (ADR-043 / PDR-026).** On the Android channel the family's marks are held in an on-device, encrypted, append-only, schema-bearing store, and **that store is the source of truth** for them. WebView storage is a **losable cache** and never the persistent home of family data. The export contour is produced on the device and needs no key, no account and no subscription.
- **Core store = one managed PostgreSQL (single source of truth) (ADR-008).** Vector, lexical, and graph-state are **derived ports within that one database** (pgvector for vectors; embeddings ≤1536 from M3) — not separate stores. No separate graph database is part of the live perimeter. **This entry describes the *server* contour and reads as a specification of rung L4, not as a statement about where family data is stored today** — that is the device (previous entry), by decision-layer amendment.
- **Engine `diary-memory-service` is OUT of perimeter.** It is a **code donor** for the M4 retrieval lift and the **/export migration source** for M3. It is **not** a live dependency of `theygrow-app` and must not become one.
- **Persona resolution at import = stub.** A real persona / identity model is gated out (see §5).

## §4 Privacy precondition

- **No child PII in telemetry or logs.** Names, diary texts, and birthdates never cross the running boundary into telemetry, logs, error tracking, or third-party services. This applies from the first byte of code in M2 onward; the harness is shaped to enforce it.

## §5 Gated-out (deferred — do NOT plan toward these)

These items are explicitly deferred. They are named here only to be named-and-deferred; treat any task that targets them as out of scope until the gate lifts.

- Graph-store + bitemporal state
- Multi-subject persona / identity model
- Unified propose→confirm write contract
- Recommendations
- ZPD enrichment
- Family-profile synthesis
- KB repo

## §6 Milestone map (summary)

This is the map, not the spec. Roadmap v2 is the spec.

- **M1** — Repository preparation for agentic development (enablement harness; this milestone).
- **M2** — `/api` skeleton.
- **M3** — Episodic store + `/export` importer.
- **M4** — Retrieval lift from the engine.
- **M5** — Closed-corpus family-memory chat.

## §7 M1 scope guardrails

- M1 is **docs / refactor / config only**. No product behavior. No backend code. No schema.
- **Do not touch live deploy paths** in any M1 packet: `cloudbuild.yaml`, `cloudbuild.staging.yaml` (the `/api` staging build-config, A2-P1), `Dockerfile`, `nginx.conf`, `docker-entrypoint.sh` (the PWA container entrypoint, A3-P1), `index.html`, `sw.js`, `manifest.json`, `offline.html`, `icons/`, `kb-v1.json`, `m/` (the versioned module mount, A1-P3). The live Cloud Run deploy must remain unaffected by every M1 packet.
- One branch per milestone; the branch prefix matches the milestone's nature (M1 is enablement / config / docs with no product behavior, so the current milestone branch is `chore/m1-harness`). Packets are commit-checkpoints on that branch. **A PR opens once per milestone, at close** — not per packet.
- M1 packets: P1 contract redirect; P2 docs spine; P3 quality harness; P4 naming / gitignore / README cleanup.

## §8 Repository layout

**Target.**

```
theygrow-app/
├── app/        # PWA (landed in M2-P1)
├── api/        # Python FastAPI (landed in M2)
├── native/     # Capacitor Android shell (landed in L1-P1)
├── docs/       # decision-log, invariants, runbook, execution-map, product specs
├── scripts/    # ops + dev scripts
└── infra/      # IaC (post-M5)
```

**Current.** Static PWA under `/app` (nginx + Docker + Cloud Run via Cloud Build), alongside `/api`. The monorepo split landed in M2-P1. The PWA is no longer a single `index.html`: since the A1 `spa-split` milestone the shell loads its stylesheet and its ES-module graph from the versioned mount `app/m/v{N}/`, served buildless (no bundler, no transpiler). Since the L1 `local structured core` milestone the same bytes ship through **two delivery channels**: the served PWA, and an Android APK built from `native/` — a Capacitor shell whose web root is assembled from `app/Dockerfile`'s `COPY` list, so both channels carry byte-identical assets and the production web path stays buildless in both. `native/www/` is the staged web root; `native/android/` is the generated Android project, committed.

## §9 Working conventions

- **Commits.** Conventional Commits: `feat | fix | docs | chore | refactor | test | ci`. Subject ≤ 72 chars. Body explains *why*, not *what*.
- **Branches.** One branch per milestone. The prefix reflects the milestone's nature: `chore/` for enablement / config, `docs/` for docs-only, `refactor/` for internal cleanup, `feat/` for product behavior. Packets land as separate commits on that branch — no per-packet branches, no per-packet PRs.
- **PRs.** A single PR per milestone, opened at milestone close, after all packets have landed as commits.
- **Decision log.** Entries live in `docs/decision-log.md`. Id format `M{N}-DL-{NNN}`. Required fields: **Date**, **Decision**, **Rationale**, **Alternatives considered**, **Supersedes**, **Effects**.
- **Scope discipline.** Do not widen scope inside a packet. Surface forks as questions. Gated-out items (§5) stay gated.

## §10 Invariants bar

- `docs/INVARIANTS.md` is **enforced-only**. An invariant goes there only when a packet enforces it in code (test, lint rule, schema constraint, runtime guard).
- Intent-level invariants — what the contract says we will do — live here in §2 and §3, **not** in `INVARIANTS.md`. This keeps `INVARIANTS.md` from becoming a wish list.

## §11 Evidence bar

- **A claim about runtime behaviour counts only once a test that executes that behaviour has executed it.** Executing means the product runs: a page loads and a control is clicked, an app boots, a process runs, a query runs against a real engine. A guard is **static** when its own code never starts the product — no page, no emulator, no process — and a static guard cannot carry a runtime claim however precisely it reads the source that would produce it.
- **Scanning for static properties stays legitimate and remains preferred where it fits**: presence of a file, absence of an import, shape of markup, composition of the ship list, provenance of a knob. Those are properties of the tree, and reading the tree is the right instrument for them.
- **Detector.** An obligation without a detector is an intention, so this rule carries all three parts.
  - **Check.** Of every guard behind a claim, ask: could it stay green with the handler body emptied, or with the shipped rule deleted? Does its own code start the product? If it cannot execute and boots nothing, what it carries is a static property, whatever the claim says.
  - **Admissible hits.** The static list above. Naming what is legitimately static is what makes a negative result provable rather than merely absent.
  - **Moment.** Run at plan authoring — the Validation section names, per runtime claim, the test that executes it, and a packet with none says so explicitly ("no runtime claims this packet") rather than leaving the section silent — at plan review, and at acceptance of the execution report.
- **Where this came from.** Four claims in milestone L1 passed for the wrong reason, and the fourth cost the milestone its traffic promotion:
  1. the answer map passed as the options object (`createFakeBridge({ answer })`, `app/tests/support/fake-bridge.js`), so `answer` stayed empty, every scripted read returned `[]` and the assertions held — **vacuous fixture**;
  2. `includes('INSERT INTO child')` also matched `INSERT INTO child_attribute` — **over-matching substring** (`app/tests/import-legacy.spec.js`, now `'INSERT INTO child ('`);
  3. the signal-payload guard's `/emitSignal\(\s*([^)]*?)\s*\)/` stopped at the first close paren, so a payload reading family text through a call was never seen — **a regex failing open** (`LSC-P4-INV-003`, `LSC-DL-004`);
  4. the export guard asserted markup substrings for a surface no user could reach, because no `.modal.show` rule was ever declared — **a static guard standing in for a runtime claim** (`EMV-P1-INV-001`, `EMV-DL-001`).

## §12 Historical artifacts

- `data/mvp_masterplan.md` (dated 11 February 2026, "TheyGrow MVP — Мастер-план разработки") is **SUPERSEDED** as plan of record on 2026-06-19. It is preserved as a reference artifact, not a task source. See `docs/decision-log.md` entry `M1-DL-001`.
- `.cursor/rules/masterplan.mdc` has been neutralized to a redirect stub that points at this file.
