"""Lightweight, local per-run tracing for the agent.

Accumulates plan text, node latencies, token usage, tool outcomes and retrieval
hits for a single /chat (or /confirm) run, then serializes to a compact dict that
is persisted as an ``agent_audit`` row (event_type='run_trace'). There is no
external collector — this satisfies the local-only / data-sovereignty constraint
while giving per-run debuggability ("why did that answer look weird?") and a basis
for scoring model/prompt changes later.

All hooks are best-effort and must never raise into the stream; callers wrap
persistence in try/except.
"""
import time


class RunTrace:
    def __init__(self, model=None, question_chars=0):
        self._t0 = time.perf_counter()
        self.model = model
        self.question_chars = question_chars
        self.plan = None
        self.planning_ms = None
        self.ttft_ms = None            # time to first synthesized token
        self.tools = []                # [{name, ok, citations, retrieval_hits?}]
        self.iterations = 0            # executor rounds that issued tool calls
        self.tokens_in = 0
        self.tokens_out = 0
        self.interrupted = False
        self.answer_chars = 0
        self.error = None

    def _ms(self):
        return int((time.perf_counter() - self._t0) * 1000)

    # ── event hooks ──────────────────────────────────────────────────────────
    def on_plan(self, text):
        if text and self.plan is None:
            # Strip the "RESEARCH PLAN (...):" preamble the planner node prepends.
            if "\n" in text and text.lstrip().upper().startswith("RESEARCH PLAN"):
                text = text.split("\n", 1)[1]
            self.plan = text.strip()
            self.planning_ms = self._ms()

    def on_agent_messages(self, messages):
        for m in messages or []:
            if getattr(m, "tool_calls", None):
                self.iterations += 1
            self._add_usage(m)

    def on_synth_messages(self, messages):
        for m in messages or []:
            self._add_usage(m)

    def on_first_token(self):
        if self.ttft_ms is None:
            self.ttft_ms = self._ms()

    def on_tool_result(self, name, data):
        data = data if isinstance(data, dict) else {}
        summary = (data.get("summary") or "").lower()
        # Heuristic: the tool layer surfaces failures in the summary text.
        ok = not ("error" in summary or "failed" in summary
                  or summary.startswith("unknown tool"))
        entry = {"name": name, "ok": ok, "citations": len(data.get("citations") or [])}
        if name == "semantic_report_search":
            entry["retrieval_hits"] = len(data.get("results") or [])
        self.tools.append(entry)

    def _add_usage(self, m):
        um = getattr(m, "usage_metadata", None)
        if isinstance(um, dict):
            self.tokens_in += um.get("input_tokens") or 0
            self.tokens_out += um.get("output_tokens") or 0

    # ── serialize ────────────────────────────────────────────────────────────
    def to_dict(self):
        return {
            "model": self.model,
            "duration_ms": self._ms(),
            "planning_ms": self.planning_ms,
            "ttft_ms": self.ttft_ms,
            "iterations": self.iterations,
            "n_tool_calls": len(self.tools),
            "n_tool_errors": sum(1 for t in self.tools if not t["ok"]),
            "retrieval_hits": sum(t.get("retrieval_hits", 0) for t in self.tools),
            "tokens_in": self.tokens_in or None,
            "tokens_out": self.tokens_out or None,
            "tools": self.tools,
            "plan": self.plan,
            "answer_chars": self.answer_chars,
            "interrupted": self.interrupted,
            "question_chars": self.question_chars,
            "error": self.error,
        }
