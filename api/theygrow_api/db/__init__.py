"""Core-store seam (ADR-008): one managed PostgreSQL as the single source of truth.

M3-P1 lands the episodic *source* layer — the raw, pre-enrichment ``SourceMessage``
rows imported from the engine's ``/export`` surface — plus the SQLAlchemy engine
factory that opens the first real DB connection from product code. The importer
itself is M3-P2; embedding/vector population + indexing are M4.
"""
