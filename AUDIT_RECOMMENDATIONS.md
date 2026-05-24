# PathoDB — Audit Recommendations

This document tracks issues found during a full-repository audit. Items are
marked **FIXED** (applied directly across the audit commits) or **OPEN**
(left for a product/operational decision). Fixes were made when low-risk and
unambiguous.

Severity legend: **P1** data integrity / security · **P2** correctness / reliability ·
**P3** performance · **P4** UX / consistency.

---

## Fixed

### Security / data integrity (P1)
- **Missing auth on `GET /summarize/patient/{id}/summary`** — returned a
  patient's AI clinical summary (PHI) unauthenticated. Now requires a user.
- **TMA IDOR** (`api/routers/tmas.py`) — `get_tma`, `get_tma_cores`,
  `upload_tma_cores`, `upload_tma_scans` didn't check ownership, so any user could
  read or overwrite another user's TMA. Now owner-scoped via `_get_owned_tma`.
- **Scanner API-key auth broken** (`api/auth.py`) — the bearer scheme
  (`auto_error=True`) rejected key-only requests before the key was checked.
  Switched to a non-erroring scheme and constant-time comparison.
- **`custom_list` projects violated a DB CHECK constraint** (`db/schema.sql`) —
  added a migration widening `projects.source_type`. **Re-run `db/schema.sql`** on
  existing databases.
- **Annotation provenance wiped on every save** (`api/routers/projects.py`) —
  `PUT .../annotations` deleted and re-inserted all rows, resetting `created_by`
  and `created_at` on every auto-save. Now reconciles by id: existing rows are
  updated in place (preserving author/created_at, bumping `updated_at` only when
  content actually changed), missing rows deleted, new rows inserted. The client
  already sends stable ids; `BulkAnnotationItem` now captures them.
- **TMA scan upload partial writes + sort_order** (`api/routers/tmas.py`) —
  scans were committed per-row and an unregistered stain raised mid-loop, leaving
  partial state; all new links also shared one `sort_order`. Now validates all
  stains up front, applies everything in one transaction with `flush()`, and
  increments `sort_order` per row.
- **Unrestricted batch `output_directory`** (`api/routers/analysis.py`) — the
  user-supplied path was `mkdir`/`rmtree`'d with no checks. Added
  `_validate_output_directory`: with `analysis_output_base_dirs` configured the
  path must resolve inside an allow-listed base (recommended for production);
  otherwise it must be absolute and outside protected system roots. Purge now uses
  the same policy (`_is_deletable_output_dir`) and refuses to delete arbitrary
  paths read from `batch_context.json`.

### Correctness / reliability (P2)
- **Duplicate unreachable `DELETE /analysis/jobs/{id}` route** — removed.
- **Magnification mis-classification** (`api/routers/slides.py`) — `if`→`elif`
  so the 80× objective bucket is reachable.
- **Assistant could crash app startup** (`api/routers/assistant.py`) — `langchain`
  (absent from requirements) and the DB engine were created at import; now lazy
  with graceful `503`s.
- **Annotations not validated against project membership** — `create`, `bulk_save`,
  and `import` now call `_ensure_scan_in_project`, so edits can't target a scan
  outside the project.
- **Slide-tile tokens accepted any JWT** (`api/routers/slides.py`) — `_auth_token`
  now requires `type == "access"`, so a refresh token can't fetch imagery.
  (Verified the frontend only ever uses the access token for tile URLs.)

### Performance (P3)
- **`GET /analysis/jobs` ran `squeue` per job** — replaced N subprocess calls with
  a single batched `squeue -j id1,id2,...` (`_slurm_states_batch`); `_sync_job_status`
  accepts a prefetched state. A failed/absent SLURM query no longer infers job
  completion.
- **N+1 in `GET /projects/{id}/scans`** — replaced per-scan `db.get()` lookups with
  a single outer-joined query (Block/Probe/Submission outer-joined for TMA scans).

---

## Open (left for a decision)

### P1 — Open self-registration *(intentionally deferred per maintainer request)*
`POST /auth/register` lets anyone create a `researcher` account with access to all
patient/clinical data. Not changed at the maintainer's request. If exposed beyond a
trusted network, consider admin approval or email-domain gating later.

### P4 — Terminology / model overloading
- `Project` backs both annotation projects **and** TMAs (`project_type='tma'`), with
  two routers applying different access rules to the same table. Consider a shared
  access helper or a clearer sub-type boundary.
- "Scan" (DB) vs "slide"/"WSI" (UI/viewer/AI) name the same entity; "cohort" vs
  "custom list" overlap. A short glossary and consistent labels would help.

### P4 — CORS hardcoded to localhost
`api/main.py` allows only `localhost:3000/5173`; production from another origin will
fail preflight. Drive `allow_origins` from config.

### P4 / housekeeping
- `etl/etl copy.py` and `frontend/api_main_updated.py` look like leftover duplicates;
  remove if obsolete.
- `assistant.py` exposes an LLM-driven SQL agent over the full database. Before
  enabling in production, restrict it to a read-only role and a vetted schema subset.

---

## Operational notes for this audit's fixes
- **DB migration required**: run `db/schema.sql` (idempotent) to apply the widened
  `projects.source_type` constraint.
- **Batch custom output directories**: set `analysis_output_base_dirs` (comma-separated
  absolute paths) to allow-list where batch jobs may write. If unset, custom paths are
  still accepted but blocked from protected system roots; the in-app auto-ingest flow
  (no `output_directory`) is unaffected either way.
