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
knowledge vault, **outside this repository**. You read them only through the
read-only clone (see **Vault clone (read-only)**), pull-first; when that cache
is unavailable you cannot read them at all. No per-milestone spec files exist
in the repo. Do not ask the owner to recite vault content during planning.

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
- **Escalations are delivered inside the finished plan, in its Escalations
  section. Do not use the interactive question tool to raise them.** A
  question that ends your turn without a plan attached is a process
  violation regardless of how good the question is — the rule is about the
  channel, not about restraint.
- Where an escalation would change the design, describe **both branches in
  the plan** and mark which one you would take, so review can accept or
  redirect in one round.
- If you nonetheless asked interactively and received an answer, that
  answer is **provisional and is not an owner decision**. Record the
  question, the answer, and the fact that it arrived outside the canonical
  channel in **Decisions & assumptions**; plan review checks those entries
  separately and may re-open them.
- The reason the channel matters: the interactive picker gives the owner no
  way to write text, so any button press is a forced move rather than a
  judgement. Correctness of the channel is the agent's and the
  orchestrator's responsibility, never the owner's memory for the right
  phrasing.

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
  manual checks), and for every claim about **runtime** behaviour the test
  that executes it (`AGENTS.md` §11). A packet with no runtime claim states
  that outright — "no runtime claims this packet" — rather than leaving the
  section silent about them.

## No autonomous git

- Never run `git commit`, `git push`, `git checkout -b`, `git rebase`, `git reset`, `git stash`, `git tag`, or any history-altering command on your own.
- Never open, edit, comment on, or close a pull request on your own.
- Produce an execution report (see below) and let the owner cut the commit and open the PR.

## Vault clone (read-only)

The owner's knowledge vault is cloned locally at `~/vaults/theygrow-vault` as a
**read-only reading cache** (`ADR-049`). The clone is never a source of truth of
its own: the vault itself — and its decisions `ADR-049`, `ADR-045` — stays
authoritative, and clone files are never editable project files.

- **Pull first, then read.** Any session that reads vault documentation begins
  with `git -C ~/vaults/theygrow-vault pull --ff-only` **before** the first
  read. Reading without a fresh pull is reading a stale cache.
- **Never write into the clone.** No edits, no new files, no deletions,
  anywhere under it.
- **Never copy vault content into this repository**, whole or in part.
  Reference it by path instead — `see vault: 04-decisions/adr-049-....md`.
- **Clean-tree detector**, run by you in every session that used the clone:
  `git -C ~/vaults/theygrow-vault status --short` must print nothing. Any
  output means the read-only contract was violated: stop, do **not** "fix" it
  by committing and do not discard it silently, report to the owner with the
  output.
- **Git role split** (`ADR-045` p.3, narrowed by `ADR-049` p.3). `clone` and
  `pull` inside the vault clone are yours to run. Every other git operation in
  the vault — `commit`, `push`, anything history-altering — stays owner-only.
  Your git rights in **this** repository are unchanged: `No autonomous git`
  above still governs.
- **Fail closed.** If the pull fails — auth error, expired token, no network —
  do not work around it: no fallback to remembered vault content, no use of the
  ambient `GIT_ASKPASS` credential, no switching the remote to SSH, and no
  credentials entered into any prompt or auth window. A prompt appearing at all
  is itself the signal that the clone's own local read-only credential helper
  lost; cancel it and report it. Say plainly that the vault cache is
  unavailable, continue only on what the handoff itself provides, and flag the
  gap.
- **Lock probe**, after the owner renews the token:
  `env -u GIT_ASKPASS GIT_TERMINAL_PROMPT=0 git -C ~/vaults/theygrow-vault push --dry-run origin HEAD:refs/heads/lock-probe`.
  Expected: `403`, write access not granted. Exit code `0` means the read-only
  lock is gone — report that. This is the only push-shaped command you may run,
  and only with `--dry-run`.
- **Graph artifacts** (`graph.json`, `graph.html`, `GRAPH_REPORT.md`) are
  generated, never committed; this repository ignores them (`.gitignore`).

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
- **How it was validated** — commands run and their relevant output (diff scopes, grep checks, etc.); each runtime claim named with the test that executed it, and source/markup scans labelled as the static evidence they are (`AGENTS.md` §11).
- **Anything deferred or surprising** — items pushed to a later packet, anomalies found, side-finds the owner should know about.
- **Ready for git checkpoint** — yes / no. "Yes" means the diff matches the plan, validations passed, and the owner can checkpoint with no follow-up changes from the agent first.
