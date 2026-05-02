"""
PathoDB API — Patient Summarize Router
=======================================
Two-stage map-reduce pipeline for longitudinal patient history summarization.

Stage 1 (Map):
  One LLM call per submission to compress a potentially long microscopy report
  into 2-3 sentences capturing the key findings. Reports under SHORT_REPORT_THRESHOLD
  chars are passed through directly without a call, saving significant time for
  patients whose history is predominantly benign short-form cases.

Stage 2 (Reduce):
  One streaming LLM call that receives all Stage 1 summaries in chronological
  order and synthesizes a longitudinal narrative.

Design decisions:
  - No malignancy flag passed to the LLM (unreliably coded, creates anchoring bias)
  - No macroscopy (topography is implied in the microscopy text)
  - One microscopy report per submission (DB unique constraint enforces this)
  - Stage 1 uses non-streaming /api/generate for simplicity; Stage 2 streams
  - Stage 1 prompt is deliberately minimal — compression only, no reasoning
  - Stage 2 prompt handles reasoning, temporal evolution, and language constraints
  - Graceful degradation: Stage 1 failures fall back to truncated raw text
"""

import json
import logging
from typing import AsyncIterator
from datetime import datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import text

from ..auth import get_current_active_user
from ..config import get_settings
from ..database import get_db, SessionLocal
from ..models import Patient, Report, Submission, User

log      = logging.getLogger("pathodb_summarize")
settings = get_settings()

router = APIRouter(prefix="/summarize", tags=["summarize"])


# ─── Ollama config ─────────────────────────────────────────────────────────────

def _ollama_url() -> str:
    return getattr(settings, "ollama_base_url", "http://localhost:11434")

def _ollama_model() -> str:
    return getattr(settings, "ollama_model", "llama3.2:3b")

def _ollama_num_threads() -> int:
    return getattr(settings, "ollama_num_threads", 12)


# ─── Tuneable limits ───────────────────────────────────────────────────────────

# Reports shorter than this are self-contained and need no compression.
# Most benign short-form reports (reactive lymph node, fibrocystic change, etc.)
# fall below this threshold, so the majority of Stage 1 calls are avoided for
# patients with predominantly benign histories.
SHORT_REPORT_THRESHOLD = 200   # chars

# Hard cap on how much text we send to Stage 1. Beyond this the 3B model
# starts losing the thread. Truncation is marked so Stage 2 knows.
STAGE1_INPUT_CAP = 2500        # chars

# Token budgets per stage
STAGE1_NUM_PREDICT = 150       # 2-3 sentences ≈ 60-120 tokens; 150 is comfortable
STAGE2_NUM_PREDICT = 650       # 5-7 sentences for the synthesis


# ─── Prompts ───────────────────────────────────────────────────────────────────

# Stage 1: pure compression. Minimal instructions because the model's only job
# is to reduce length while preserving the diagnostic signal. No reasoning rules
# needed here — that complexity lives in Stage 2.
STAGE1_PROMPT = """\
You are a pathologist summarizing a single diagnostic report.
Write 2-3 concise sentences capturing the key findings.
State what was found and where. Use standard pathology terminology.
Do not add information not present in the report.

REPORT:
{text}

SUMMARY:"""


# Stage 2: all reasoning, temporal structure, and language constraints live here.
# Input is already compressed, so the model can focus on synthesis.
STAGE2_PROMPT = """\
You are a senior pathologist reviewing the complete diagnostic history of a patient \
for a colleague who is new to the case.

Write a longitudinal summary of 5-7 sentences for a reader with pathology knowledge.
Focus on how the findings evolved over time. Highlight key diagnoses and any \
progression, change in disease status, or new findings across submissions.
For cases with malignancy, describe the course and any spread if documented.
For cases without malignancy, describe the nature and progression of the findings.

Rules:
- Do not infer cure, remission, or resolution of disease unless explicitly stated.
- Do not state that disease was absent unless it was explicitly stated as absent.
- If findings are unrelated across submissions, note that they represent \
independent diagnostic episodes.
- Use only information present in the summaries below.

PATIENT: {patient_code} | {sex} | DOB: {dob}
HISTORY: {total_submissions} submissions | {year_range}

FINDINGS (chronological, oldest first):
{findings}

LONGITUDINAL SUMMARY:"""


# ─── Data assembly ─────────────────────────────────────────────────────────────

