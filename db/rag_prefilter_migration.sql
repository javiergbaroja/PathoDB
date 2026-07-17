-- PathoDB — RAG pre-filter migration
-- Adds `rag_meta`: one narrow row per report carrying the keys the agent filters
-- on, so it can "zoom in" on a slice of the corpus BEFORE semantic retrieval runs.
--
-- Run with (owner role — rag_meta references reports/submissions, and report
-- ownership is the OS user; reachable via peer auth on the DB node's socket):
--     psql -p 15432 -d pathodb -f db/rag_prefilter_migration.sql
--
-- Duration: ~minutes. Safe to re-run (idempotent). Readers are never blocked and
-- `report_embeddings` is NOT written to at all — see WHY A SIDE TABLE below.
--
-- =============================================================================
-- WHY A SIDE TABLE, AND NOT COLUMNS ON report_embeddings
-- =============================================================================
-- Denormalizing the keys onto report_embeddings looks better on paper: no join,
-- and pgvector >= 0.8 could then filter inside the HNSW scan. It was measured and
-- REJECTED, because populating them means UPDATEing all 2.55M rows, and:
--
--   * Postgres MVCC rewrites a row on UPDATE — the new version lands at a new
--     ctid. Every index entry points at a ctid, so EVERY index must be re-inserted
--     even though the indexed value is unchanged. That includes the 17 GB HNSW
--     index: the vectors never change, but the rows MOVE and the graph must follow.
--   * HOT updates would skip index maintenance, but need free space on the same
--     page. The table was bulk-loaded at fillfactor 100 and is packed solid —
--     measured n_tup_hot_upd = 0, i.e. not one update qualified.
--
--   Result: the backfill degenerates into rebuilding the HNSW graph one row at a
--   time (>7 min without committing a single 100k batch, ~3h+ projected), and
--   leaves the index bloated with 2.55M dead entries and degraded recall. Doing it
--   properly would mean DROPping and rebuilding the 17 GB index — a long window
--   with semantic search degraded to a sequential scan.
--
-- The side table costs none of that, and gives up little. Measured on this corpus:
--
--   unfiltered dense, warm cache ...........................    15 ms
--   one-year window, join + brute force over 98,967 chunks ..  1.2 s   (exact)
--   same, with the keys denormalized onto the row ...........  ~0.8 s  (exact)
--
-- Because for a NARROW filter the planner does not use HNSW at all — it exact-scans
-- the matching chunks, which is both faster and 100% recall. Denormalizing only
-- removed the join overhead (~30%), not an order of magnitude. The order-of-
-- magnitude win is having a filter AT ALL, and a join delivers that. Denormalizing
-- only truly wins for MID/BROAD scopes (100k-1M chunks) where HNSW+iterative scan
-- beats brute force; api/agent/rag.py handles those by widening the ANN pool and
-- post-filtering instead (see _BROAD_SCOPE_CHUNKS there).
--
-- If a full re-embed ever happens (model change -> slurm_embed.sh drops and
-- rebuilds HNSW anyway), denormalizing becomes free and can be revisited then.

-- =============================================================================
-- 1. TABLE
-- =============================================================================
-- Keyed by report_id (not submission_id): report_type varies per report, and
-- report_embeddings joins naturally on report_id. One row per report (~2.55M),
-- ~100 bytes each, so the whole table stays cache-resident — which is what keeps
-- the join cheap.
--
-- report_date     — from submissions.report_date, NOT reports.report_date:
--                   coverage is identical (2,541,941/2,554,052) and
--                   submissions.report_date is what query_cohort's
--                   submission_date_from/to filters, so the agent's two entry
--                   points agree. ~0.5% have no date; a date filter excludes them,
--                   which is correct — an undated report cannot be shown to fall
--                   inside a window.
-- topo_*          — DISTINCT across the submission's probes (a submission has
--                   several), hence arrays, matched with && (overlap).
--                   Descriptions AND codes are both kept because only 223 of the
--                   1,084 distinct probe topography codes resolve in the
--                   snomed_codes vocabulary — going through snomed_codes would
--                   silently miss ~80% of the data, so descriptions are the
--                   reliable filter and codes the precise one.
CREATE TABLE IF NOT EXISTS rag_meta (
    report_id         INTEGER PRIMARY KEY REFERENCES reports (id) ON DELETE CASCADE,
    submission_id     INTEGER NOT NULL,
    report_type       TEXT    NOT NULL,          -- 'macro' | 'microscopy'
    report_date       DATE,
    patient_id        INTEGER,
    malignancy_flag   BOOLEAN,
    topo_descriptions TEXT[]  NOT NULL DEFAULT '{}',
    snomed_topo_codes TEXT[]  NOT NULL DEFAULT '{}',
    refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. POPULATE  (set-based, one pass)
-- =============================================================================
-- Deliberately ONE statement, not a per-report loop. Aggregating probes per report
-- inline would re-aggregate each submission's probes ~4x (a submission has ~2
-- reports x ~2 chunks) and turn this into millions of random index probes over
-- network storage. A single hash aggregate + hash joins keeps it sequential.
INSERT INTO rag_meta (report_id, submission_id, report_type, report_date,
                      patient_id, malignancy_flag, topo_descriptions, snomed_topo_codes)
