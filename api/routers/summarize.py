"""
PathoDB API — Patient Summarize Router (Anchor-Based Version)
==============================================================

Improved version with:
- Disease anchor extraction step
- Specimen-aware longitudinal reasoning
- Strong anti-hallucination constraints
- CPU-friendly Ollama execution
"""

import json
import logging
from typing import AsyncIterator, Optional

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


# ─────────────────────────────────────────────────────────────
# Ollama config
# ─────────────────────────────────────────────────────────────

def _ollama_url() -> str:
    return getattr(settings, "ollama_base_url", "http://localhost:11434")


def _ollama_model() -> str:
    return getattr(settings, "ollama_model", "llama3.1:8b-instruct-q2_K")


def _ollama_num_threads() -> int:
    return getattr(settings, "ollama_num_threads", 12)


# ─────────────────────────────────────────────────────────────
# Limits
# ─────────────────────────────────────────────────────────────

REPORT_CHAR_BUDGET = 5000
TOTAL_REPORT_CHAR_BUDGET = 20000
NUM_PREDICT = 500


# ─────────────────────────────────────────────────────────────
# Disease anchor extraction (NEW CORE COMPONENT)
# ─────────────────────────────────────────────────────────────

async def _extract_disease_anchor(ctx: dict) -> dict:
    """
    Extract a single unified disease entity before summarization.
    Prevents cross-report tumor drift and hallucinated primaries.
    """

    reports_text = "\n\n".join(
        f"{r['date']} | {r['submission_id']}\n{r['text']}"
        for r in ctx["reports"]
    )

    prompt = f"""
You are a pathology extraction system.

TASK:
Identify the SINGLE primary disease entity for this patient.

RULES:
- Use ONLY explicitly stated information
- Do NOT infer if uncertain
- Do NOT confuse metastases with primary tumor
- If no neoplastic disease is present, state it explicitly

OUTPUT JSON ONLY:

{{
  "primary_disease": {{
    "entity": "",
    "site": "",
    "histology": "",
    "grade": ""
  }},
  "metastatic_disease_present": true,
  "metastatic_sites": [],
  "certainty": "high | medium | low"
}}

REPORTS:
{reports_text}

ANSWER:
"""

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            f"{_ollama_url()}/api/generate",
            json={
                "model": _ollama_model(),
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": 0.1,
                    "num_predict": 400,
                },
            },
        )

        # 🔥 HARD SAFETY CHECK
        content_type = resp.headers.get("content-type", "")

        if "application/json" not in content_type:
            raise RuntimeError(
                f"Ollama returned non-JSON response: {resp.text[:300]}"
            )

        try:
            data = resp.json()
            return json.loads(data["response"])
        except Exception as e:
            raise RuntimeError(f"Invalid Ollama JSON output: {resp.text}") from e

# ─────────────────────────────────────────────────────────────
# Context builder
# ─────────────────────────────────────────────────────────────

def _build_patient_context(patient_id: int, db: Session) -> dict:
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
    malignant_count = 0
    report_dates = []
    total_blocks = 0
    scanned_blocks = 0

    for sub in submissions:
        if sub.malignancy_flag:
            malignant_count += 1
        if sub.report_date:
            report_dates.append(sub.report_date)

        probes = db.query(Probe).filter(Probe.submission_id == sub.id).all()

        for probe in probes:
            blocks = db.query(Block).filter(Block.probe_id == probe.id).all()
            for block in blocks:
                total_blocks += 1
                if db.query(Scan).filter(Scan.block_id == block.id).first():
                    scanned_blocks += 1

        micro = (
            db.query(Report)
            .filter(
                Report.submission_id == sub.id,
                Report.report_type == "microscopy",
            )
            .first()
        )

        if micro and micro.report_text:
            text = micro.report_text.strip()

            if len(text) > REPORT_CHAR_BUDGET:
                text = text[:REPORT_CHAR_BUDGET] + " [… truncated]"

            reports_out.append({
                "date": str(sub.report_date) if sub.report_date else "unknown",
                "submission_id": sub.lis_submission_id,
                "text": text,
            })

    year_min = min(report_dates).year if report_dates else None
    year_max = max(report_dates).year if report_dates else None

    return {
        "patient": patient,
        "reports": reports_out,
        "total_submissions": len(submissions),
        "malignant_count": malignant_count,
        "year_min": year_min,
        "year_max": year_max,
        "total_blocks": total_blocks,
        "scanned_pct": round(scanned_blocks / total_blocks * 100) if total_blocks else 0,
    }


# ─────────────────────────────────────────────────────────────
# Prompt builder (ANCHOR-CONSTRAINED)
# ─────────────────────────────────────────────────────────────

def _build_prompt(ctx: dict) -> str:
    p = ctx["patient"]

    reports_section = "\n\n---\n\n".join(
        f"{r['date']} | {r['submission_id']}\n{r['text']}"
        for r in ctx["reports"]
    )

    prompt = f"""
You are a pathology assistant generating a longitudinal summary.

You MUST strictly adhere to the disease anchor.

DISEASE ANCHOR (DO NOT MODIFY):
{json.dumps(ctx.get("disease_anchor", {}), indent=2)}

CRITICAL RULES:
- Do NOT change or reinterpret the primary disease
- Do NOT split into multiple independent tumors
- Do NOT assume metastasis unless explicitly stated
- Do NOT infer progression unless explicitly supported
- Treat each specimen independently unless linkage is explicit

DISTINCTIONS:
1. Primary tumor (from anchor only)
2. Metastasis (only if explicitly stated)
3. Local invasion
4. Non-neoplastic findings

STYLE:
- 4–6 sentences
- No report numbering
- No meta-commentary
- No speculation

PATIENT:
Code: {p.patient_code}

MICROSCOPY REPORTS:
{reports_section}

LONGITUDINAL SUMMARY:
"""
    return prompt


# ─────────────────────────────────────────────────────────────
# Ollama streaming
# ─────────────────────────────────────────────────────────────

async def _stream_ollama(prompt: str) -> AsyncIterator[str]:
    payload = {
        "model": _ollama_model(),
        "prompt": prompt,
        "stream": True,
        "keep_alive": -1,
        "options": {
            "num_thread": _ollama_num_threads(),
            "temperature": 0.3,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
            "num_predict": NUM_PREDICT,
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
                if not line:
                    continue
                chunk = json.loads(line)
                token = chunk.get("response", "")
                if token:
                    yield token
                if chunk.get("done"):
                    break


async def _sse_generator(prompt: str):
    try:
        async for token in _stream_ollama(prompt):
            yield f"data: {json.dumps({'token': token})}\n\n".encode()
    except Exception as e:
        yield f"data: {json.dumps({'error': str(e)})}\n\n".encode()
    finally:
        yield b"data: [DONE]\n\n"


# ─────────────────────────────────────────────────────────────
# Endpoint
# ─────────────────────────────────────────────────────────────

@router.get("/patient/{patient_id}")
async def summarize_patient(
    patient_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    ctx = _build_patient_context(patient_id, db)

    # NEW: disease anchor step
    ctx["disease_anchor"] = await _extract_disease_anchor(ctx)

    prompt = _build_prompt(ctx)

    log.info(
        f"Summarizing patient {patient_id} with "
        f"{len(ctx['reports'])} microscopy reports"
    )

    return StreamingResponse(
        _sse_generator(prompt),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )