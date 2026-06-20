# CLAUDE.md — Claude Code operational overlay

This file extends `AGENTS.md` with operational rules specific to **Claude Code** (the CLI agent). On any conflict between the two documents:

- `AGENTS.md` wins for product, architecture, scope, and invariants.
- `CLAUDE.md` wins for Claude-Code operational specifics (Plan Mode, tool use, reporting, git posture).

`CLAUDE.md` does **not** restate `AGENTS.md`. Read both.

## Plan-Mode-first

- Any non-trivial change starts with a written plan in Plan Mode.
- Execute only after explicit owner go-ahead. Implicit approval is not approval.
- Plans are bounded to one packet. Do not pre-plan the next packet inside the current one.

## No autonomous git

- Never run `git commit`, `git push`, `git checkout -b`, `git rebase`, `git reset`, `git stash`, `git tag`, or any history-altering command on your own.
- Never open, edit, comment on, or close a pull request on your own.
- Produce an execution report (see below) and let the owner cut the commit and open the PR.

## Packet discipline

- Work exactly one bounded packet at a time.
- Do not chain packets. When the current packet's scope is satisfied, stop — even if the next packet's work looks small.
- Forks that touch scope, contracts, naming, or owner-level decisions surface as questions rather than guesses.
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
