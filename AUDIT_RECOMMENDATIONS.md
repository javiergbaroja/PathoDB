# PathoDB — Audit Recommendations

This document lists issues found during a full-repository audit that were **not**
auto-fixed because they require product judgment, a data migration, a workflow
decision, or verification against the live system. Fixes that were low-risk and
unambiguous have already been applied directly (see the accompanying commit).

Severity legend: **P1** data integrity / security · **P2** correctness / reliability ·
**P3** performance · **P4** UX / consistency.

---

## Already fixed in this commit (for reference)

- **P1 — Missing auth on `GET /summarize/patient/{id}/summary`** (`api/routers/summarize.py`).
  The endpoint returned a patient's AI-generated clinical summary (PHI) with no
  authentication. Added `get_current_active_user`.
- **P1 — TMA IDOR** (`api/routers/tmas.py`). `get_tma`, `get_tma_cores`,
  `upload_tma_cores`, `upload_tma_scans` did not check ownership, so any user could
  read or overwrite another user's TMA (the core-upload path deletes and replaces
  all cores). Now scoped to the owner, matching `list`/`patch`/`delete`.
- **P1 — Scanner API-key auth broken** (`api/auth.py`). `get_user_or_scanner`
  depended on a bearer scheme with `auto_error=True`, so a scanner sending only
  `X-API-Key` was rejected before the key was checked. Switched to a non-erroring
  bearer scheme and used a constant-time key comparison.
- **P2 — Duplicate `DELETE /analysis/jobs/{id}` route** (`api/routers/analysis.py`).
  The second handler was unreachable dead code; removed it. The surviving handler
  serves both cancel and `?purge=true`.
- **P2 — Magnification mis-classification** (`api/routers/slides.py`). An `if`
  instead of `elif` made the 80× objective bucket unreachable (every <0.18 mpp
  slide reported as 40×). Fixed the conditional chain.
- **P2 — Assistant could crash app startup** (`api/routers/assistant.py`).
  `langchain_*` (absent from `requirements.txt`) was imported at module load and a
  DB engine was built at import time; `settings.hf_token` does not exist. Made the
  imports and engine lazy and return `503` instead of `500`/import error.
- **P1 — `custom_list` projects violate DB constraint** (`db/schema.sql`). The
  frontend creates projects with `source_type='custom_list'`, but the CHECK
  constraint only allowed `cohort`/`file_import`, so creation would raise an
  IntegrityError. Added a migration widening the constraint (mirrors the existing
  `project_type` → `tma` migration in the same file). **Run `db/schema.sql` against
  existing databases to apply.**

---

## Recommendations (not auto-fixed)

### P1 — Annotation provenance is overwritten on every save
`PUT /projects/{id}/scans/{scan_id}/annotations` (`bulk_save_annotations`) deletes
all annotations for the scan and re-inserts them, setting `created_by = current_user`
and `created_at = now()` each time. The frontend auto-saves on every edit, slide
navigation, and page unload. Net effect: original author and creation timestamp are
lost on every save, and a read-collaborator's edits (if ever permitted) would be
re-attributed.

For a pathology annotation platform this is a traceability problem. Recommended:
send stable annotation IDs from the client and perform an upsert (insert new /
update changed / delete removed) that preserves `created_by`/`created_at` and only
moves `updated_at`. This is a coordinated frontend + backend change, hence not
auto-fixed.

### P1 — `upload_tma_scans` partial writes + duplicate sort_order
`api/routers/tmas.py`:
- Each new `Scan` is committed inside the loop, but an unregistered stain raises
  `HTTP 400` mid-loop — leaving the already-committed scans behind (partial write).
- Newly linked `ProjectScan` rows all receive the same `sort_order`
  (`max(sort_order)` is read once and never incremented), so ordering is undefined.

Recommended: validate all stains up front, then insert scans + links in a single
transaction, incrementing `sort_order` per row.

### P1 — Unrestricted batch `output_directory`
`submit_batch_job` (`api/routers/analysis.py`) takes a user-supplied
`output_directory`, calls `mkdir(parents=True)` on it, and on purge `rmtree`s the
path recorded in `batch_context.json`. There is no allow-list or traversal check, so
a user can create (and later delete) directories anywhere the API process can write.
Recommended: constrain output to a configured base directory and reject paths that
escape it.

### P1 — Open self-registration
`POST /auth/register` (`api/routers/auth.py`) lets anyone create a `researcher`
account, which grants access to all patient/clinical data and reports. For a
clinical/translational platform, consider disabling open registration, gating it
behind admin approval, or restricting by email domain.

### P2 — Annotations not validated against project membership
`create_annotation`, `bulk_save_annotations`, and `import_annotations`
(`api/routers/projects.py`) never verify that `scan_id` belongs to the project
(`project_scans`). A user with edit access can write annotations for arbitrary scans.
Recommended: verify the scan is a member of the project before writing.

### P2 — Slide tile tokens accept any valid JWT
`_auth_token` (`api/routers/slides.py`, also used by analysis tile/overlay routes)
validates the signature/expiry of `?token=` but does not check `type == "access"`,
so a refresh token in a URL would serve tiles. Recommended: enforce token type.

### P3 — `GET /analysis/jobs` runs `squeue` serially per job
`list_jobs` calls `_sync_job_status` for every non-terminal job, each spawning a
`squeue` subprocess (8 s timeout) and committing individually. With many active jobs
this serializes into a slow/at-risk-of-timeout request. Recommended: batch the SLURM
query (`squeue -j id1,id2,...`) and commit once, or move status sync to a background
poller and have the endpoint read cached state.

### P3 — N+1 in `GET /projects/{id}/scans`
`list_project_scans` (`api/routers/projects.py`) issues `db.get(Block)`,
`db.get(Probe)`, `db.get(Submission)` and lazy-loads `scan.stain` per scan. For
projects with many scans this is a large query count. Recommended: eager-load with
joins (the cohort scan-level path already does this and can be reused).

### P4 — Terminology / model overloading
- `Project` is reused for annotation projects **and** TMAs (`project_type='tma'`),
  with two routers (`projects.py`, `tmas.py`) applying different access rules to the
  same table. Consider a clear sub-type boundary or shared access helper.
- "Scan" (DB/`scans`) vs "slide"/"WSI" (UI, viewer, AI) refer to the same entity;
  "cohort" vs "custom list" (`custom_list`) overlap. A short glossary and consistent
  labels would reduce friction for domain users.

### P4 — CORS hardcoded to localhost
`api/main.py` allows only `localhost:3000/5173`. Production deployments served from
another origin will fail preflight. Recommended: drive `allow_origins` from config.

### Housekeeping
- `etl/etl copy.py` and `frontend/api_main_updated.py` appear to be leftover
  duplicates. If confirmed obsolete, remove them to avoid confusion.
- `assistant.py` exposes an LLM-driven SQL agent over the full database; before
  enabling in production, restrict it to a read-only role and a vetted schema subset.
