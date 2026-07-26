# CLAUDE.md — Claude Code operational overlay

This file extends `AGENTS.md` with operational rules specific to **Claude Code** (the CLI agent). On any conflict between the two documents:

- `AGENTS.md` wins for product, architecture, scope, and invariants.
- `CLAUDE.md` wins for Claude-Code operational specifics (Plan Mode, tool use, reporting, git posture).

`CLAUDE.md` does **not** restate `AGENTS.md`. Read both.

## Plan-Mode-first

- Any non-trivial change starts with a written plan in Plan Mode.
- Execute only after explicit owner go-ahead. Implicit approval is not approval.
- Plans are bounded to one packet. Do not pre-plan the next packet inside the current one.
- A plan is complete only if it follows the **Plan shape** section below.

## Decision authority in planning

Specifications and decision records for this project live in the owner's
knowledge vault, **outside this repository**. You cannot read them, and no
per-milestone spec files exist in the repo. Do not ask the owner to recite
vault content during planning.

- Your sources of truth, in order: `AGENTS.md` → this file → the actual
  state of the code → your own engineering judgment.
- During planning, do **not** interrupt the owner with clarifying
  architectural questions. Make the call yourself and record it in the
  plan's **Decisions & assumptions** block (see Plan shape).
- When a decision plausibly depends on vault content you cannot see, pick
  the most conservative reasonable option and tag that entry
  `[verify vs vault]`. The owner reviews the finished plan against the
  vault before go-ahead; that review — not mid-planning Q&A — is where
  spec conformance is checked. Your job is to make every decision explicit
  enough to be checkable.
- **Escalation list — ask the owner always**, even when an answer seems
  derivable:
  - personal/family data and any **new network egress** carrying it;
  - irreversible data migrations, transformations, or deletions;
  - anything that shifts the **free/paid boundary**;
  - deviation from `AGENTS.md` invariants or the declared packet scope;
  - changes to public contracts (knowledge-base format `kb-v{N}`,
    external APIs).
- Escalation questions are **batched** into the plan's Escalations
  section and asked once, at the end of planning — not streamed one by
  one — unless a question genuinely blocks all further planning.

## Plan shape

Every plan contains exactly these sections:

- **Scope** — the packet boundary: what is in, what is explicitly out.
- **Approach** — the intended change, in the order of execution.
- **Decisions & assumptions** — every architectural or design call made
  during planning: decision, one-line rationale, alternative considered
  (if any), `[verify vs vault]` tag where applicable. An empty block
  means "no decisions were needed", not "decisions were left implicit".
- **Escalations** — batched owner questions from the escalation list.
  Omit the section if there are none.
- **Validation** — how the result will be checked (commands, diff scope,
  manual checks).

## No autonomous git

- Never run `git commit`, `git push`, `git checkout -b`, `git rebase`, `git reset`, `git stash`, `git tag`, or any history-altering command on your own.
- Never open, edit, comment on, or close a pull request on your own.
- Produce an execution report (see below) and let the owner cut the commit and open the PR.

## Packet discipline

- Work exactly one bounded packet at a time.
- Do not chain packets. When the current packet's scope is satisfied, stop — even if the next packet's work looks small.
- Forks that touch the **escalation list** above surface as questions in
  the plan's Escalations section. All other architectural forks are
  **decided by you** and logged in Decisions & assumptions — not asked.
- Gated-out items (`AGENTS.md` §5) stay gated.

## Tool boundaries

- Outside the declared packet file allowlist: read-only by default.
- Inside the declared allowlist: confine edits to the declared change shape (e.g. "prepend header" does not authorize rewriting the body).
- No behavior changes to product or runtime files in M1, regardless of how small they look.

## Execution report shape

Every execution returns a report with exactly these sections:

- **What changed** — files touched and the change shape (added / rewritten / prepended / etc.).
- **How it was validated** — commands run and their relevant output (diff scopes, grep checks, etc.).
- **Anything deferred or surprising** — items pushed to a later packet, anomalies found, side-finds the owner should know about.
- **Ready for git checkpoint** — yes / no. "Yes" means the diff matches the plan, validations passed, and the owner can checkpoint with no follow-up changes from the agent first.
