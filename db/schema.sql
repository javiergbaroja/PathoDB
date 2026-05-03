-- PathoDB — PostgreSQL Schema
-- Run with: psql $DATABASE_URL -f db/schema.sql
-- All CREATE statements use IF NOT EXISTS — safe to re-run on existing databases.

-- =============================================================================
-- USERS
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL          PRIMARY KEY,
    username      TEXT            NOT NULL UNIQUE,
    email         TEXT            NOT NULL UNIQUE,
    password_hash TEXT            NOT NULL,
    role          TEXT            NOT NULL DEFAULT 'researcher'
                                  CHECK (role IN ('admin', 'researcher', 'scanner')),
    is_active     BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);

-- =============================================================================
-- PATIENTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS patients (
    id            SERIAL          PRIMARY KEY,
    patient_code  TEXT            NOT NULL UNIQUE,
    date_of_birth DATE,
    sex           TEXT            CHECK (sex IN ('M', 'F', 'O', NULL)),
    created_at    TIMESTAMPTZ     NOT NULL DEFAULT now()
);

ALTER TABLE patients
ADD COLUMN summary_text TEXT,
ADD COLUMN summary_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_patients_code ON patients (patient_code);

-- =============================================================================
-- SUBMISSIONS
-- =============================================================================
CREATE TABLE IF NOT EXISTS submissions (
    id                SERIAL      PRIMARY KEY,
    patient_id        INTEGER     NOT NULL REFERENCES patients (id),
    lis_submission_id TEXT        NOT NULL UNIQUE,
    report_date       DATE,
    malignancy_flag   BOOLEAN,
    consent           TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_submissions_patient_id
    ON submissions (patient_id);
CREATE INDEX IF NOT EXISTS idx_submissions_lis_id
    ON submissions (lis_submission_id);

-- =============================================================================
-- REPORTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS reports (
    id            SERIAL      PRIMARY KEY,
    submission_id INTEGER     NOT NULL REFERENCES submissions (id),
    report_type   TEXT        NOT NULL CHECK (report_type IN ('macro', 'microscopy')),
    report_text   TEXT,
    report_date   DATE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, report_type)
);

CREATE INDEX IF NOT EXISTS idx_reports_submission_id ON reports (submission_id);

-- =============================================================================
-- PROBES
-- =============================================================================
CREATE TABLE IF NOT EXISTS probes (
    id                  SERIAL      PRIMARY KEY,
    submission_id       INTEGER     NOT NULL REFERENCES submissions (id),
    lis_probe_id        TEXT        NOT NULL,
    submission_type     TEXT,
    snomed_topo_code    TEXT,
    topo_description    TEXT,
    location_additional TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (submission_id, lis_probe_id)
);

CREATE INDEX IF NOT EXISTS idx_probes_submission_id ON probes (submission_id);
CREATE INDEX IF NOT EXISTS idx_probes_snomed ON probes (snomed_topo_code);

-- =============================================================================
-- BLOCKS
-- =============================================================================
CREATE TABLE IF NOT EXISTS blocks (
    id             SERIAL      PRIMARY KEY,
    probe_id       INTEGER     NOT NULL REFERENCES probes (id),
    block_label    TEXT        NOT NULL,
    block_sequence INTEGER,
    block_info     TEXT,
    tissue_count   INTEGER,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (probe_id, block_label)
);

CREATE INDEX IF NOT EXISTS idx_blocks_probe_id ON blocks (probe_id);

