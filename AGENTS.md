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

- **Monorepo.** `/app` (the PWA) + `/api` (Python FastAPI). The split lands in M2; the current static PWA at repo root migrates into `/app` then.
- **Core store = one managed PostgreSQL (single source of truth) (ADR-008).** Vector, lexical, and graph-state are **derived ports within that one database** (pgvector for vectors; embeddings ≤1536 from M3) — not separate stores. No separate graph database is part of the live perimeter.
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
- **Do not touch live deploy paths** in any M1 packet: `cloudbuild.yaml`, `Dockerfile`, `nginx.conf`, `index.html`, `sw.js`, `manifest.json`, `offline.html`, `icons/`. The live Cloud Run deploy must remain unaffected by every M1 packet.
- One branch per milestone; the branch prefix matches the milestone's nature (M1 is enablement / config / docs with no product behavior, so the current milestone branch is `chore/m1-harness`). Packets are commit-checkpoints on that branch. **A PR opens once per milestone, at close** — not per packet.
- M1 packets: P1 contract redirect; P2 docs spine; P3 quality harness; P4 naming / gitignore / README cleanup.

## §8 Repository layout

**Target.**

```
theygrow-app/
├── app/        # PWA (lands in M2; today the PWA still lives at repo root)
├── api/        # Python FastAPI (lands in M2)
├── docs/       # decision-log, invariants, runbook, execution-map, product specs
├── scripts/    # ops + dev scripts
└── infra/      # IaC (post-M5)
```

**Current.** Static PWA at repo root (single `index.html` + nginx + Docker + Cloud Run via Cloud Build). The monorepo split lands in M2+.

## §9 Working conventions

- **Commits.** Conventional Commits: `feat | fix | docs | chore | refactor | test | ci`. Subject ≤ 72 chars. Body explains *why*, not *what*.
- **Branches.** One branch per milestone. The prefix reflects the milestone's nature: `chore/` for enablement / config, `docs/` for docs-only, `refactor/` for internal cleanup, `feat/` for product behavior. Packets land as separate commits on that branch — no per-packet branches, no per-packet PRs.
- **PRs.** A single PR per milestone, opened at milestone close, after all packets have landed as commits.
- **Decision log.** Entries live in `docs/decision-log.md`. Id format `M{N}-DL-{NNN}`. Required fields: **Date**, **Decision**, **Rationale**, **Alternatives considered**, **Supersedes**, **Effects**.
- **Scope discipline.** Do not widen scope inside a packet. Surface forks as questions. Gated-out items (§5) stay gated.

## §10 Invariants bar

- `docs/INVARIANTS.md` is **enforced-only**. An invariant goes there only when a packet enforces it in code (test, lint rule, schema constraint, runtime guard).
- Intent-level invariants — what the contract says we will do — live here in §2 and §3, **not** in `INVARIANTS.md`. This keeps `INVARIANTS.md` from becoming a wish list.

## §11 Historical artifacts

- `data/mvp_masterplan.md` (dated 11 February 2026, "TheyGrow MVP — Мастер-план разработки") is **SUPERSEDED** as plan of record on 2026-06-19. It is preserved as a reference artifact, not a task source. See `docs/decision-log.md` entry `M1-DL-001`.
- `.cursor/rules/masterplan.mdc` has been neutralized to a redirect stub that points at this file.
