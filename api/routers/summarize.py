"""
PathoDB API — Patient Summarize Router
=======================================
Streams a longitudinal summary of a patient's microscopy reports using
a locally-hosted Ollama instance (CPU, quantized model).

Design principles
-----------------
* Report-first — all available microscopy report texts are the primary
  input. The model reads them chronologically and summarizes what they
  describe. Structural metadata (blocks, scan coverage) is a brief
  orientation header only.
* Chronological ordering — reports fed oldest-first so the model can
  describe disease trajectory naturally.
* Length-aware truncation — each report is included in full up to a
  per-report character budget. If total content exceeds the context
  budget, oldest reports are trimmed first, never dropped entirely.
* Data-narrative only — explicitly instructed not to make clinical
  recommendations or inferences beyond what the reports state.
* Pure async streaming — tokens forwarded to browser as they arrive.
* Graceful degradation — /health returns 503 if Ollama is down.
* Model stays warm — keep_alive=-1 prevents unloading between requests.

Ollama endpoint: POST /api/generate  (NDJSON streaming)
Each chunk: {"response": "<token>", "done": false}
Final chunk: {"response": "", "done": true, "eval_count": N, ...}
"""

import json
import logging
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..auth import get_current_active_user
from ..config import get_settings
from ..database import get_db
from ..models import Block, Patient, Probe, Report, Scan, Submission, User

log = logging.getLogger("pathodb_summarize")
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

REPORT_CHAR_BUDGET = 5000
TOTAL_REPORT_CHAR_BUDGET = 20000
NUM_PREDICT = 1000


# ─── Data assembly ─────────────────────────────────────────────────────────────

def _build_patient_context(patient_id: int, db: Session) -> dict:
    """
    Assemble the patient context dict.

    Primary output: a chronologically ordered list of microscopy report
    dicts, each containing date, topography, submission_type, and the
    full report text (subject to character budgets).

    Secondary output: lightweight structural metadata used as a brief
    orientation header in the prompt.
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

    if not submissions:
        return {
            "patient": patient,
            "reports": [],
            "total_submissions": 0,
            "malignant_count": 0,
            "year_min": None,
            "year_max": None,
            "total_blocks": 0,
            "scanned_pct": 0,
        }

    # ── Collect microscopy reports in chronological order ─────────────────────
    reports_out = []
    malignant_count = 0
    report_dates = []
    total_blocks = 0
    scanned_blocks = 0

    for sub in submissions:
        if sub.malignancy_flag:
            malignant_count += 1
        if sub.report_date:
            report_dates.append(sub.report_date)

        # Representative topography and type from the first probe
        probes = db.query(Probe).filter(Probe.submission_id == sub.id).all()
        topo = next(
            (p.topo_description for p in probes if p.topo_description),
            None,
        )
        submission_type = next(
            (p.submission_type for p in probes if p.submission_type),
            None,
        )

        for probe in probes:
            blocks = db.query(Block).filter(Block.probe_id == probe.id).all()
            for block in blocks:
                total_blocks += 1
                has_scan = db.query(Scan).filter(
                    Scan.block_id == block.id
                ).first()
                if has_scan:
                    scanned_blocks += 1

        # Microscopy report for this submission
        micro = (
            db.query(Report)
            .filter(
                Report.submission_id == sub.id,
                Report.report_type == "microscopy",
            )
            .first()
        )

        if micro and micro.report_text and micro.report_text.strip():
            text = micro.report_text.strip()
            # Truncate long individual reports; mark the cut so the model
            # knows the text was trimmed and does not hallucinate an ending.
            if len(text) > REPORT_CHAR_BUDGET:
                text = text[:REPORT_CHAR_BUDGET] + " [… truncated]"

            reports_out.append({
                "date": str(sub.report_date) if sub.report_date else "date unknown",
                "submission_id": sub.lis_submission_id,
                "topo": topo or "site not recorded",
                "submission_type": submission_type or "type not recorded",
                "malignant": sub.malignancy_flag,
                "text": text,
            })

    # ── Enforce total character budget, trimming oldest first ─────────────────
    total_chars = sum(len(r["text"]) for r in reports_out)
    if total_chars > TOTAL_REPORT_CHAR_BUDGET and len(reports_out) > 1:
        excess = total_chars - TOTAL_REPORT_CHAR_BUDGET
        for r in reports_out:  # oldest first
            if excess <= 0:
                break
            # Always keep at least 200 chars so no report disappears entirely
            trimable = len(r["text"]) - 200
            if trimable > 0:
                cut = min(trimable, excess)
                r["text"] = r["text"][: len(r["text"]) - cut] + " [… truncated]"
                excess -= cut

    year_min = min(report_dates).year if report_dates else None
    year_max = max(report_dates).year if report_dates else None
    scanned_pct = round(scanned_blocks / total_blocks * 100) if total_blocks else 0

    return {
        "patient": patient,
        "reports": reports_out,
        "total_submissions": len(submissions),
        "malignant_count": malignant_count,
        "year_min": year_min,
        "year_max": year_max,
        "total_blocks": total_blocks,
        "scanned_pct": scanned_pct,
    }


def _build_prompt(ctx: dict) -> str:
    """
    Build the LLM prompt.

    Structure:
      1. System instruction (role + hard constraints)
      2. Brief patient orientation header (metadata)
      3. All microscopy reports, numbered chronologically, each with
         date, site, type, and full text
      4. Task instruction
    """
    p = ctx["patient"]
    sex = {"M": "male", "F": "female"}.get(p.sex or "", "sex unknown")
    dob = str(p.date_of_birth) if p.date_of_birth else "unknown"

    year_range = (
        f"{ctx['year_min']}–{ctx['year_max']}"
        if ctx["year_min"] and ctx["year_min"] != ctx["year_max"]
        else str(ctx["year_min"] or "unknown")
    )

    reports = ctx["reports"]

    # Edge case: patient exists but has no microscopy text at all
    if not reports:
        return (
            f"Write one sentence stating that patient {p.patient_code} "
            f"has {ctx['total_submissions']} pathology submission(s) between "
            f"{year_range} but no microscopy report text is currently "
            f"available in the database."
        )

    # ── Format each report as a clearly delimited numbered block ─────────────
    report_blocks = []
    for i, r in enumerate(reports, 1):
        header = (
            f"REPORT {i} — {r['date']}| ID: {r['submission_id']}\n"
            f"Type: {r['submission_type']} | "
        )
        report_blocks.append(header + r["text"])

    reports_section = "\n\n---\n\n".join(report_blocks)

    prompt = f"""
