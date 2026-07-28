# Synthetic staging corpus (A2-P2)

The seed input for the L2 staging contour. Loaded by `theygrow-seed-staging`
(`api/theygrow_api/seed_staging.py`), which refuses to run against anything but the
staging database.

## Provenance — read this first

**Every line in this corpus is invented.** No record is derived from, transformed from,
sampled from, or inspired by any real family, child, or production row. There is no
anonymization step here to get wrong, because there was never real data to anonymize.

This is the milestone's hardest rule (ADR-020 / ADR-011 / ADR-014) and it is the one rule
here that **no test can prove** — a test can check that text exists, never that it was
authored rather than derived. It is held by authorship discipline and by review of this
file, which is why it is stated at the top and deliberately **not** listed in
`docs/INVARIANTS.md` (that file is enforced-only, `AGENTS.md` §10). If this corpus ever
grows, the same rule binds the addition.

The corpus is excluded from the runtime image: `api/Dockerfile` copies only
`pyproject.toml` and `theygrow_api/`, and `api/.dockerignore` lists `corpus/` as
defense-in-depth. It is not package data and is absent from an installed wheel — hence
`--corpus` being required and default-less.

## Layout

```
export-v1/comm-staging-alpha.json    100 records — the primary community
export-v1/comm-staging-beta.json      24 records — the isolation counterpart
export-v1/comm-staging-gamma.json     12 records — thin, off-topic
concepts.json                         concept lexicon for the local embedder
```

One `/export` v1 file **per community**, matching what the engine actually emits: the
envelope's `scope.community_id` is a single community. The importer would accept a mixed
file (it does not cross-check records against the scope), but a corpus that misrepresents
the wire contract is a poor fixture for an eval meant to prove production-shaped
behaviour.

## Composition

Measured, not estimated — `api/tests/test_seed_staging.py` asserts each of these against
the committed files, so the table cannot silently drift from the corpus.

| Property | Value |
| --- | --- |
| Source messages | 136 (alpha 100 / beta 24 / gamma 12) |
| Derived chunks | 295 (alpha 240 / beta 43 / gamma 12) |
| `note` / `draft` | 109 / 27 — 80.1% / 19.9% |
| Communities | 3 |
| Date span | 2024-06-15 … 2026-06-11 (726 days ≈ 23.9 months) |
| Date-led / fallback-dated | 101 / 35 — 74.3% / 25.7% |
| Frequent-token chunks | 66 eligible alpha chunks carry the exact token `сон` |
| Adversarial / no-evidence | 32 records ≈ 23.5% |

### Why these numbers

**The frequent-token count is the binding constraint on volume.** `FTS_CONFIG` is
`'simple'` — no Russian stemming — so a lexical query reaches only the identical surface
form. For `candidate_k = 50` to actually truncate anything, more than 50 *eligible*
chunks must carry one literal token; 66 gives headroom and makes `top_k = 10` truncate a
real surplus rather than returning everything that matched. Everything else in the table
follows from covering the case classes below at that depth.

Recorded as **revisitable** (`L2-DL-002`), closing the ADR-020 residual open question on
corpus volume for A2. Revisit trigger: if P3 finds a case class it cannot author, grow
that class — not the corpus as a whole.

## Case classes this corpus supports (P3 authors the queries)

| Class | What in the corpus carries it |
| --- | --- |
| Lexical hit | `сон` in 66 eligible alpha chunks — a plain FTS match with real competition |
| Semantic-only hit | Reserved probe terms (below): in the lexicon, absent from all text, so the sparse leg cannot match and only the dense leg can |
| No evidence | `comm-staging-gamma` is entirely off-topic household texture; a developmental query there must degrade with zero provider calls |
| Ambiguous | `sm-alpha-0067` and `sm-alpha-0068` each claim a *first* utterance of the same word on different dates |
| Cross-community isolation | `Первый раз скатился с горки сам, без поддержки.` appears verbatim in **both** alpha and beta; an alpha-scoped query returning beta's copy is a leak |
| Draft-unreachable | `аквариум` and `телескоп` occur **only** in `draft` records — a query for either must return nothing |

### Reserved probe terms

`дрёма`, `жар`, `лепет`, `равновесие`, `каприз`.

Each is mapped to a concept in `concepts.json` and appears in **no** corpus text. A query
using one is therefore lexically unreachable but semantically adjacent to chunks that use
the concept's other surface forms (`сон`, `температура`, `речь`, …). The test suite
asserts both halves — present in the lexicon, absent from every chunk — because the
semantic-only case class silently stops being a semantic-only case the moment one of
these words leaks into a diary line.

## Both parser paths

`parse_note` recovers an event date only when the first non-empty line is a bare ISO
date; otherwise the derivation falls back to `created_at` and every line becomes a chunk.
Both paths carry real material here (101 date-led / 35 fallback), and date-led records
are authored with `created_at` one day *after* the event date, so `valid_at` recovery is
observable rather than a no-op.

One deliberate edge case: `sm-alpha-0031` leads with a compact `YYYYMMDD` line, which
`date.fromisoformat` accepts on Python 3.12. It is in the corpus so the behaviour is
recorded and intentional rather than discovered later as a surprise.

## What the vectors do and do not mean

Embeddings are produced in-perimeter by `LocalDeterministicEmbeddingProvider` from
`concepts.json` — zero third-party calls, both clearance flags unset. Similarity here is
*authored*, not learned: two chunks are close when they share concept-mapped tokens.

That is enough to exercise the dense leg's plumbing end to end and to make a
semantic-only case authorable. It is **not** evidence about real embedder recall or
semantic quality — nothing measured against this corpus transfers to the production
embedder.
