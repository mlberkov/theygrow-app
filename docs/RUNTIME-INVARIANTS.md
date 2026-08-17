# Runtime behavioral contract — theygrow-app

## Scope

This file documents the **runtime behavioral contract** that `theygrow-app` must satisfy from M2 onward, as packets that introduce running code land. Today it is fully **documented, not enforced** — no product code exists yet. As packets land, items move from documented to enforced; `INVARIANTS.md` tracks the enforcement artifacts.

`AGENTS.md` §2 (product invariants) and §4 (privacy precondition) are the **authoritative source for intent**. The items below are runtime restatements of that intent at the granularity the running system needs. Restatements that conflict with `AGENTS.md` §2 / §4 are bugs in this file and should be fixed here.

Enforcement targets follow the current M1-M5 ladder and are revised per-item as packets land. Packet-level scoping (`P{k}`) stays **TBD** until the enforcing packet is planned.

### Enforcement-status legend

- `Status: documented.` — the contract is written; nothing enforces it yet.
- `Enforcement begins: M{N}[ → M{M}].` — milestone where enforcement starts; if a span, the contract is built up across milestones.
- `Packet: TBD.` — the specific enforcing packet is assigned when that packet is planned.

## Closed corpus

Chat answers come **only** from the family memory (episodic store) and canon (skill descriptions and future canon content). No web, no model parametric knowledge.

- Intent source: `AGENTS.md` §2 "Closed corpus".
- Runtime contract: no retrieval, generation, or answer-surface path may consult an external network source or rely on the model's parametric knowledge for content; only the two grounded sources may be cited.
- Status: documented. Enforcement begins: M4 → M5. Packet: TBD.
- Rationale for the arc: M4 retrieval lift establishes the closed-corpus structure by dropping the donor engine's web and parametric routes; M5 grounding gate seals it on the chat surface.

## Grounding gate

A chat answer is produced only when retrieval has returned grounded segments from the closed corpus that cover the question. When no grounded answer is available, the gate must block generation rather than fall through to an ungrounded response.

- Intent source: `AGENTS.md` §2 "Honest degradation" + "Closed corpus".
- Runtime contract: the chat path checks grounded-coverage before generation; failed coverage routes to honest degradation, not to a synthesized answer.
- Status: documented. Enforcement begins: M5. Packet: TBD.

## Honest degradation

When the corpus does not contain a grounded answer, the system says so explicitly. It does not synthesize, paraphrase parametric knowledge, or hedge in a way that simulates an answer.

- Intent source: `AGENTS.md` §2 "Honest degradation".
- Runtime contract: degradation responses are explicit, distinct from answer responses, and observable as such on the answer surface.
- Status: documented. Enforcement begins: M5. Packet: TBD.

## Per-segment provenance

Every answer surface carries source attribution at the segment level — not just answer-level, not just citation list at the end.

- Intent source: `AGENTS.md` §2 "Per-segment provenance".
- Runtime contract: each answer segment is bound to its source (family-memory record or canon entry); the binding survives transport from retrieval through chat composition to the rendered surface.
- Status: documented. Enforcement begins: M3 → M5. Packet: TBD.
- Rationale for the arc: lineage is captured at `/export` import in M3 and at retrieval in M4; per-segment surfacing on answers lands at M5.

## Medical boundary

The product does not give medical advice. Health-adjacent surfaces — and red-flag prompts in particular — route to a medical-boundary response (specialist referral, not a generated diagnosis).

- Intent source: `AGENTS.md` §2 "Medical boundary".
- Runtime contract: a medical-boundary classifier (or rule layer) intercepts health-adjacent prompts before answer generation and emits the boundary response; generated diagnostic content is never produced on this path.
- Status: documented. Enforcement begins: M5. Packet: TBD.

## No child PII in telemetry or logs

Child names, diary texts, and birthdates never cross the running boundary into telemetry, logs, error tracking, or third-party services. This is a precondition, not a feature — it applies from the first byte of code in M2 onward.

- Intent source: `AGENTS.md` §4 "Privacy precondition".
- Runtime contract: every logging / telemetry / error-tracking / third-party surface either has no path to PII fields or redacts them at the boundary; tests assert that the precondition holds end-to-end.
- Status: enforced (forward guard). Enforcement begins: M2. Packet: M2-P2 — `api/theygrow_api/logging.py` (`PiiRedactionFilter`) + `api/tests/test_logging_redaction.py`; see `INVARIANTS.md` `M2-P2-INV-001`.
- Second contour, and it is the one that can hold live data today: **the device.** The Android channel gained a store that holds a child's name and birthdate at L1-P2/L1-P4, a path for the family's existing history to reach it at DIA-P1, and diary text a parent writes at DIA-P3; its log surface is `logcat`, not a server logger. Enforced by `INVARIANTS.md` `DIA-P5-INV-001` — `native/capacitor.config.json`'s `android.loggingBehavior: "none"`, pinned statically on every push, with the device half carried by `DeviceLogTest` and **observed** on `android-instrumented` run **32074105863**, where the app's whole process wrote no family text and no plugin-argument trace at all.
- Coverage note: M2-P2 establishes the redaction *mechanism* and telemetry discipline from byte one, on the **server** contour, whose live child-PII paths still arrive with M3 → M5. *(Corrected in DIA-P5: this note read "No live child-PII data path exists yet (data arrives at M3)" without qualification, which reads as a statement about the whole system and stopped being one when the device contour above gained a store. Whether any real family record had reached a device before this packet is not something this repository records; what it does record is that the path existed and that the Capacitor bridge was writing whatever crossed it to logcat. A restatement of §4 that names only the server contour is a bug in this file by its own Scope paragraph, and this is the fix.)*