You are a senior clinical pathologist and oncologic data summarization expert.

Your task is to analyze a set of pathology reports from a single patient (provided in reverse chronological order: newest → oldest) and produce a concise, clinically accurate longitudinal summary of the findings.


------------------------------------------------------------
OUTPUT FORMAT (STRICT)
------------------------------------------------------------

Return exactly TWO sections:

1) Concise Longitudinal Summary (max 7 sentences)
2) Bottom line (max 2 sentences)

Do NOT include bullet points. Do NOT list specimens.

------------------------------------------------------------
CORE OBJECTIVE
------------------------------------------------------------

Describe the patient’s disease course over time:
- Was malignancy present or absent?
- If present, what type and where did it spread?
- Was it already metastatic at diagnosis or did it appear later?
- How did findings evolve over time (progression vs stable vs unclear)?

------------------------------------------------------------
CRITICAL RULES (VERY IMPORTANT)
------------------------------------------------------------

- Use ONLY information explicitly stated or directly inferable.

- DO NOT guess or fill missing information.

- DO NOT infer:
  - cure
  - remission
  - resolution
  - “no disease”
  - “no residual tumor”

- If tumor is not seen in a sample:
  → say “no tumor identified in sampled tissue”
  → DO NOT interpret as disease absence

- DO NOT confuse:
  - Direct invasion (tumor growing into nearby organs)
  - Metastasis (spread to distant sites)

- Only say “metastasis” if explicitly stated.

- If metastatic disease exists at any point:
  → DO NOT suggest it disappeared unless explicitly stated

- If uncertain:
  → say “uncertain based on available data”

- Match information to the submission ID.

------------------------------------------------------------
WHAT TO EXTRACT INTERNALLY
------------------------------------------------------------