SELECT r.id, r.submission_id, r.report_type, s.report_date, s.patient_id,
       s.malignancy_flag, COALESCE(t.descs, '{}'), COALESCE(t.codes, '{}')
FROM reports r
JOIN submissions s ON s.id = r.submission_id
LEFT JOIN (
    SELECT p.submission_id,
           array_agg(DISTINCT p.topo_description)
               FILTER (WHERE p.topo_description IS NOT NULL) AS descs,
           array_agg(DISTINCT p.snomed_topo_code)
               FILTER (WHERE p.snomed_topo_code IS NOT NULL)  AS codes
    FROM probes p
    GROUP BY p.submission_id
) t ON t.submission_id = s.id
ON CONFLICT (report_id) DO UPDATE SET
    submission_id     = EXCLUDED.submission_id,
    report_type       = EXCLUDED.report_type,
    report_date       = EXCLUDED.report_date,
    patient_id        = EXCLUDED.patient_id,
    malignancy_flag   = EXCLUDED.malignancy_flag,
    topo_descriptions = EXCLUDED.topo_descriptions,
    snomed_topo_codes = EXCLUDED.snomed_topo_codes,
    refreshed_at      = now();

-- =============================================================================
-- 3. INDEXES
-- =============================================================================
-- Built AFTER the load. IF NOT EXISTS keeps a re-run cheap.
-- Date is the headline filter ("only 2024"); composite with report_type because
-- "microscopy reports from 2024" is the archetypal narrowing query and
-- report_type alone (2 values) is not worth an index.
CREATE INDEX IF NOT EXISTS idx_rag_meta_date_type   ON rag_meta (report_date, report_type);
CREATE INDEX IF NOT EXISTS idx_rag_meta_patient     ON rag_meta (patient_id);
CREATE INDEX IF NOT EXISTS idx_rag_meta_submission  ON rag_meta (submission_id);
-- GIN is what makes an organ filter index-backed (&& overlap).
CREATE INDEX IF NOT EXISTS idx_rag_meta_topo_desc   ON rag_meta USING GIN (topo_descriptions);
CREATE INDEX IF NOT EXISTS idx_rag_meta_topo_codes  ON rag_meta USING GIN (snomed_topo_codes);
-- malignancy_flag deliberately unindexed: 3 states over millions of rows is far
-- too low-cardinality to help, and it only ever refines an already-narrowed set.

-- Selectivity stats are what let the planner choose an exact scan of a narrow
-- scope over the HNSW index, so this is not optional.
ANALYZE rag_meta;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = current_setting('app.db_user', true)
    ) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON rag_meta TO %I;',
                       current_setting('app.db_user'));
    END IF;
END
$$;
