"""
PathoDB agent — golden-set evaluation harness (roadmap #9).

Drives the LangGraph agent IN-PROCESS over a set of golden questions and scores
each run on: tool-call validity, refusal-when-empty (trap cases), grounding
(no invented accession IDs), latency and token usage. Produces a per-model
scorecard so model / prompt / retrieval changes can be compared on evidence —
and so the Qwen3 bake-off is a matter of re-serving a model and re-running.

Requires BOTH the database and the vLLM endpoint to be reachable, so run it in
the same environment as the API (e.g. on the API node via
`srun --overlap --jobid <pathodb_api job>`), from the repo root:

    python -m api.agent.eval.run_eval --user-email you@example.org
    python -m api.agent.eval.run_eval --limit 3 --out /tmp/eval.json

The served model is read from settings.vllm_model and recorded in the output;
to compare models, re-serve a different one (slurm_vllm.sh) and re-run.
"""
import argparse
import json
import logging
import re
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from api.config import get_settings            # noqa: E402
from api.database import SessionLocal          # noqa: E402
from api.models import User                    # noqa: E402
from api.agent.stream import parse_tool_content  # noqa: E402

log = logging.getLogger("agent_eval")

# Accession-number-like tokens (B2002.8135, Z12345, …). The system prompt forbids
# inventing patient codes / IDs, so any such token in the answer that never
# appeared in a tool result is a grounding violation.
_ID_PAT = re.compile(r"\b[A-Z]\d{3,}(?:\.\d+)?(?:[_-][A-Z0-9]+)?\b")
_REFUSAL_PAT = re.compile(
    r"\b(no |not |don't|do not|cannot|can'?t|unable|couldn'?t|could not|"
    r"n'?t (?:available|found)|no data|not available|not found|no record|"
    r"don'?t have|do not have|no information|isn'?t available)\b", re.I)


# ── pure scoring (no LLM / DB) ────────────────────────────────────────────────

def extract_run(messages):
    """Pull tool calls, tool results and the final answer from a graph run's
    final message list."""
    called, results = [], []
    tokens_in = tokens_out = 0
    for m in messages:
        for tc in (getattr(m, "tool_calls", None) or []):
            called.append({"name": tc.get("name"), "args": tc.get("args")})
        if getattr(m, "type", None) == "tool":
            results.append({"name": getattr(m, "name", None),
                            "data": parse_tool_content(getattr(m, "content", "") or "")})
        um = getattr(m, "usage_metadata", None)
        if isinstance(um, dict):
            tokens_in += um.get("input_tokens") or 0
            tokens_out += um.get("output_tokens") or 0
    answer = ""
    for m in reversed(messages):
        if getattr(m, "type", None) == "ai" and (getattr(m, "content", "") or "").strip() \
                and not getattr(m, "tool_calls", None):
            answer = m.content
            break
    return {"called_tools": called, "tool_results": results,
            "final_answer": answer, "tokens_in": tokens_in, "tokens_out": tokens_out}


def score_case(case, run):
    """Score one run against its golden expectations. Returns a dict of metrics
    plus a boolean `passed` (all applicable checks satisfied)."""
    called_names = [c["name"] for c in run["called_tools"]]
    called_set = set(called_names)
    answer = run["final_answer"] or ""

    checks = {}

    # tool-call expectations (only whichever keys are present in the case)
    if case.get("expect_no_tools"):
        checks["no_tools"] = len(called_names) == 0
    if case.get("expect_tools"):
        checks["expect_tools"] = all(t in called_set for t in case["expect_tools"])
    if case.get("expect_any_tools"):
        checks["expect_any_tools"] = any(t in called_set for t in case["expect_any_tools"])

    # malformed calls: unknown tool names surfaced by the tool node
    malformed = any("unknown tool" in (r["data"].get("summary") or "").lower()
                    for r in run["tool_results"])
    checks["no_malformed_tool_calls"] = not malformed

    # grounding: accession-like IDs in the answer must appear in some tool output
    grounded_text = " ".join(json.dumps(r["data"], default=str) for r in run["tool_results"])
    answer_ids = set(_ID_PAT.findall(answer))
    violations = sorted(t for t in answer_ids if t not in grounded_text)
    checks["grounded"] = len(violations) == 0

    # refusal on trap cases
    refused = bool(_REFUSAL_PAT.search(answer))
    if case.get("expect_refusal"):
        checks["refused_when_empty"] = refused and not violations

    # content check: the answer must contain at least one of these substrings
    # (case-insensitive) — e.g. a required fact, or acknowledgement of a tool
    # limitation ("cannot filter on ..."). For reasoning cases where the right
    # tool alone doesn't prove the model understood the ask.
    if case.get("expect_contains"):
        al = answer.lower()
        checks["contains"] = any(s.lower() in al for s in case["expect_contains"])

    passed = all(checks.values())
    return {
        "checks": checks,
        "passed": passed,
        "called_tools": called_names,
        "grounding_violations": violations,
        "refused": refused,
        "answer_chars": len(answer),
    }


