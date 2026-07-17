"""LangGraph agent graph — plan-and-execute architecture.

Built per request (closing over the request's db session + user) but sharing a
module-level checkpointer so a safe-action `interrupt()` can pause one request
and resume in a later /confirm request under the same thread_id.

Graph:
    START -> planner -> agent -> tools -> agent -> ... -> synthesizer -> END

The planner generates a step-by-step plan BEFORE tool execution begins.
The agent follows the plan, calling tools as needed (existing loop).
The synthesizer takes all gathered information and produces a structured,
well-organized narrative — never dumping raw tool output.

The tool node executes read tools immediately; for safe actions it calls
interrupt({action, args}) and only runs them after the resumed value approves.
"""
import json
import logging
import re

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User
from .checkpoint import get_checkpointer
from .guided import (ROUTE_LABELS, SUFFICIENCY_SCHEMA, PLAN_SCHEMA,
                     parse_json_object, render_plan)
from .prompts import (SYSTEM_PROMPT, PLANNER_PROMPT, SYNTHESIS_PROMPT,
                      ROUTER_PROMPT, CHAT_PROMPT, SUFFICIENCY_PROMPT)
from .tools import get_tools, ACTION_TOOL_NAMES

log = logging.getLogger("pathodb_agent")


# ── Fast-path entry routing (#3) ─────────────────────────────────────────────
# A 'turn' is routed to: chat (answer directly, no tools), simple (skip the
# planner), or complex (full planner pipeline). The heuristic below is the
# zero-cost first pass; it only ever returns 'chat' on high confidence, so an
# ambiguous message falls through to the LLM classifier (and ultimately to the
# safe 'complex' default) — no capability can be lost by mis-routing to chat.
_GREETING_RE = re.compile(
    r"^\s*(hi|hii|hey|hello|yo|howdy|greetings|good\s+(morning|afternoon|evening)|"
    r"thanks|thank\s+you|thx|ta|cheers|ok(ay)?|cool|nice|great|got\s+it|"
    r"bye|goodbye|see\s+you)\b", re.I)
_CAPABILITY_RE = re.compile(
    r"\b(what\s+can\s+you|who\s+are\s+you|what\s+are\s+you|what\s+do\s+you\s+do|"
    r"how\s+(can|do)\s+you\s+help|can\s+you\s+help|your\s+capabilities|"
    r"what\s+(kinds?|sorts?|types?)\s+of\s+(questions?|things?)|help\s+me\s+with)\b", re.I)
# Tokens that signal a real data request — if present, never treat as chat.
_ENTITY_RE = re.compile(
    r"\b([A-Z]\d{3,}|\d{4,}|job\s+\d+|scan\s+\d+|submission|probe|cohort|biops|"
    r"carcinoma|adenoma|stain|topograph|morpholog|etiolog|snomed|patient\s+[A-Z0-9]|"
    r"infiltrat|report|analysis)\b", re.I)
# Query verbs signal a data request even without a named entity, so a greeting
# prefix ("hi, how many …") can't sneak a real question onto the chat path.
_QUERY_RE = re.compile(
    r"\b(how\s+many|how\s+much|count|list|find|show|search|look\s+up|which|"
    r"average|compare|summar|correlat|distribut|breakdown|filter|query)\b", re.I)


def _drop_orphan_tool_calls(messages):
    """Drop assistant messages whose tool_calls have no matching tool response.
    The loop guard routes to synthesis right after an UNEXECUTED tool-call
    message, and that message persists in the durable state; sent back to the
    API it errors ('an assistant message with tool_calls must be followed by
    tool messages'). So sanitize every model-facing view."""
    responded = {getattr(m, "tool_call_id", None)
                 for m in messages if getattr(m, "type", None) == "tool"}
    out = []
    for m in messages:
        tcs = getattr(m, "tool_calls", None)
        if tcs:
            ids = [(c.get("id") if isinstance(c, dict) else getattr(c, "id", None))
                   for c in tcs]
            if not all(i in responded for i in ids):
                continue  # orphaned tool-call message → drop from the view
        out.append(m)
    return out


