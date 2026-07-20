-- =============================================================================
-- PathoDB — Role-based grants
-- File: db/grants.sql
--
-- Creates a single shared role `pathodb_researcher` that holds all table
-- privileges needed by the application.  Every DB login user (app users,
-- future analysts, etc.) simply inherits this role — no per-user re-grants.
--
-- USAGE
--   # One-time setup (and safe to re-run — all statements are idempotent):
--   psql "$DATABASE_URL" -f db/grants.sql
--
--   # To grant the role to an additional login user afterwards:
--   psql "$DATABASE_URL" -c "GRANT pathodb_researcher TO <username>;"
--
-- The FastAPI auth router does this automatically for every new account
-- (see api/routers/auth.py — register() and create_user()).
-- =============================================================================

-- ── Create the shared role (no LOGIN, no password — purely a privilege bundle)

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pathodb_researcher') THEN
        CREATE ROLE pathodb_researcher NOLOGIN NOINHERIT;
        RAISE NOTICE 'Created role pathodb_researcher';
    ELSE
        RAISE NOTICE 'Role pathodb_researcher already exists — skipping CREATE';
    END IF;
END
$$;

-- ── Clinical core ─────────────────────────────────────────────────────────────
-- patients / submissions / reports : UPDATE only (INSERT/DELETE = ETL / admin)
-- probes / blocks                  : full CRUD (researchers curate via UI)
-- snomed_codes                     : SELECT only (controlled vocabulary)

GRANT SELECT, UPDATE                 ON patients     TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE patients_id_seq     TO pathodb_researcher;

GRANT SELECT, UPDATE                 ON submissions  TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE submissions_id_seq  TO pathodb_researcher;

GRANT SELECT, UPDATE                 ON reports      TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE reports_id_seq      TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON probes       TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE probes_id_seq       TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON blocks       TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE blocks_id_seq       TO pathodb_researcher;

GRANT SELECT                         ON snomed_codes TO pathodb_researcher;
-- TEXT primary key on snomed_codes — no sequence.
-- Uncomment to allow admin API to manage the vocabulary via app user:
-- GRANT INSERT, UPDATE, DELETE ON snomed_codes TO pathodb_researcher;

-- data_sources : SELECT only (provenance vocabulary; ETL/admin curates rows).
-- The app connects as jgbaroja (role is NOINHERIT) so grant it directly too.
GRANT SELECT                         ON data_sources TO pathodb_researcher;
GRANT SELECT                         ON data_sources TO jgbaroja;

-- ── Slide / scan ──────────────────────────────────────────────────────────────
-- scans              : full CRUD (register, reassign block, delete)
-- stains             : INSERT included — scanner auto-create runs as app user
-- slide_registrations: full CRUD (researchers create/edit/delete alignments)

GRANT SELECT, INSERT, UPDATE, DELETE ON scans               TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE scans_id_seq                TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON stains              TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE stains_id_seq               TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON slide_registrations TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE slide_registrations_id_seq  TO pathodb_researcher;

-- ── Research workspace ────────────────────────────────────────────────────────
-- Full CRUD on all workspace tables.
-- Row-level ownership checks (own cohort, own project, etc.) are enforced
-- in FastAPI routers — not at the DB privilege layer.

GRANT SELECT, INSERT, UPDATE, DELETE ON cohorts        TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE cohorts_id_seq         TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON projects       TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE projects_id_seq        TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON project_scans  TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE project_scans_id_seq   TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON project_shares TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE project_shares_id_seq  TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON annotations    TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE annotations_id_seq     TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON tma_cores      TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE tma_cores_id_seq       TO pathodb_researcher;

-- ── AI / jobs ─────────────────────────────────────────────────────────────────
-- analysis_jobs : full CRUD (submit, watcher status-sync, cancel/delete)
-- chat_session  : full CRUD (user-owned sessions)
-- chat_message  : INSERT only — append-only; row deletes cascade from session
-- etl_jobs      : full CRUD here; router enforces admin-only in application code

GRANT SELECT, INSERT, UPDATE, DELETE ON analysis_jobs TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE analysis_jobs_id_seq  TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_session  TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE chat_session_id_seq   TO pathodb_researcher;

GRANT SELECT, INSERT                 ON chat_message  TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE chat_message_id_seq   TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON etl_jobs      TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE etl_jobs_id_seq       TO pathodb_researcher;

-- ── Audit / system ────────────────────────────────────────────────────────────
-- agent_audit       : INSERT only (append-only audit trail)
-- report_embeddings : full CRUD — embed worker connects as app user
-- users             : SELECT only; user management runs as DB owner

GRANT SELECT, INSERT                 ON agent_audit       TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE agent_audit_id_seq        TO pathodb_researcher;

GRANT SELECT, INSERT, UPDATE, DELETE ON report_embeddings TO pathodb_researcher;
GRANT USAGE, SELECT ON SEQUENCE report_embeddings_id_seq  TO pathodb_researcher;

GRANT SELECT                         ON users             TO pathodb_researcher;
-- Uncomment if admin user-management routes connect as the app DB user:
-- GRANT INSERT, UPDATE ON users           TO pathodb_researcher;
-- GRANT USAGE, SELECT ON SEQUENCE users_id_seq TO pathodb_researcher;

-- ── Grant the role to existing login users ────────────────────────────────────
-- Add every DB login user that the application connects as.
-- New users are granted the role automatically by the FastAPI auth router.

GRANT pathodb_researcher TO jgbaroja;

\echo 'grants.sql: role pathodb_researcher configured and granted to jgbaroja.'
\echo 'New accounts receive this role automatically via the auth router.'