# ── LLM-as-judge (reasoning-quality scoring) ──────────────────────────────────
# Tool-presence + grounding checks measure plumbing; they can't grade reasoning
# or interpretation. For cases with a `rubric`, an optional LOCAL judge model
# scores the answer 1-5 against the rubric (local so patient data never leaves).
# The judge is a signal, not gospel — cross-check with the objective checks, and
# note self-preference bias if the judge shares a family with a contender.

JUDGE_PROMPT = """You grade a pathology RESEARCH assistant's answer against a rubric.

USER QUESTION:
{q}

TOOL RESULTS THE ASSISTANT HAD (its ground truth; truncated):
{grounding}

ASSISTANT'S ANSWER:
{answer}

RUBRIC (what a strong answer must do):
{rubric}

Score 1-5:  5 = fully meets rubric, grounded, sound interpretation · 4 = good, minor
gaps · 3 = partial · 2 = mostly misses · 1 = wrong / fabricated / empty.
Reply with ONLY a compact JSON object: {{"score": <1-5>, "reason": "<one sentence>"}}"""


def make_judge(base_url, model):
    if not base_url or not model:
        return None
    from langchain_openai import ChatOpenAI
    from api.agent.llm import _extra_body
    s = get_settings()
    return ChatOpenAI(base_url=base_url, api_key=s.vllm_api_key, model=model,
                      temperature=0.0, max_tokens=250, timeout=s.vllm_request_timeout,
                      extra_body=_extra_body(model, thinking=False) or None)


def judge_case(case, run, judge):
    """Return {judge_score, judge_reason} or None when no rubric/judge."""
    rubric = case.get("rubric")
    if not rubric or judge is None:
        return None
    grounding = " ".join(json.dumps(r["data"], default=str)
                         for r in run["tool_results"])[:4000] or "(no tool results)"
    answer = (run["final_answer"] or "")[:2000] or "(empty)"
    prompt = JUDGE_PROMPT.format(q=case["q"], grounding=grounding, answer=answer, rubric=rubric)
    try:
        txt = (judge.invoke(prompt).content or "").strip()
        m = re.search(r"\{.*\}", txt, re.DOTALL)
        obj = json.loads(m.group(0)) if m else {}
        sc = obj.get("score")
        return {"judge_score": int(sc) if sc is not None else None,
                "judge_reason": str(obj.get("reason", ""))[:200]}
    except Exception as e:
        return {"judge_score": None, "judge_reason": f"judge error: {str(e)[:100]}"}


# ── driver ────────────────────────────────────────────────────────────────────

def _load_golden(path):
    cases = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            cases.append(json.loads(line))
    return cases


def _pick_user(db, email):
    if email:
        u = db.query(User).filter(User.email == email).first()
        if not u:
            sys.exit(f"No user with email {email!r}")
        return u
    u = db.query(User).order_by(User.id).first()
    if not u:
        sys.exit("No users in the database to run the eval as.")
    return u