def _model_view(messages, budget_tokens):
    """The sanitized, budget-bounded message list to send to an LLM: keep recent
    whole turns, drop orphaned tool-call messages, then shrink tool contents to
    fit the window."""
    return _truncate_to_budget(
        _drop_orphan_tool_calls(_trim_history(messages, budget_tokens)),
        budget_tokens)


def _tool_sig(call, known_args=None) -> str:
    """Stable signature of a tool call: name + canonical args. Two calls with the
    same signature return the same result, so a repeat is a wasted loop.

    `known_args` maps tool name -> its declared argument names. When supplied, args
    not in the tool's schema are dropped before hashing, so a HALLUCINATED kwarg
    (the model invented `sort="recent"` on a tool that has no such field) can't
    make two otherwise-identical calls look distinct and slip past the loop guard.
    The tool node drops those kwargs before invoking anyway, so they never affect
    the result — the signature must agree."""
    name = call.get("name") if isinstance(call, dict) else getattr(call, "name", "")
    args = (call.get("args") if isinstance(call, dict) else getattr(call, "args", {})) or {}
    if known_args is not None:
        allowed = known_args.get(name)
        if allowed is not None:
            args = {k: v for k, v in args.items() if k in allowed}
    try:
        args_s = json.dumps(args, sort_keys=True, default=str)
    except Exception:
        args_s = str(args)
    return f"{name}::{args_s}"


def _executed_signatures(messages, known_args=None) -> set:
    """Signatures of every tool call the agent already issued this run."""
    sigs = set()
    for m in messages:
        for c in (getattr(m, "tool_calls", None) or []):
            sigs.add(_tool_sig(c, known_args))
    return sigs


_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def _strip_think(text: str) -> str:
    """Remove Qwen3 <think>…</think> blocks from a non-streamed reasoning output.
    Belt-and-suspenders: the reasoning endpoint SHOULD run with --reasoning-parser
    (which keeps `content` clean), but if it doesn't, a raw <think> block would
    otherwise leak into the plan. Also drops an unclosed leading <think>."""
    if not text or "<think>" not in text.lower():
        return text
    text = _THINK_RE.sub("", text)
    low = text.lower()
    if "<think>" in low and "</think>" not in low:      # unterminated
        text = text[:low.index("<think>")]
    return text.strip()


def _recent_dialogue(messages, max_msgs=6, max_chars=1500):
    """Recent user/assistant text turns (no tool noise) for the router
    classifier, excluding the current (last) user message. Lets it tell a
    task-continuation from standalone chit-chat."""
    lines = []
    for m in messages:
        t = getattr(m, "type", None)
        content = (getattr(m, "content", "") or "").strip()
        if t == "human":
            lines.append(f"User: {content}")
        elif t == "ai" and content and not getattr(m, "tool_calls", None):
            lines.append(f"Assistant: {content}")
    # Drop the current user message (last human line) — it's passed separately.
    if lines and lines[-1].startswith("User: "):
        lines = lines[:-1]
    return "\n".join(lines[-max_msgs:])[-max_chars:]


def _heuristic_route(msg: str):
    """Zero-cost route. Returns 'chat' when confidently conversational, else None
    (meaning: ask the LLM classifier)."""
    m = (msg or "").strip()
    if not m:
        return "chat"
    if _ENTITY_RE.search(m) or _QUERY_RE.search(m):
        return None
    if len(m) <= 80 and _GREETING_RE.match(m):
        return "chat"
    if len(m) <= 160 and _CAPABILITY_RE.search(m):
        return "chat"
    return None


