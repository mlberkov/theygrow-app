# TheyGrow

TheyGrow is a **closed-corpus family-memory** application. Its chat surface answers
only from two grounded sources — the family's own memory and a defined canon — and
never from open-web or parametric model knowledge. When those sources do not cover a
question, it says so rather than synthesizing an answer.

## Current state

The repository currently ships a **static PWA**, served on Cloud Run. The product
runtime — the `/app` front end and the `/api` back end — lands from **M2 onward**;
see the milestone ladder below. No business endpoints exist yet.

## Where to read next

- [`docs/product/BuildPlan.md`](docs/product/BuildPlan.md) — milestone-level delivery plan (M1–M5).
- [`AGENTS.md`](AGENTS.md) — product, architecture, scope, and invariants (source of truth).
- [`docs/decision-log.md`](docs/decision-log.md) — recorded decisions and their rationale.