def run_eval(cases, db, user, settings, judge=None):
    from langchain_core.messages import HumanMessage
    from api.agent.graph import build_agent_graph

    rows = []
    for case in cases:
        graph = build_agent_graph(db, user, case.get("context"))
        cfg = {"configurable": {"thread_id": f"eval-{case['id']}-{uuid.uuid4().hex[:8]}"},
               "recursion_limit": settings.agent_max_iterations * 2}
        t0 = time.perf_counter()
        try:
            out = graph.invoke({"messages": [HumanMessage(content=case["q"])]}, cfg)
            latency_ms = int((time.perf_counter() - t0) * 1000)
            run = extract_run(out["messages"])
            score = score_case(case, run)
            jd = judge_case(case, run, judge) or {}
            rows.append({"id": case["id"], "q": case["q"], "latency_ms": latency_ms,
                         "tokens_in": run["tokens_in"], "tokens_out": run["tokens_out"],
                         "final_answer": (run["final_answer"] or "")[:500],
                         **score, **jd, "error": None})
        except Exception as e:
            latency_ms = int((time.perf_counter() - t0) * 1000)
            log.error("case %s failed: %s", case["id"], e, exc_info=True)
            rows.append({"id": case["id"], "q": case["q"], "latency_ms": latency_ms,
                         "passed": False, "error": str(e), "checks": {}, "called_tools": []})
        r = rows[-1]
        flag = "ok " if r.get("passed") else "FAIL"
        js = f"  judge={r['judge_score']}" if r.get("judge_score") is not None else ""
        print(f"  [{flag}] {r['id']:26s} {r['latency_ms']:6d}ms  "
              f"tools={r.get('called_tools')}{js}  err={r.get('error')}")
    return rows


def summarize(rows, model):
    scored = [r for r in rows if r.get("error") is None]
    n = len(rows)
    passed = sum(1 for r in rows if r.get("passed"))
    lat = sorted(r["latency_ms"] for r in scored) or [0]
    agg = {
        "model": model,
        "n_cases": n,
        "n_errors": sum(1 for r in rows if r.get("error")),
        "n_passed": passed,
        "pass_rate": round(passed / n, 3) if n else 0,
        "grounding_violation_cases": sum(1 for r in scored if r.get("grounding_violations")),
        "median_latency_ms": lat[len(lat) // 2],
        "total_tokens_in": sum(r.get("tokens_in", 0) for r in scored),
        "total_tokens_out": sum(r.get("tokens_out", 0) for r in scored),
    }
    judged = [r["judge_score"] for r in scored if r.get("judge_score") is not None]
    if judged:
        agg["n_judged"] = len(judged)
        agg["mean_judge_score"] = round(sum(judged) / len(judged), 2)
    return agg


def main():
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")
    default_golden = str(Path(__file__).with_name("golden_set.jsonl"))
    ap = argparse.ArgumentParser(description="Run the PathoDB agent golden-set eval.")
    ap.add_argument("--golden", default=default_golden)
    ap.add_argument("--user-email", default=None, help="run as this user (default: first user).")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--out", default=None, help="write full JSON results here.")
    # Bake-off overrides: point the eval at any served vLLM endpoint/model WITHOUT
    # editing .env (so the running production API's config is untouched). The LLM
    # factory reads settings live, so mutating the cached Settings here is enough.
    ap.add_argument("--model", default=None, help="override vllm_model (served-model-name).")
    ap.add_argument("--base-url", default=None, help="override vllm_base_url, e.g. http://gnode22:8001/v1")
    # LLM-as-judge for reasoning-quality (rubric) cases. LOCAL only — patient data
    # must not leave. Use a judge that is NOT the model under test where possible.
    ap.add_argument("--judge-model", default=None, help="judge model id (enables rubric scoring).")
    ap.add_argument("--judge-base-url", default=None, help="judge vLLM base url.")
    args = ap.parse_args()

    settings = get_settings()
    if args.model:
        settings.vllm_model = args.model
    if args.base_url:
        settings.vllm_base_url = args.base_url
    cases = _load_golden(args.golden)
    if args.limit:
        cases = cases[:args.limit]

    judge = make_judge(args.judge_base_url, args.judge_model)
    db = SessionLocal()
    try:
        user = _pick_user(db, args.user_email)
        print(f"Model: {settings.vllm_model}  |  cases: {len(cases)}  |  user: {user.id}"
              + (f"  |  judge: {args.judge_model}" if judge else "  |  judge: (none)") + "\n")
        rows = run_eval(cases, db, user, settings, judge=judge)
    finally:
        db.close()

    agg = summarize(rows, settings.vllm_model)
    print("\n── scorecard ─────────────────────────────")
    for k, v in agg.items():
        print(f"  {k:28s} {v}")

    if args.out:
        Path(args.out).write_text(json.dumps({"aggregate": agg, "cases": rows},
                                             indent=2, default=str), encoding="utf-8")
        print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main()