def _format_context(context) -> str:
    """Render the caller's current UI context as a system-message string.

    `context` is the optional {route, scan_id, patient_code, ...} the frontend
    sends about what the user is looking at, so deictic references ("this slide",
    "here", "this patient") resolve without the user copying IDs. Returns "" when
    there is nothing to inject.
    """
    if not context:
        return ""
    if hasattr(context, "model_dump"):
        c = context.model_dump()
    elif isinstance(context, dict):
        c = context
    else:
        return ""
    label_map = [("scan_id", "scan"), ("patient_code", "patient"),
                 ("patient_id", "patient id"), ("cohort_id", "cohort"),
                 ("project_id", "project"), ("route", "page")]
    parts = [f"{label} {c[key]}" for key, label in label_map
             if c.get(key) not in (None, "")]
    if not parts:
        return ""
    return ("CURRENT UI CONTEXT — the user is currently viewing: "
            + "; ".join(parts) + ". When they say 'this'/'here'/'this slide'/"
            "'this patient' without an explicit ID, resolve it to the above "
            "unless they clearly mean something else.")


def _approx_msg_tokens(m) -> int:
    """Rough token count for one message, deliberately pessimistic.

    Divides chars by 2, not the ~4 of English prose. Tool results here are dense
    JSON (braces, quotes, short keys, IDs), which tokenizes far closer to ~2
    chars/token; a chars/3 estimate UNDER-counted it by ~1.4x and let requests
    overflow the vLLM window (server 400: "your request has 14402 input tokens").
    Over-counting only costs a little extra trimming; under-counting breaks the
    call outright, so err pessimistic."""
    content = getattr(m, "content", "") or ""
    if not isinstance(content, str):
        content = str(content)
    tokens = len(content) // 2 + 16
    for tc in (getattr(m, "tool_calls", None) or []):
        tokens += len(str(tc.get("args", ""))) // 2 + 8
    return tokens


def _trim_history(messages, budget_tokens):
    """Keep only the most recent whole turns that fit the token budget.

    A 'turn' runs from a human message up to (not including) the next human
    message, so tool-call/tool-response pairs stay intact and the kept slice
    always starts on a human message — no orphaned tool messages, which the
    OpenAI-compatible API rejects. The final turn is always kept even if it alone
    exceeds the budget (better a big call than a broken one)."""
    idx = [i for i, m in enumerate(messages) if getattr(m, "type", None) == "human"]
    if not idx:
        return messages
    bounds = idx + [len(messages)]
    turns = [messages[bounds[k]:bounds[k + 1]] for k in range(len(idx))]
    kept, total = [], 0
    for turn in reversed(turns):
        tt = sum(_approx_msg_tokens(m) for m in turn)
        if kept and total + tt > budget_tokens:
            break
        kept = turn + kept
        total += tt
    return kept


def _truncate_to_budget(messages, budget_tokens):
    """Backstop for a SINGLE turn that alone busts the budget: e.g. the agent
    looped and its tool outputs piled up. _trim_history keeps the final turn
    whole, so without this a broad cohort/search turn can overflow the context
    window. Here we shrink ToolMessage CONTENTS (oldest first) until the view
    fits — never dropping messages (which would orphan tool-call pairs) and never
    mutating the originals (copies only, so the durable checkpoint is untouched)."""
    total = sum(_approx_msg_tokens(m) for m in messages)
    if total <= budget_tokens:
        return messages
    out = list(messages)
    for i, m in enumerate(out):
        if total <= budget_tokens:
            break
        if getattr(m, "type", None) != "tool":
            continue
        content = getattr(m, "content", "") or ""
        if not isinstance(content, str):
            content = str(content)
        cur = _approx_msg_tokens(m)
        cut = min(total - budget_tokens, cur - 200)  # leave ~200 tokens of gist
        if cut <= 0:
            continue
        keep_chars = max(200, len(content) - cut * 3)
        if keep_chars >= len(content):
            continue
        new_content = content[:keep_chars] + "\n…[truncated to fit context window]"
        try:
            nm = m.model_copy(update={"content": new_content})
        except Exception:
            from langchain_core.messages import ToolMessage
            nm = ToolMessage(content=new_content, name=getattr(m, "name", None),
                             tool_call_id=getattr(m, "tool_call_id", ""))
        out[i] = nm
        total = total - cur + _approx_msg_tokens(nm)
    return out


