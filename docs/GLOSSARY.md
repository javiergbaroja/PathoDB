# PathoDB Glossary — Canonical Terminology

A single source of truth for the domain terms used across the database, API, and
UI. Use the **canonical term** in new user-facing copy, identifiers, and docs.
The enumerated string values below live in `api/models/__init__.py`
(`PROJECT_TYPES`, `SOURCE_TYPES`) — reference those constants instead of
hard-coding the strings.

## Clinical hierarchy

| Canonical | Definition | Avoid / aliases seen in code |
| --- | --- | --- |
| **Patient** | A person, keyed by `patient_code`. | — |
| **Submission** | A LIS accession/case for a patient (`lis_submission_id`). | "case", "accession" |
| **Probe** | A specimen part within a submission (`lis_probe_id`), with topography. | "specimen", "part" |
| **Block** | A paraffin block cut from a probe (`block_label`). | — |
| **Scan** | One digitized whole-slide image. The DB entity is `scans`. | **"WSI", "slide", "image"** — all mean Scan |
| **Stain** | Controlled-vocabulary stain applied to a scan (H&E, IHC, …). | — |

> **Scan vs WSI vs slide**: these are the same thing. Prefer **"slide"** in
> user-facing copy (pathologists' word) and **`scan`** in code/DB. Do not
> introduce a third synonym.

## Collections of slides

| Canonical | Definition | Notes |
| --- | --- | --- |
| **Cohort** | A *saved query* (`cohorts.filter_json`) that resolves to a set of slides/blocks on demand. Dynamic. | source_type `cohort` |
| **Custom list** | A project built from an *explicit, fixed list* of scan IDs chosen in the UI. Static. | source_type `custom_list` |
| **File import** | A project seeded from an uploaded list of file paths. | source_type `file_import` |

> A **Cohort** re-evaluates its filter (membership can change as data grows); a
> **Custom list** is a frozen snapshot of IDs. Keep these distinct in UI copy.

## Projects and TMAs

`projects` is one table with a `project_type` discriminator. Treat the values as
distinct sub-types with different routers and pages:

| `project_type` | Meaning | API surface | Page |
| --- | --- | --- | --- |
| `cell_detection` | Point/cell annotation project. | `/projects` | Projects |
| `region_annotation` | Region/polygon annotation project. | `/projects` | Projects |
| `tma` | Tissue MicroArray: a grid of cores mapped to donor blocks. | `/tmas` (+ shared `/projects/{id}/scans`) | TMAs |

Rules of the boundary:
- TMAs **must not** appear in the annotation project list (`GET /projects`
  excludes `tma`). They have their own `/tmas` API and TMAs page.
- `GET /projects/{id}/scans` is shared infrastructure used by both annotation
  projects and the TMA detail page — keep it working for `tma` projects.
- Access: annotation projects support owner + shares; TMAs are owner-only today.

## Annotations & AI

| Canonical | Definition | Avoid |
| --- | --- | --- |
| **Annotation** | A user- or AI-created geometry (point/rectangle/ellipse/polygon/brush) on a slide, within a project. | "region", "ROI" (ROI is one specific annotation use) |
| **Class** | A label category within a project (`projects.classes`: id/name/color). | "category", "label" |
| **Analysis job** | A model inference run on a slide, submitted to SLURM. | "run", "prediction job" |
| **Core** | One spot in a TMA grid (`tma_cores`), mapped to a donor **Block**. | — |