-- =============================================================================
-- STAINS
-- =============================================================================
CREATE TABLE IF NOT EXISTS stains (
    id             SERIAL      PRIMARY KEY,
    stain_name     TEXT        NOT NULL UNIQUE,
    stain_category TEXT        NOT NULL DEFAULT 'other'
                               CHECK (stain_category IN ('HE', 'IHC', 'special_stain', 'FISH', 'other')),
    aliases        TEXT[]      NOT NULL DEFAULT '{}',
    needs_review   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- SCANS
-- =============================================================================
CREATE TABLE IF NOT EXISTS scans (
    id            SERIAL        PRIMARY KEY,
    block_id      INTEGER       NOT NULL REFERENCES blocks (id),
    stain_id      INTEGER       NOT NULL REFERENCES stains (id),
    file_path     TEXT          NOT NULL UNIQUE,
    file_format   TEXT,
    magnification NUMERIC(4,1),
    registered_by INTEGER       REFERENCES users (id),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scans_block_id  ON scans (block_id);
CREATE INDEX IF NOT EXISTS idx_scans_stain_id  ON scans (stain_id);
CREATE INDEX IF NOT EXISTS idx_scans_format    ON scans (file_format);

-- =============================================================================
-- COHORTS
-- =============================================================================
CREATE TABLE IF NOT EXISTS cohorts (
    id           SERIAL      PRIMARY KEY,
    user_id      INTEGER     NOT NULL REFERENCES users (id),
    name         TEXT        NOT NULL,
    description  TEXT,
    filter_json  JSONB       NOT NULL,
    result_count INTEGER,
    last_run_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cohorts_user_id ON cohorts (user_id);

-- =============================================================================
-- REPORT EMBEDDINGS  (Phase 2 — RAG; skipped if pgvector not installed)
-- =============================================================================
-- CREATE EXTENSION IF NOT EXISTS vector;
--
-- CREATE TABLE IF NOT EXISTS report_embeddings (
--     id         SERIAL  PRIMARY KEY,
--     report_id  INTEGER NOT NULL REFERENCES reports (id),
--     chunk_text TEXT    NOT NULL,
--     embedding  vector(768),
--     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
-- );
-- CREATE INDEX IF NOT EXISTS idx_report_embeddings_report_id
--     ON report_embeddings (report_id);

-- =============================================================================
-- ANALYSIS JOBS
-- Records every DL model inference job submitted to the HPC via sbatch.
-- status transitions: queued → running → done | failed | cancelled
-- result_path points to the NFS directory where the model writes its output.
-- progress is 0-100, updated by polling a progress.json sidecar file.
-- =============================================================================
CREATE TABLE IF NOT EXISTS analysis_jobs (
    id              SERIAL          PRIMARY KEY,
    scan_id         INTEGER         NOT NULL REFERENCES scans (id),
    model_id        TEXT            NOT NULL,
    slurm_job_id    INTEGER,                            -- NULL until sbatch returns
    status          TEXT            NOT NULL DEFAULT 'queued'
                                    CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    scope           TEXT            NOT NULL DEFAULT 'whole_slide'
                                    CHECK (scope IN ('whole_slide', 'visible_region', 'roi')),
    params_json     JSONB           NOT NULL DEFAULT '{}',
    roi_json        JSONB,                              -- {x0,y0,x1,y1} in slide coords, NULL unless scope='roi'
    result_path     TEXT,                               -- absolute path to result directory on NFS
    progress        INTEGER         NOT NULL DEFAULT 0
                                    CHECK (progress >= 0 AND progress <= 100),
    error_message   TEXT,                               -- populated on failure
    submitted_by    INTEGER         REFERENCES users (id),
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_scan_id
    ON analysis_jobs (scan_id);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status
    ON analysis_jobs (status);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_slurm_job_id
    ON analysis_jobs (slurm_job_id)
    WHERE slurm_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS projects (
    id           SERIAL      PRIMARY KEY,
    owner_id     INTEGER     NOT NULL REFERENCES users (id),
    name         TEXT        NOT NULL,
    description  TEXT,
    project_type TEXT        NOT NULL CHECK (project_type IN ('cell_detection','region_annotation')),
    classes      JSONB       NOT NULL DEFAULT '[]',
    source_type  TEXT        NOT NULL CHECK (source_type IN ('cohort','file_import')),
    cohort_id    INTEGER     REFERENCES cohorts (id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id);
 
CREATE TABLE IF NOT EXISTS project_scans (
    id         SERIAL      PRIMARY KEY,
    project_id INTEGER     NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    scan_id    INTEGER     NOT NULL REFERENCES scans (id),
    sort_order INTEGER     NOT NULL DEFAULT 0,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, scan_id)
);
CREATE INDEX IF NOT EXISTS idx_project_scans_project ON project_scans (project_id, sort_order);
 
CREATE TABLE IF NOT EXISTS project_shares (
    id                  SERIAL      PRIMARY KEY,
    project_id          INTEGER     NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    shared_with_user_id INTEGER     NOT NULL REFERENCES users (id),
    access_level        TEXT        NOT NULL DEFAULT 'read'
                                    CHECK (access_level IN ('read','edit')),
    shared_by           INTEGER     REFERENCES users (id),
    shared_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, shared_with_user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares (project_id);
CREATE INDEX IF NOT EXISTS idx_project_shares_user    ON project_shares (shared_with_user_id);
 
-- One row per annotation. geometry JSONB stores type-specific data:
--   point:           {x, y}
--   rectangle:       {x, y, width, height, rotation}
--   ellipse:         {cx, cy, rx, ry, rotation}
--   polygon / brush: {points: [{x,y}, ...]}
-- bbox_* pre-computed for fast spatial range queries without PostGIS.
CREATE TABLE IF NOT EXISTS annotations (
    id              SERIAL      PRIMARY KEY,
    project_id      INTEGER     NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    scan_id         INTEGER     NOT NULL REFERENCES scans (id),
    created_by      INTEGER     REFERENCES users (id),
    class_id        TEXT,
    class_name      TEXT,
    annotation_type TEXT        NOT NULL
                                CHECK (annotation_type IN ('polygon','rectangle','ellipse','point','brush')),
    bbox_x          FLOAT       NOT NULL DEFAULT 0,
    bbox_y          FLOAT       NOT NULL DEFAULT 0,
    bbox_w          FLOAT       NOT NULL DEFAULT 0,
    bbox_h          FLOAT       NOT NULL DEFAULT 0,
    geometry        JSONB       NOT NULL DEFAULT '{}',
    area_px         FLOAT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_annotations_project_scan ON annotations (project_id, scan_id);
CREATE INDEX IF NOT EXISTS idx_annotations_scan         ON annotations (scan_id);
CREATE INDEX IF NOT EXISTS idx_annotations_project      ON annotations (project_id);
