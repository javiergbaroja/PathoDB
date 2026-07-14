"""Guided-decoding contracts for the router, sufficiency gate and planner.

vLLM constrains generation to these shapes via `extra_body` (guided_choice /
guided_json), so a 14B model emits a valid label/verdict/plan every time instead
of free text the graph must string-parse. Adopted from SPARK's schema-constrained
outputs (its idea/code stages force strict JSON, "no text outside the object");
here the same discipline removes the malformed-plan and unparsed-verdict failure
modes and makes plans schema-inspectable — a prerequisite for a future code route.

Kept dependency-free (json + re only) so the schemas, the tolerant parser and the
plan renderer are a single source of truth shared by graph.py and the pure unit
tests, and so guided decoding can be turned off with the parsers still working on
whatever free text the model produces.
"""
import json
import re

# ── Router: exactly one routing label (vLLM guided_choice) ───────────────────
ROUTE_LABELS = ["chat", "simple", "complex"]

# ── Sufficiency gate: a verdict + (when missing) what to gather next ──────────
SUFFICIENCY_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["sufficient", "missing"]},
        "missing": {"type": "string"},
    },
    "required": ["verdict"],
    "additionalProperties": False,
}

# ── Planner: an ordered list of steps, each optionally naming a tool ──────────
# Only `step` is required so a trailing "summarize the findings" step (which
# names no tool) stays valid; `tool`/`args_hint` are advisory for the executor.
PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "steps": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "step": {"type": "string"},
                    "tool": {"type": "string"},
                    "args_hint": {"type": "string"},
                },
                "required": ["step"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["steps"],
    "additionalProperties": False,
}

_JSON_OBJ_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_json_object(text):
    """Best-effort extract + parse of the first JSON object in model text.

    Returns a dict, or None if nothing parseable is found. Tolerant on purpose:
    guided decoding yields a clean object, but the unguided fallback path may wrap
    it in prose or a stray token, so we grab the outermost {...} span and parse
    that. Non-object JSON (a bare list/scalar) returns None.
    """
    if not text:
        return None
    m = _JSON_OBJ_RE.search(text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def render_plan(plan_obj) -> str:
    """Render a parsed plan object into the numbered-list text the agent reads.

    Downstream (the agent's SYSTEM_PROMPT) still consumes a human-readable
    numbered plan, so the typed object is flattened back to that shape — the JSON
    buys validity + inspectability without changing the executor contract.
    Returns "" when there are no usable steps (caller keeps the raw text).
    """
    steps = (plan_obj or {}).get("steps") or []
    lines = []
    for i, s in enumerate(steps, start=1):
        if not isinstance(s, dict):
            continue
        text = (s.get("step") or "").strip()
        if not text:
            continue
        tool = (s.get("tool") or "").strip()
        hint = (s.get("args_hint") or "").strip()
        suffix = ""
        if tool:
            suffix = f" [tool: {tool}" + (f" — {hint}" if hint else "") + "]"
        lines.append(f"{i}. {text}{suffix}")
    return "\n".join(lines)