def build_agent_graph(db: Session, user: User, context=None):
    """Compile the plan-and-execute agent graph for this request."""
    from typing import Annotated, TypedDict
    from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage
    from langgraph.graph import StateGraph, START, END
    from langgraph.graph.message import add_messages
    from langgraph.types import interrupt

    from .llm import get_chat_model, get_reasoning_model, get_fast_model, get_synth_model

    settings = get_settings()

    class AgentState(TypedDict):
        messages: Annotated[list, add_messages]
        route: str        # 'chat' | 'simple' | 'complex' (set by router_node)
        suff_retries: int  # sufficiency-gate retries this turn (reset by router)
        suff_verdict: str  # 'retry' | 'ok' (routes out of the sufficiency node)

    tools = get_tools(db, user)
    tools_by_name = {t.name: t for t in tools}
    # Declared arg names per tool — used to (a) strip hallucinated kwargs before a
    # tool runs and (b) canonicalize loop-guard signatures so an invented kwarg
    # can't disguise a repeat call (see _tool_sig).
    tool_arg_names = {t.name: set((t.args or {}).keys()) for t in tools}
    model = get_chat_model().bind_tools(tools)      # agent (tool-calling)
    reasoning = get_reasoning_model()               # planner (#10)
    synth = get_synth_model()                        # synthesizer (may be a medical model)
    fast = get_fast_model()                         # router + direct chat answer

    # ── Guided-decoding variants (#3) ────────────────────────────────────────
    # Grammar-constrained instances for the router/sufficiency/planner. Planner
    # guidance is skipped for a *thinking* reasoning model (a <think> preamble
    # can't satisfy a strict JSON grammar). Each node falls back to its unguided
    # counterpart on failure, so these are strictly additive.
    guided = settings.agent_guided_decoding
    planner_guided = guided and not settings.vllm_reasoning_enable_thinking
    router_model = (get_fast_model(guided={"guided_choice": ROUTE_LABELS})
                    if guided else fast)
    suff_model = (get_fast_model(guided={"guided_json": SUFFICIENCY_SCHEMA})
                  if guided else fast)
    planner_model = (get_reasoning_model(guided={"guided_json": PLAN_SCHEMA})
                     if planner_guided else reasoning)

    def _guided_text(primary, fallback, msgs, label) -> str:
        """Invoke `primary` (guided); on failure retry `fallback` (unguided).
        Returns the response text. Lets the fallback's exception propagate to the
        caller's own error handling. A no-op indirection when primary is
        fallback (guided off)."""
        try:
            return (primary.invoke(msgs).content or "")
        except Exception as e:
            if primary is fallback:
                raise
            log.warning("Guided decoding failed for %s (%s) — retrying unguided",
                        label, e)
            return (fallback.invoke(msgs).content or "")

    # Current-view context (scan/patient/…) injected transiently into every node
    # so it never pollutes durable checkpoint state with stale per-turn context.
    context_msg = _format_context(context)

    # ── Available tools for the planner prompt ───────────────────────────────
    # Full descriptions + argument names (previously truncated to 120 chars,
    # which hid the details that distinguish similar tools — e.g. that
    # compute_tumor_infiltration needs BOTH a detection and a segmentation job —
    # causing the planner to mis-select or hallucinate tools). See roadmap #3.
    tool_descriptions = "\n".join(
        f"- {t.name}({', '.join((t.args or {}).keys())}): {t.description}"
        for t in tools
    )

    # ── Conversation history for planning ────────────────────────────────────
    def _planner_history(config, max_turns=8, max_chars=3000):
        """Prior user/assistant turns to plan against.

        Read from the canonical chat_message log (clean alternating turns)
        rather than the in-graph message list, which is noisy with plans, tool
        calls and intermediate "All steps complete." markers. Keyed on
        thread_id = session_id from the run config.
        """
        sid = ((config or {}).get("configurable", {}) or {}).get("thread_id")
        if not sid:
            return ""
        try:
            from ..models import ChatMessage
            rows = (db.query(ChatMessage)
                    .filter(ChatMessage.session_id == int(sid))
                    .order_by(ChatMessage.id.desc())
                    .limit(max_turns + 1).all())
        except Exception:
            return ""
        rows = list(reversed(rows))
        # Drop the current question (last user row, just inserted by /chat).
        if rows and rows[-1].role == "user":
            rows = rows[:-1]
        lines = []
        for m in rows:
            content = (m.content or "").strip()
            if not content:
                continue
            speaker = "User" if m.role == "user" else "Assistant"
            lines.append(f"{speaker}: {content}")
        return "\n".join(lines)[-max_chars:]

    # ── Router node (fast-path entry, #3) ────────────────────────────────────
    def _classify_route(user_msg: str, history: str = "") -> str:
        """Tiny LLM classifier → 'chat' | 'simple' | 'complex'. Sees recent
        dialogue so a bare confirmation ('yes do it') is classified by the task
        it continues, not as chat. Defaults to the safe 'complex' on any failure
        or unparseable output."""
        prompt = [SystemMessage(content=ROUTER_PROMPT.format(
            history=history or "(no earlier conversation)", user_question=user_msg))]
        try:
            # guided_choice constrains output to exactly one label; the substring
            # match below is a safety net for the unguided fallback path.
            txt = _guided_text(router_model, fast, prompt, "router").strip().lower()
        except Exception as e:
            log.warning("Router classifier failed, defaulting to complex: %s", e)
            return "complex"
        if "chat" in txt:
            return "chat"
        if "simple" in txt:
            return "simple"
        return "complex"

    def router_node(state: AgentState):
        """Decide how much pipeline this turn needs. Heuristic first (0 cost);
        the LLM classifier (with history) runs when the heuristic is unsure OR
        when we're mid-investigation — because a tool-less chat answer to a
        task-continuation ('yes do it') would strand the task."""
        msgs = state["messages"]
        user_msg = ""
        for m in reversed(msgs):
            if getattr(m, "type", None) == "human":
                user_msg = m.content or ""
                break
        if not settings.agent_fast_path:
            return {"route": "complex"}
        # An active investigation = this thread already called tools. A short
        # affirmation there is a continuation, not chit-chat.
        has_tool_context = any(
            getattr(m, "type", None) == "tool"
            or (getattr(m, "type", None) == "ai" and getattr(m, "tool_calls", None))
            for m in msgs)
        route = _heuristic_route(user_msg)
        if route == "chat" and has_tool_context:
            route = None  # don't fast-path mid-task; let the classifier+history judge
        if route is None:
            route = _classify_route(user_msg, _recent_dialogue(msgs))
        log.info("Router: %r (tool_ctx=%s) -> %s", user_msg[:50], has_tool_context, route)
        return {"route": route, "suff_retries": 0}  # reset the gate counter each turn

    # ── Direct-answer node (chat route — no planner, no tools) ────────────────
    def direct_answer_node(state: AgentState):
        """Answer a conversational turn in a single LLM call."""
        msgs = _model_view(list(state["messages"]), settings.agent_max_context_tokens)
        prompt = [SystemMessage(content=CHAT_PROMPT)]
        if context_msg:
            prompt.append(SystemMessage(content=context_msg))
        prompt += msgs
        return {"messages": [fast.invoke(prompt)]}

    # ── Planner node ─────────────────────────────────────────────────────────
    def planner_node(state: AgentState, config):
        """Generate a step-by-step plan before the agent begins executing.

        The plan is injected as a SystemMessage so the agent can reference it
        during its tool-calling loop. For simple queries, the planner outputs
        a 1-step plan so overhead is minimal. Prior conversation turns are
        supplied so follow-up references are resolved during planning.
        """
        # Find the last human message (the user's question)
        user_msg = ""
        for msg in reversed(state["messages"]):
            if getattr(msg, "type", None) == "human":
                user_msg = msg.content
                break

        if not user_msg:
            # No user message found — skip planning
            return {"messages": []}

        history = _planner_history(config)
        prompt = PLANNER_PROMPT.format(
            tool_list=tool_descriptions,
            history=history or "(no earlier conversation)",
            user_question=user_msg,
        )
        plan_input = ([SystemMessage(content=context_msg)] if context_msg else [])
        plan_input.append(SystemMessage(content=prompt))
        try:
            raw = _guided_text(planner_model, reasoning, plan_input, "planner")
        except Exception as e:
            # Planning is best-effort scaffolding — never fail the turn over it.
            log.warning("Planner failed (%s) — proceeding without a plan", e)
            return {"messages": []}

        plan_text = _strip_think(raw or "").strip()
        # guided_json yields {"steps": [...]}; flatten it to the numbered list the
        # agent reads. Unguided/free-text output that isn't JSON is used verbatim.
        plan_obj = parse_json_object(plan_text)
        rendered = render_plan(plan_obj) if plan_obj else ""
        if rendered:
            plan_text = rendered
        if not plan_text:
            return {"messages": []}
        log.info(f"Plan generated: {plan_text[:200]}")

        # Inject the plan as a system message the agent can follow
        plan_msg = SystemMessage(
            content=f"RESEARCH PLAN (follow these steps in order, then stop):\n{plan_text}"
        )
        return {"messages": [plan_msg]}

    # ── Agent node (executor) ────────────────────────────────────────────────
    def agent_node(state: AgentState):
        """Execute the plan by calling appropriate tools.

        The agent sees: [system_prompt, user_question, plan, ...tool_results]
        and decides which tool to call next based on the plan.

        Already-executed tool signatures are injected (A2/#8) so near-repeats are
        avoided BEFORE the post-hoc loop guard fires. The observed failure mode was
        2-5 redundant calls per turn and a recursion-limit crash on deep multi-hop
        questions; the guard only catches EXACT repeats, after the fact.
        """
        # Build the preamble + anti-duplication note FIRST and reserve their tokens,
        # so trimming accounts for them. Appending after _model_view (as we used to)
        # pushed the request back over the vLLM context window -> a 400 from the
        # server on long guideline turns.
        preamble = [SystemMessage(content=SYSTEM_PROMPT)]
        if context_msg:
            preamble.append(SystemMessage(content=context_msg))
        done = _executed_signatures(state["messages"], tool_arg_names)
        anti_dup = None
        if done:
            listed = "\n".join(f"- {s[:120]}" for s in sorted(done)[:8])
            anti_dup = SystemMessage(content=(
                "ALREADY EXECUTED this turn (their results are above):\n" + listed +
                "\nDo NOT re-issue an IDENTICAL call — its result is already above. "
                "But if one of them returned NOTHING, do retry it with a genuinely "
                "different term (a concrete synonym or organ name instead of an "
                "umbrella term, e.g. colorectal -> colon / rectum) rather than "
                "concluding there is no result. Then continue with the REMAINING "
                "plan steps; only stop once every step is done."))
        reserve = sum(_approx_msg_tokens(m) for m in preamble)
        if anti_dup is not None:
            reserve += _approx_msg_tokens(anti_dup)

        budget = max(1000, settings.agent_max_context_tokens - reserve)
        msgs = _model_view(list(state["messages"]), budget)
        if not msgs or getattr(msgs[0], "type", None) != "system":
            msgs = preamble + msgs
        if anti_dup is not None:
            msgs = msgs + [anti_dup]
        return {"messages": [model.invoke(msgs)]}

    # ── Tool node ────────────────────────────────────────────────────────────
    def tool_node(state: AgentState):
        """Execute tool calls from the agent. Action tools pause for confirmation."""
        last = state["messages"][-1]
        out = []
        for call in getattr(last, "tool_calls", []) or []:
            name = call["name"]
            args = call.get("args", {}) or {}
            cid = call["id"]

            # Confirmation gate for state-changing actions
            if name in ACTION_TOOL_NAMES:
                decision = interrupt({"action": name, "args": args})
                approved = isinstance(decision, dict) and decision.get("approved")
                if not approved:
                    out.append(ToolMessage(
                        content=json.dumps({"summary": "User declined the action.",
                                            "citations": []}),
                        name=name, tool_call_id=cid))
                    continue
                if decision.get("edited_args"):
                    args = {**args, **decision["edited_args"]}

            tool = tools_by_name.get(name)
            if tool is None:
                content = json.dumps({"summary": f"Unknown tool '{name}'",
                                      "citations": []})
            else:
                # Drop kwargs the tool doesn't declare. The model occasionally
                # invents a parameter (observed: sort="recent" on a tool with no
                # such field); passing it through can raise, and — worse — the
                # spurious key made the call look novel to the loop guard, so the
                # same search ran twice and duplicated its result block.
                allowed = tool_arg_names.get(name)
                if allowed is not None:
                    dropped = [k for k in args if k not in allowed]
                    if dropped:
                        log.info("Dropping undeclared arg(s) %s from %s", dropped, name)
                        args = {k: v for k, v in args.items() if k in allowed}
                try:
                    content = tool.invoke(args)
                except Exception as e:
                    content = json.dumps({"summary": f"Tool error: {e}",
                                          "citations": []})

            if not isinstance(content, str):
                content = json.dumps(content, default=str)

            out.append(ToolMessage(content=content, name=name, tool_call_id=cid))
        return {"messages": out}

    # ── Synthesizer node ─────────────────────────────────────────────────────
    def synthesizer_node(state: AgentState):
        """Produce a well-structured final answer from all gathered information.

        This node runs AFTER the agent has finished all tool calls. It sees the
        full conversation (user question, plan, agent reasoning, tool results)
        and produces a clean, clinical-grade narrative.
        """
        # Reserve the synthesis preamble's tokens before trimming (see agent_node):
        # adding it after _model_view can push the request over the context window.
        preamble = [SystemMessage(content=SYNTHESIS_PROMPT)]
        if context_msg:
            preamble.append(SystemMessage(content=context_msg))
        reserve = sum(_approx_msg_tokens(m) for m in preamble)
        budget = max(1000, settings.agent_max_context_tokens - reserve)
        msgs = _model_view(list(state["messages"]), budget)
        return {"messages": [synth.invoke(preamble + msgs)]}

    # ── Routing ──────────────────────────────────────────────────────────────
    # ── Sufficiency gate (catches premature termination) ─────────────────────
    def sufficiency_check_node(state: AgentState):
        """When the agent stops (no tool call), verify the gathered data answers
        every part of the question before synthesizing. If a part is clearly
        missing and we're under the retry cap, nudge the agent back with what to
        gather. Conservative by design so it doesn't stall simple queries."""
        retries = state.get("suff_retries", 0) or 0
        if (not settings.agent_sufficiency_check
                or retries >= settings.agent_max_sufficiency_retries):
            return {"suff_verdict": "ok"}
        msgs = state["messages"]
        user_msg = next((m.content for m in reversed(msgs)
                         if getattr(m, "type", None) == "human"), "")
        gathered = []
        for m in msgs:
            if getattr(m, "type", None) == "tool":
                try:
                    summ = (json.loads(m.content).get("summary") or "")[:200]
                except Exception:
                    summ = (getattr(m, "content", "") or "")[:200]
                gathered.append(f"[{getattr(m, 'name', None)}] {summ}")
        if not gathered:
            return {"suff_verdict": "ok"}   # nothing gathered (chat/simple) — don't gate
        prompt = SUFFICIENCY_PROMPT.format(question=user_msg,
                                           gathered="\n".join(gathered)[:3000])
        try:
            raw = _guided_text(suff_model, fast,
                               [SystemMessage(content=prompt)], "sufficiency")
        except Exception as e:
            log.warning("Sufficiency check failed, proceeding: %s", e)
            return {"suff_verdict": "ok"}
        # guided_json → {"verdict": "sufficient"|"missing", "missing": "..."}.
        obj = parse_json_object(_strip_think(raw))
        if obj is not None:
            if str(obj.get("verdict", "")).strip().lower() != "missing":
                return {"suff_verdict": "ok"}
            missing = str(obj.get("missing", "")).strip()[:300]
        else:
            # Unguided/free-text fallback: honour the legacy "MISSING:" protocol.
            if "missing:" not in (raw or "").lower():
                return {"suff_verdict": "ok"}
            missing = raw.split(":", 1)[1].strip()[:300]
        if not missing:
            return {"suff_verdict": "ok"}   # 'missing' verdict but no detail — don't loop
        log.info("Sufficiency gate retry %d — missing: %s", retries + 1, missing[:80])
        nudge = SystemMessage(content=(
            "You stopped before fully answering. Still missing: " + missing +
            ". Call the tool(s) needed to gather it, then continue — do not answer yet."))
        return {"messages": [nudge], "suff_retries": retries + 1, "suff_verdict": "retry"}

    def route_after_agent(state: AgentState):
        """After agent responds: if it called tools, execute them; if it stopped,
        run the sufficiency gate. Loop guard: if EVERY tool call the agent just
        proposed is an exact repeat of one already executed this run (same name +
        args → same result), the agent is stuck — force synthesis instead of
        looping to the recursion limit. A mix with any new/changed call proceeds."""
        msgs = state["messages"]
        last = msgs[-1]
        calls = getattr(last, "tool_calls", None)
        if not calls:
            return "sufficiency"
        prior = _executed_signatures(msgs[:-1], tool_arg_names)
        if prior and all(_tool_sig(c, tool_arg_names) in prior for c in calls):
            log.info("Loop guard: %d repeated tool call(s) — forcing synthesis",
                     len(calls))
            return "synthesizer"
        return "tools"

    def route_after_suff(state: AgentState):
        return "agent" if state.get("suff_verdict") == "retry" else "synthesizer"

    def route_from_router(state: AgentState):
        """Entry routing (#3): chat -> direct answer (no tools); complex -> full
        planner pipeline. 'simple' only skips the planner when explicitly enabled
        (agent_simple_skips_planner); by default it also uses the planner, which
        keeps the small model anchored (see config note)."""
        r = state.get("route", "complex")
        if r == "chat":
            return "direct_answer"
        if r == "simple" and settings.agent_simple_skips_planner:
            return "agent"
        return "planner"

    # ── Build graph ──────────────────────────────────────────────────────────
    graph = StateGraph(AgentState)

    graph.add_node("router", router_node)
    graph.add_node("direct_answer", direct_answer_node)
    graph.add_node("planner", planner_node)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_node("sufficiency", sufficiency_check_node)
    graph.add_node("synthesizer", synthesizer_node)

    # Flow: START -> router -> {direct_answer | agent | planner}
    #   chat     -> direct_answer -> END                    (1 LLM hop)
    #   simple   -> agent -> {tools loop | sufficiency} -> ...
    #   complex  -> planner -> agent -> {tools loop | sufficiency} -> ...
    #   agent stops -> sufficiency -> {agent (nudge, gather more) | synthesizer}
    graph.add_edge(START, "router")
    graph.add_conditional_edges("router", route_from_router,
                                {"direct_answer": "direct_answer",
                                 "agent": "agent", "planner": "planner"})
    graph.add_edge("direct_answer", END)
    graph.add_edge("planner", "agent")
    graph.add_conditional_edges("agent", route_after_agent,
                                {"tools": "tools", "sufficiency": "sufficiency",
                                 "synthesizer": "synthesizer"})
    graph.add_edge("tools", "agent")
    graph.add_conditional_edges("sufficiency", route_after_suff,
                                {"agent": "agent", "synthesizer": "synthesizer"})
    graph.add_edge("synthesizer", END)

    return graph.compile(checkpointer=get_checkpointer())