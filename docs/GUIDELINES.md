# Guideline RAG (CAP / ICCR reporting standards)

A **third retrieval namespace** for the agent (alongside report RAG and the
doc/glossary knowledge index), added for audit item #5. It lets `guideline_search`
ground staging/grading thresholds and required reporting elements in authoritative
external standards instead of the model reciting them from memory.

- **Corpus**: CAP cancer protocols + ICCR datasets, as `.docx`, under the
  directories in `settings.guideline_dirs`.
- **Table**: `guideline_chunks` (see `db/schema.sql`) — a pgvector namespace
  parallel to `report_embeddings` (HNSW + FTS GIN, 1024-dim `bge-m3`).
- **Retrieval**: `api/agent/guideline_rag.py` (hybrid dense + lexical + optional
  rerank, reusing the report-RAG helpers). Tool: `guideline_search(query, organ,
  top_k)` in `api/agent/tools.py`.

## Licensing (read first)

Point `guideline_dirs` **only** at internally licensed copies of these documents.
CAP protocols and ICCR datasets are copyrighted; this feature indexes a locally
held, licensed corpus for internal research grounding — it does not redistribute
them. The tool surfaces short cited excerpts with a source + version stamp.

## Ingestion

Run on a node with the DB reachable and (ideally) a GPU, in the `langchain` env:

```bash
python api/workers/embed_guidelines.py --source all      # CAP + ICCR
python api/workers/embed_guidelines.py --source cap --limit 5   # smoke test
python api/workers/embed_guidelines.py --reembed         # force re-embed all
```

Prereq: apply `db/schema.sql` (the `guideline_chunks` table + grants) first. The
worker warms up the embedder, asserts its dim matches `settings.embedding_dim`,
then extracts each `.docx` — walking the body **in document order** so both
paragraphs and tables are captured. Two structure-aware behaviors matter:

- **ICCR** datasets are tables where **each row is one reporting element**. The
  worker parses the reporting table row-by-row: the element name becomes the chunk
  `section`, and the chunk text carries its **Core / Non-core status**, values,
  commentary and implementation notes — so "is LVI a core element for lung?"
  retrieves the `LYMPHOVASCULAR INVASION` element that states `[Core]`.
- **CAP** protocols nest ALL-CAPS sections (`SPECIMEN`, `TUMOR`) → bold
  sub-elements (`Tumor Site`) → `___` options. The worker tracks that two-level
  hierarchy into a `SPECIMEN — Tumor Site` section label.

Re-run with `--reembed` (or `REEMBED=1 sbatch …`) after changing the extraction
logic, since section labels live in the chunk text but not the change-detection
`content_hash`.

## Metadata, versioning & staleness

- `organ` and `title` come from the **inline document title** (authoritative), not
  the cryptic filename — e.g. `ICCR-CXC-…` → organ "Colorectal Cancer". The
  filename supplies `specimen_type`, `version`, and a stable `doc_slug`.
- `doc_slug` **excludes the version**, so re-ingesting a newer edition of the same
  protocol **replaces** the prior rows ("latest only") rather than piling up stale
  duplicates. `version` / `doc_date` are kept as columns and shown in citations, so
  answers are stamped ("per CAP Colorectal v4.4.0.1").
- Re-ingestion is idempotent via a per-document `content_hash`: unchanged docs are
  skipped; a changed hash on the same `doc_slug` triggers a delete-and-replace.

To refresh the corpus when new editions are published, drop the new `.docx` into
the guideline dir and re-run the worker.

## Namespaces (keep distinct)

- `guideline_search` — external standards (this doc).
- `semantic_report_search` — a patient's own report text.
- `search_documentation` — PathoDB platform / glossary terms.

Guideline excerpts are **not** injection-fenced (unlike patient report text): they
are trusted, curated reference the model is meant to apply.