def _build_patient_context(patient_id: int, db: Session) -> dict:
    """
    Fetch all submissions with microscopy reports in chronological order.

    Returns a dict containing:
      patient         — ORM Patient object (for metadata in Stage 2 prompt)
      reports         — list of {submission_id, date, text}
      total_submissions — total number of submissions (including those without text)
      year_range      — human-readable year span string
    """
    patient: Patient = db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    submissions = (
        db.query(Submission)
        .filter(Submission.patient_id == patient_id)
        .order_by(Submission.report_date.asc().nullslast())
        .all()
    )

    reports_out = []
    report_dates = []

    for sub in submissions:
        micro = (
            db.query(Report)
            .filter(
                Report.submission_id == sub.id,
                Report.report_type   == "microscopy",
            )
            .first()
        )

        if not micro or not micro.report_text or not micro.report_text.strip():
            continue

        text = micro.report_text.strip()

        reports_out.append({
            "submission_id": sub.lis_submission_id,
            "date":          str(sub.report_date) if sub.report_date else "date unknown",
            "text":          text,
        })

        if sub.report_date:
            report_dates.append(sub.report_date)

    year_min = min(report_dates).year if report_dates else None
    year_max = max(report_dates).year if report_dates else None
    year_range = (
        f"{year_min}–{year_max}"
        if year_min and year_min != year_max
        else str(year_min or "unknown")
    )

    return {
        "patient":           patient,
        "reports":           reports_out,
        "total_submissions": len(submissions),
        "year_range":        year_range,
    }


# ─── Ollama call wrappers ──────────────────────────────────────────────────────

async def _generate(prompt: str, num_predict: int) -> str:
    """
    Non-streaming Ollama call. Returns the full response text.
    Used for Stage 1 where we want the complete summary before moving on.
    keep_alive=-1 keeps the model loaded between the rapid sequential Stage 1 calls,
    which is the primary mechanism for reducing total wall-clock time.
    """
    payload = {
        "model":      _ollama_model(),
        "prompt":     prompt,
        "stream":     False,
        "keep_alive": -1,
        "options": {
            "num_thread":     _ollama_num_threads(),
            "temperature":    0.2,   # lower temp for factual compression
            "top_p":          0.9,
            "repeat_penalty": 1.1,
            "num_predict":    num_predict,
        },
    }
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{_ollama_url()}/api/generate",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json().get("response", "").strip()


