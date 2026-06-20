# Enforced invariants — theygrow-app

## Bar

`INVARIANTS.md` is **enforced-only**. An invariant goes here only when a packet enforces it in code — a test, a lint rule, a schema constraint, a runtime guard, or a CI gate. Intent and runtime contract do **not** live here:

- **Intent-level invariants** (what the contract says we will do) live in `AGENTS.md` §2 and §3.
- **Documented runtime behavioral contract** (what the running system must do, before code lands) lives in [`RUNTIME-INVARIANTS.md`](RUNTIME-INVARIANTS.md).

Keeping this file enforced-only prevents it from drifting into a wish list.

## Invariants

_None yet._

The first entry lands in **M1-P3** when the quality harness (Ruff / mypy / pre-commit / GitHub Actions CI / secret-scan) is added — that packet introduces the first code-level enforcement and so the first eligible invariant. No earlier packet has standing to add an entry.

## Entry format (for future entries)

- **Id.** `M{N}-P{k}-INV-{NNN}` — `N` is the milestone number, `k` is the packet number within the milestone, `NNN` is zero-padded sequence within the packet (`001`, `002`, …).
- **Required fields.**
  - **Statement.** The invariant in one sentence.
  - **Enforced by.** File path(s) of the enforcing artifact — test, lint rule, schema constraint, runtime guard, or CI workflow.
  - **Landed in.** Packet id + commit SHA where enforcement was introduced.
  - **Scope.** What the invariant covers, and explicitly what it does not.
