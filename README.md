# PathoDB

PathoDB is a research-oriented pathology data platform for managing and exploring digital pathology metadata.

It combines:
- a **PostgreSQL (+ pgvector)** backend,
- a **FastAPI** service layer,
- a **React + Vite** frontend,
- and **Python ETL pipelines** for ingesting and processing data.

> This repository appears to be under active development and currently includes both local and HPC-oriented workflows.

---

## Overview

PathoDB is designed to support computational pathology workflows by organizing patients, scans, stains, cohorts, slides, and analysis/search capabilities through a central API and database.

From the codebase structure, PathoDB includes:
- **API service** (`api/`) with modular routers and auth
- **Database schema** (`db/schema.sql`)
- **ETL scripts** (`etl/`) for bulk loading and repository scanning
- **Frontend app** (`frontend/`) built with React
- **Ops scripts** for SLURM/HPC execution and data purging

---

## Repository Structure

```text
PathoDB/
├── api/                     # FastAPI backend (auth, routers, models, schemas)
├── db/                      # SQL schema and DB bootstrap assets
├── etl/                     # ETL and ingestion scripts
├── frontend/                # React + Vite frontend
├── create_admin.py          # Helper script to create first admin user
├── docker-compose.yml       # Local database stack (Postgres + pgvector)
├── purge_year_range.py      # Purge utility logic
├── purge_year_range.sh      # SLURM job wrapper for purge utility
├── setup_postgres_hpc.sh    # PostgreSQL setup for HPC environments
├── slurm_api.sh             # SLURM launcher for API jobs
├── slurm_etl.sh             # SLURM launcher for ETL jobs
└── slurm_etl_scan_repo.sh   # SLURM launcher for repo-scanning ETL
```

---

## Tech Stack

### Backend / API
- Python
- FastAPI
- SQLAlchemy
- psycopg2
- python-jose (JWT)
- passlib (bcrypt)

### Database
- PostgreSQL 16
- pgvector extension

### Frontend
- React 18
- React Router
- Vite

### ETL
- Python
- pandas
- tqdm

---

## Getting Started (Local)

## 1) Prerequisites
- Docker + Docker Compose
- Python 3.10+ (recommended)
- Node.js 18+ and npm (for frontend)

## 2) Configure environment
Create a `.env` file in the repository root (if not already present) with at least:

```env
POSTGRES_DB=pathodb
POSTGRES_USER=pathodb_user
POSTGRES_PASSWORD=change_me
DATABASE_URL=postgresql://pathodb_user:change_me@localhost:5432/pathodb
```

> Keep secrets out of version control. If `.env` is tracked in your repo, consider replacing it with `.env.example` and adding `.env` to `.gitignore`.

## 3) Start database

```bash
docker compose up -d
```

This will start a PostgreSQL container (`pgvector/pgvector:pg16`) and initialize schema assets from `db/schema.sql` on first boot.

## 4) Run API

```bash
cd api
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

API docs (from `api/main.py`):
- Swagger UI: `http://localhost:8000/api/docs`
- ReDoc: `http://localhost:8000/api/redoc`

Health endpoint:
- `GET /api/health`

## 5) Run frontend

```bash
cd frontend
npm install
npm run dev
```

Open the local Vite URL shown in your terminal (typically `http://localhost:5173`).

---

## Admin Bootstrap

After DB and API config are ready, create your first admin user:

```bash
python create_admin.py
```

The script reads `DATABASE_URL` from `.env`, validates credentials, and inserts an admin user in `users`.

---

## ETL Workflows

ETL scripts live under `etl/`:
- `etl.py`
- `etl_scan_repo.py`

Install ETL dependencies:

```bash
cd etl
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Run scripts directly or via provided SLURM wrappers for HPC environments:
- `slurm_etl.sh`
- `slurm_etl_scan_repo.sh`

---

## HPC / SLURM Utilities

The repository includes job scripts for cluster execution:
- API submission (`slurm_api.sh`)
- ETL submission (`slurm_etl.sh`, `slurm_etl_scan_repo.sh`)
- Data purge jobs (`purge_year_range.sh` + `purge_year_range.py`)
- Postgres setup on HPC (`setup_postgres_hpc.sh`)

These scripts contain environment-specific paths and scheduler directives. Review and adapt:
- file paths,
- account/partition/qos settings,
- module/conda environment names,
- mail notification settings.

---

## Security Notes

- Rotate and secure all DB credentials.
- Do not expose PostgreSQL publicly unless required.
- Restrict CORS origins for production.
- Use HTTPS and secret management for deployed environments.
- Consider removing any tracked secret-bearing files from git history.

---

## Suggested Next Improvements

- Add `.env.example` with safe placeholders
- Add backend/frontend Makefile targets
- Add API + ETL tests and CI
- Add architecture diagram and domain model docs
- Add deployment profiles (local/dev/prod)

---

## License

No license file is currently present.

If you intend this project to be open source, add a `LICENSE` file (e.g., MIT, Apache-2.0, GPL-3.0) and update this section.

---

## Contact / Maintainer

Maintained by **@javiergbaroja**.