async def _stream_generate(prompt: str, num_predict: int) -> AsyncIterator[str]:
    """
    Streaming Ollama call. Yields tokens as they arrive.
    Used for Stage 2 so the browser starts receiving text immediately.
    """
    payload = {
        "model":      _ollama_model(),
        "prompt":     prompt,
        "stream":     True,
        "keep_alive": -1,
        "options": {
            "num_thread":     _ollama_num_threads(),
            "temperature":    0.3,
            "top_p":          0.9,
            "repeat_penalty": 1.1,
            "num_predict":    num_predict,
        },
    }
    async with httpx.AsyncClient(timeout=180.0) as client:
        async with client.stream(
            "POST",
            f"{_ollama_url()}/api/generate",
            json=payload,
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                token = chunk.get("response", "")
                if token:
                    yield token
                if chunk.get("done"):
                    break


# ─── Stage 1 ───────────────────────────────────────────────────────────────────

async def _extract_one(report: dict) -> str:
    """
    Compress a single submission's microscopy report into 2-3 sentences.

    Short reports are returned as-is — they are already concise and a
    compression call would risk losing nuance without gaining anything.

    Long reports are truncated to STAGE1_INPUT_CAP before being sent,
    with a marker so the model knows the text was cut.

    On failure, falls back to the first 300 chars of the raw text so
    Stage 2 always receives something for every submission.
    """
    text = report["text"]

    # Short-circuit: report is already compact, no call needed
    if len(text) <= SHORT_REPORT_THRESHOLD:
        return text

    # Truncate long inputs
    if len(text) > STAGE1_INPUT_CAP:
        text = text[:STAGE1_INPUT_CAP] + " [report truncated]"

    prompt = STAGE1_PROMPT.format(text=text)

    try:
        result = await _generate(prompt, num_predict=STAGE1_NUM_PREDICT)
        return result if result else text[:300]
    except Exception as exc:
        log.warning(
            f"Stage 1 extraction failed for {report['submission_id']}: {exc}. "
            f"Falling back to raw text truncation."
        )
        return text[:300] + ("…" if len(report["text"]) > 300 else "")


# ─── SSE generator ─────────────────────────────────────────────────────────────

async def _sse_generator(ctx: dict, patient_id: int) -> AsyncIterator[bytes]:
    """
    Full two-stage pipeline as a server-sent events stream.

    Event schema:
      Stage 1 progress:  {"progress": {"current": N, "total": M, "submission_id": "..."}}
      Stage 2 start:     {"stage": 2}
      Stage 2 tokens:    {"token": "<text>"}
      Error:             {"error": "<reason>"}
      Terminal:          [DONE]
    """
    reports = ctx["reports"]
    total   = len(reports)

    # ── Stage 1: per-submission extraction ────────────────────────────────────
    extracted: list[tuple[str, str, str]] = []  # (date, submission_id, summary)

    for i, report in enumerate(reports):
        # Emit progress before each call so the frontend updates immediately
        progress_event = json.dumps({
            "progress": {
                "current":       i + 1,
                "total":         total,
                "submission_id": report["submission_id"],
            }
        })
        yield f"data: {progress_event}\n\n".encode()

        summary = await _extract_one(report)
        extracted.append((report["date"], report["submission_id"], summary))

    # ── Stage 2: longitudinal synthesis ───────────────────────────────────────
    if not extracted:
        yield f"data: {json.dumps({'error': 'no_reports'})}\n\n".encode()
        yield b"data: [DONE]\n\n"
        return

    findings = "\n\n".join(
        f"[{date} | {sid}]\n{summary}"
        for date, sid, summary in extracted
    )

    p   = ctx["patient"]
    sex = {"M": "male", "F": "female"}.get(p.sex or "", "sex unknown")
    dob = str(p.date_of_birth) if p.date_of_birth else "unknown"

    stage2_prompt = STAGE2_PROMPT.format(
        patient_code      = p.patient_code,
        sex               = sex,
        dob               = dob,
        total_submissions = ctx["total_submissions"],
        year_range        = ctx["year_range"],
        findings          = findings,
    )
    full_summary = []
    # Signal to the frontend that Stage 1 is complete and text is about to stream
    yield f"data: {json.dumps({'stage': 2})}\n\n".encode()

    try:
        async for token in _stream_generate(stage2_prompt, STAGE2_NUM_PREDICT):
            full_summary.append(token)
            yield f"data: {json.dumps({'token': token})}\n\n".encode()
    except (httpx.ConnectError, httpx.ConnectTimeout):
        yield f"data: {json.dumps({'error': 'ollama_offline'})}\n\n".encode()
    except Exception as exc:
        log.error(f"Stage 2 synthesis failed: {exc}", exc_info=True)
        yield f"data: {json.dumps({'error': str(exc)})}\n\n".encode()

    try:
        final_text = "".join(full_summary).strip()

        if final_text:
            db = SessionLocal() 

            try:
                result = db.execute(
                    text("""
                        UPDATE patients
                        SET summary_text = :summary,
                            summary_updated_at = :updated_at
                        WHERE id = :patient_id
                        RETURNING id
                    """),
                    {
                        "summary": final_text,
                        "updated_at": datetime.utcnow(),
                        "patient_id": patient_id,
                    }
                )

                updated = result.scalar()

                if not updated:
                    log.error(f"❌ No patient row updated for patient_id={patient_id}")
                else:
                    log.info(f"✅ Summary saved for patient_id={updated}")

                db.commit()
            finally:
                db.close() 

    except Exception as exc:
        log.error(
            f"Failed to persist summary for patient {patient_id}: {exc}",
            exc_info=True
        )

    yield b"data: [DONE]\n\n"


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/health")
async def ollama_health(
    _: User = Depends(get_current_active_user),
):
    """
    Check Ollama reachability and confirm the configured model is pulled.
    Returns 200 with model info, or 503 if the service is offline.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{_ollama_url()}/api/tags")
            resp.raise_for_status()
            tags       = resp.json()
            model_name = _ollama_model()
            models     = [m["name"] for m in tags.get("models", [])]
            available  = any(
                m.startswith(model_name.split(":")[0]) for m in models
            )
            return {
                "status":           "ok",
                "model":            model_name,
                "model_available":  available,
                "available_models": models,
                "ollama_url":       _ollama_url(),
            }
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.HTTPError) as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Ollama not reachable at {_ollama_url()}: {exc}",
        )


@router.get("/patient/{patient_id}")
async def summarize_patient(
    patient_id: int,
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_active_user),
):
    """
    Stream a two-stage longitudinal summary for a patient.

    Returns text/event-stream (SSE).
    See _sse_generator docstring for the full event schema.
    """
    ctx          = _build_patient_context(patient_id, db)
    report_count = len(ctx["reports"])

    if not ctx["reports"]:
        raise HTTPException(
            status_code=404,
            detail="No microscopy reports found for this patient.",
        )

    log.info(
        f"Summarizing patient {patient_id} — "
        f"{report_count}/{ctx['total_submissions']} submissions have microscopy text "
        f"| model={_ollama_model()}"
    )

    return StreamingResponse(
        _sse_generator(ctx, patient_id),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",
            "Cache-Control":     "no-cache",
        },
    )


@router.get("/patient/{patient_id}/summary")
def get_patient_summary(patient_id: int, db: Session = Depends(get_db)):
    patient = db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(404, "Patient not found")

    return {
        "summary_text": patient.summary_text,
        "summary_updated_at": patient.summary_updated_at,
    }