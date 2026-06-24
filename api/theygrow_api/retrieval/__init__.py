"""Retrieval seam lifted from the engine (``memory_rag``; ADR-005 §7).

Code donor only — the engine stays OUT of the live perimeter (AGENTS.md §3 /
ADR-005). M4-P1 lands ONE leg: the sparse (PostgreSQL FTS) candidate query. The
dense (pgvector) leg is M4-P2 (gated: provider/model + dimension, fork a);
Reciprocal Rank Fusion of the two legs and the episodic-eligibility filter are
M4-P3 (fork a + fork b). There is no chat surface here (M5).
"""