- Presence of malignancy (yes / no / uncertain)
- If tumor is present, then look for this information:
    - Primary tumor site (if stated). First appearance need not be the primary tumor. 
        → Explicitly search the tumor type and site for clues: e.g. [organ] adenocarcinoma, or squamous cell carcinoma of the [organ]
    - Degree of differentiation (if stated) and histological type.
    - Local invasion (T-stage)
    - Lymph node involvement (N-stage)
    - Distant metastases (M-stage) and sites (if stated)
    - Key molecular findings (if explicitly stated)
- Structured temporal sequence (first appearance → later findings). 

------------------------------------------------------------
WRITING STYLE RULES
------------------------------------------------------------

- Be concise and clinical.
- Use simple medical language.
- Prefer exact phrasing:

Correct:
- “direct invasion into [organ]”
- “metastatic disease involving [organ]”
- “lymph node metastases present”
- “no tumor identified in sampled tissue”

Incorrect:
- “cure”
- “resolved”
- “clearance”
- “no residual disease”

------------------------------------------------------------
INPUT
------------------------------------------------------------

PATIENT ORIENTATION:
- Code: {p.patient_code} | Sex: {sex} | DOB: {dob}

MICROSCOPY REPORTS (chronological):

{reports_section}

---

LONGITUDINAL SUMMARY:"""

    return prompt


# ─── Streaming helpers ─────────────────────────────────────────────────────────

async def _stream_ollama(prompt: str) -> AsyncIterator[str]:
    """
    Call Ollama /api/generate with stream=true and yield each token.
    Raises httpx.ConnectError if Ollama is not reachable.
    """
    payload = {
        "model": _ollama_model(),
        "prompt": prompt,
        "stream": True,
        "keep_alive": -1,           # keep model loaded indefinitely
        "options": {
            "num_thread": _ollama_num_threads(),
            "temperature": 0.3,     # low temp for factual consistency
            "top_p": 0.9,
            "repeat_penalty": 1.1,
            "num_predict": NUM_PREDICT,
        },
    }

    # Longer timeout than the original: 10 reports × ~1500 chars each can
    # produce a larger prompt that takes more time to process on first token.
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


async def _sse_generator(prompt: str) -> AsyncIterator[bytes]:
    """
    Wrap _stream_ollama tokens into SSE-formatted byte chunks.
    SSE format: 'data: <json>\\n\\n'
    Final sentinel: 'data: [DONE]\\n\\n'
    """
    try:
        async for token in _stream_ollama(prompt):
            payload = json.dumps({"token": token})
            yield f"data: {payload}\n\n".encode()
    except (httpx.ConnectError, httpx.ConnectTimeout):
        error_payload = json.dumps({"error": "ollama_offline"})
        yield f"data: {error_payload}\n\n".encode()
    except Exception as exc:
        log.error(f"Streaming error: {exc}", exc_info=True)
        error_payload = json.dumps({"error": str(exc)})
        yield f"data: {error_payload}\n\n".encode()
    finally:
        yield b"data: [DONE]\n\n"


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/health")
async def ollama_health(
    _: User = Depends(get_current_active_user),
):
    """
    Check whether Ollama is reachable and the configured model is pulled.
    Returns 200 + model info, or 503 if the service is offline.
    """
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{_ollama_url()}/api/tags")
            resp.raise_for_status()
            tags = resp.json()
            model_name = _ollama_model()
            models = [m["name"] for m in tags.get("models", [])]
            available = any(
                m.startswith(model_name.split(":")[0]) for m in models
            )
            return {
                "status": "ok",
                "model": model_name,
                "model_available": available,
                "available_models": models,
                "ollama_url": _ollama_url(),
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
    _: User = Depends(get_current_active_user),
):
    """
    Stream a longitudinal summary of all microscopy reports for a patient.

    Returns text/event-stream (SSE).
    Each event  : data: {"token": "<text>"}
    Final event : data: [DONE]
    Error event : data: {"error": "<reason>"}
    """
    ctx = _build_patient_context(patient_id, db)
    prompt = _build_prompt(ctx)

    report_count = len(ctx.get("reports", []))
    log.info(
        f"Streaming microscopy summary for patient {patient_id} — "
        f"{report_count}/{ctx.get('total_submissions', 0)} reports have text, "
        f"model={_ollama_model()}"
    )

    return StreamingResponse(
        _sse_generator(prompt),
        media_type="text/event-stream",
        headers={
            "X-Accel-Buffering": "no",   # prevent nginx buffering the stream
            "Cache-Control": "no-cache",
        },
    )