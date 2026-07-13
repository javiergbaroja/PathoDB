"""
PathoDB API — Conversational Agent Router

A LangGraph tool-calling agent served by vLLM (Qwen2.5-14B by default). Streams
over SSE (same transport as summarize.py). Read-only by default; safe actions
(submit_analysis_job, save_cohort) pause via a LangGraph interrupt and only run
after the user confirms through POST /assistant/confirm.

All heavy deps are imported lazily; the endpoints return 503 (not a crash) when
the agent stack or vLLM is unavailable.
"""
import logging
from datetime import datetime, timezone
from typing import Optional, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..auth import get_current_active_user
from ..config import get_settings
from ..models import User, ChatSession, ChatMessage, AgentAudit
from ..agent.stream import sse, parse_tool_content, DONE
from ..agent.trace import RunTrace

log = logging.getLogger("pathodb_agent")
settings = get_settings()

router = APIRouter(prefix="/assistant", tags=["assistant"])

_SSE_HEADERS = {"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ChatContext(BaseModel):
    """What the user is currently looking at, sent by the frontend so the agent
    can resolve 'this slide'/'this patient' without the user copying IDs."""
    route: Optional[str] = None
    scan_id: Optional[int] = None
    patient_code: Optional[str] = None
    patient_id: Optional[int] = None
    project_id: Optional[int] = None
    cohort_id: Optional[int] = None

class ChatRequest(BaseModel):
    session_id: int
    message: str
    context: Optional[ChatContext] = None

class ConfirmRequest(BaseModel):
    session_id: int
    approved: bool
    edited_args: Optional[dict] = None

class SessionResponse(BaseModel):
    id: int
    title: Optional[str] = None


# ─── Helpers ────────────────────────────────────────────────────────────────

def _ensure_enabled():
    if not settings.agent_enabled:
        raise HTTPException(503, "The assistant is disabled (agent_enabled=false).")

def _get_session(session_id: int, user: User, db: Session) -> ChatSession:
    s = db.get(ChatSession, session_id)
    if not s or s.user_id != user.id:
        raise HTTPException(404, "Chat session not found")
    return s

def _audit(db: Session, user: User, session_id: Optional[int], event_type: str,
           tool_name: Optional[str] = None, payload: Optional[dict] = None):
    try:
        db.add(AgentAudit(user_id=user.id, session_id=session_id,
                          event_type=event_type, tool_name=tool_name, payload=payload))
        db.commit()
    except Exception:
        db.rollback()

def _persist_trace(db: Session, user: User, session_id: Optional[int], trace):
    """Store a per-run trace as an agent_audit row (event_type='run_trace')."""
    try:
        _audit(db, user, session_id, "run_trace", payload=trace.to_dict())
    except Exception:
        pass


def _build_graph(db: Session, user: User, context=None):
    """Compile the agent graph or raise 503 if the stack/deps are unavailable."""
    try:
        from ..agent.graph import build_agent_graph
        return build_agent_graph(db, user, context)
    except ImportError as e:
        raise HTTPException(503, f"Agent dependencies not installed: {e}")
    except Exception as e:
        raise HTTPException(503, f"Agent unavailable: {e}")


def _rehydrate_if_needed(graph, config, db: Session, session_id: int) -> list:
    """Seed prior conversation turns when the durable checkpoint is empty.

    Live sessions keep their full state (including tool messages) in the
    checkpointer, so this returns []. Sessions created before the Postgres
    checkpointer existed — or after a checkpoint reset — have chat_message rows
    but no checkpoint; those are replayed from chat_message as plain
    user/assistant turns so multi-turn context is not lost. Runs once per
    session: after the first turn writes a checkpoint, this short-circuits.
    """
    from langchain_core.messages import HumanMessage, AIMessage
    try:
        state = graph.get_state(config)
        if state and state.values.get("messages"):
            return []
    except Exception:
        pass  # no checkpoint yet / checkpointer error → replay from chat_message

    rows = (db.query(ChatMessage)
            .filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id).all())
    # The final row is the user message /chat just inserted; the caller appends
    # it separately, so drop it here to avoid duplicating the current turn.
    if rows and rows[-1].role == "user":
        rows = rows[:-1]

    out: list = []
    for m in rows:
        content = (m.content or "").strip()
        if not content:
            continue
        if m.role == "user":
            out.append(HumanMessage(content=content))
        elif m.role == "assistant":
            out.append(AIMessage(content=content))
    if out:
        log.info("Rehydrated %d prior message(s) for session %s", len(out), session_id)
    return out


# ─── Session endpoints ──────────────────────────────────────────────────────

@router.post("/sessions", response_model=SessionResponse, status_code=201)
def create_session(db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    s = ChatSession(user_id=user.id)
    db.add(s); db.commit(); db.refresh(s)
    return SessionResponse(id=s.id, title=s.title)

@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    rows = (db.query(ChatSession).filter(ChatSession.user_id == user.id)
            .order_by(ChatSession.updated_at.desc()).all())
    return [{"id": s.id, "title": s.title,
             "created_at": s.created_at.isoformat() if s.created_at else None,
             "updated_at": s.updated_at.isoformat() if s.updated_at else None} for s in rows]

@router.get("/sessions/{session_id}")
def get_session(session_id: int, db: Session = Depends(get_db),
                user: User = Depends(get_current_active_user)):
    _get_session(session_id, user, db)
    msgs = (db.query(ChatMessage).filter(ChatMessage.session_id == session_id)
            .order_by(ChatMessage.id).all())
    return [{"id": m.id, "role": m.role, "content": m.content,
             "citations": m.citations, "tool_calls": m.tool_calls,
             "created_at": m.created_at.isoformat() if m.created_at else None} for m in msgs]


@router.get("/health")
async def health(_: User = Depends(get_current_active_user)):
    from ..agent.llm import vllm_health
    from ..agent.embeddings import embeddings_available
    out = {"agent_enabled": settings.agent_enabled, "vllm": await vllm_health()}
    try:
        out["embeddings_available"] = embeddings_available()
    except Exception as e:
        out["embeddings_available"] = False
        out["embeddings_error"] = str(e)
    out["rag_enabled"] = settings.rag_enabled
    return out


@router.get("/traces")
def list_traces(limit: int = 50, session_id: Optional[int] = None,
                db: Session = Depends(get_db),
                user: User = Depends(get_current_active_user)):
    """Recent per-run agent traces for the current user (plan, latencies, token
    counts, tool successes/failures, retrieval hits). Backed by agent_audit."""
    q = (db.query(AgentAudit)
         .filter(AgentAudit.user_id == user.id, AgentAudit.event_type == "run_trace"))
    if session_id is not None:
        q = q.filter(AgentAudit.session_id == session_id)
    rows = q.order_by(AgentAudit.id.desc()).limit(min(limit, 200)).all()
    return [{"id": r.id, "session_id": r.session_id,
             "created_at": r.created_at.isoformat() if r.created_at else None,
             **(r.payload or {})} for r in rows]


# ─── Streaming core ───────────────────────────────────────────────────────────

async def _run_stream(graph, graph_input, config, db, session_id, user, question=None):
    """Translate a LangGraph run into SSE events and persist the assistant turn.

    SSE event types the frontend can render (each is one JSON object):
      {"stage": "routing"|"planning"|"synthesizing"|"answering"|"gathering more"}
                          — coarse progress markers.
      {"plan": "1. …\n2. …"}         — the agent's step-by-step approach (thought
                                        process); emit once after planning.
      {"reasoning": "…"}             — prose the agent writes while deciding
                                        between tool calls (its working-out).
      {"thinking": "…"}              — chain-of-thought tokens from a thinking
                                        model (reasoning_content); streamed, only
                                        present when a thinking model is configured.
      {"tool_call": {"name","args"}} — a tool the agent is invoking.
      {"tool_result": {"name","summary"}} — that tool's result summary.
      {"citations": [...]}           — grounded record links.
      {"token": "…"}                 — final-answer tokens (the user-facing reply).
      {"confirmation_request": {...}}— HITL gate for a state-changing action.
      {"done_turn": {...}} / DONE    — end of turn.
    plan/reasoning/thinking are the "show your work" channels — render them in an
    expandable trace panel, separate from the final answer tokens.
    """
    parts: list[str] = []
    citations: list[dict] = []
    interrupted = False
    pending = None
    trace = RunTrace(model=settings.vllm_model,
                     question_chars=len(question) if question else 0)
    try:
        async for mode, chunk in graph.astream(graph_input, config, stream_mode=["messages", "updates"]):
            if mode == "messages":
                msg, meta = chunk
                node = meta.get("langgraph_node")
                content = getattr(msg, "content", "") or ""
                # Background "thinking" (chain-of-thought). A thinking model served
                # with vLLM --reasoning-parser emits it as reasoning_content, which
                # langchain surfaces in additional_kwargs. Stream it on a separate
                # 'thinking' channel so the UI can show an expandable thought
                # process (dormant unless a thinking model is configured).
                rc = (getattr(msg, "additional_kwargs", {}) or {}).get("reasoning_content")
                if rc and node in ("planner", "agent", "synthesizer"):
                    yield sse({"thinking": rc})
                if content and node in ("synthesizer", "direct_answer"):
                    trace.on_first_token()
                    parts.append(content)
                    yield sse({"token": content})
            elif mode == "updates":
                for node, update in (chunk or {}).items():
                    if node == "router":
                        yield sse({"stage": "routing"})
                    elif node == "sufficiency":
                        if (update or {}).get("suff_verdict") == "retry":
                            yield sse({"stage": "gathering more"})
                    elif node == "direct_answer":
                        trace.on_synth_messages((update or {}).get("messages", []))
                        yield sse({"stage": "answering"})
                    elif node == "planner":
                        plan_text = ""
                        for m in (update or {}).get("messages", []):
                            c = getattr(m, "content", "") or ""
                            trace.on_plan(c)
                            plan_text = c or plan_text
                        yield sse({"stage": "planning"})
                        if plan_text:
                            # Drop the internal "RESEARCH PLAN (...):" preamble so the
                            # UI shows just the numbered steps as the agent's approach.
                            disp = (plan_text.split(":", 1)[1].strip()
                                    if plan_text.startswith("RESEARCH PLAN") else plan_text)
                            yield sse({"plan": disp})
                    elif node == "synthesizer":
                        trace.on_synth_messages((update or {}).get("messages", []))
                        yield sse({"stage": "synthesizing"})
                    elif node == "__interrupt__":
                        intr = update[0] if isinstance(update, (list, tuple)) else update
                        pending = getattr(intr, "value", intr)
                        interrupted = True
                        _audit(db, user, session_id, "safe_action_requested",
                               tool_name=(pending or {}).get("action"), payload=pending)
                        yield sse({"confirmation_request": pending})
                    elif node == "agent":
                        trace.on_agent_messages((update or {}).get("messages", []))
                        for m in (update or {}).get("messages", []):
                            # Any prose the agent writes while deciding = its
                            # step-by-step reasoning; surface it on a 'reasoning'
                            # channel (distinct from the final answer 'token's).
                            c = (getattr(m, "content", "") or "").strip()
                            if c:
                                yield sse({"reasoning": c})
                            for tc in (getattr(m, "tool_calls", None) or []):
                                _audit(db, user, session_id, "tool_call",
                                       tool_name=tc.get("name"), payload=tc.get("args"))
                                yield sse({"tool_call": {"name": tc.get("name"), "args": tc.get("args", {})}})
                    elif node == "tools":
                        for m in (update or {}).get("messages", []):
                            data = parse_tool_content(getattr(m, "content", "") or "")
                            trace.on_tool_result(getattr(m, "name", None), data)
                            yield sse({"tool_result": {"name": getattr(m, "name", None),
                                                       "summary": data.get("summary")}})
                            if data.get("citations"):
                                citations.extend(data["citations"])
                                yield sse({"citations": data["citations"]})
    except Exception as e:  # pragma: no cover - runtime/LLM dependent
        log.error("Agent stream failed: %s", e, exc_info=True)
        trace.error = str(e)
        _persist_trace(db, user, session_id, trace)
        yield sse({"error": str(e)})
        yield DONE
        return

    final_text = "".join(parts).strip()
    trace.answer_chars = len(final_text)
    trace.interrupted = interrupted
    _persist_trace(db, user, session_id, trace)
    if final_text or citations:
        try:
            db.add(ChatMessage(session_id=session_id, role="assistant",
                               content=final_text or None, citations=citations or None))
            sess = db.get(ChatSession, session_id)
            if sess:
                sess.updated_at = datetime.now(timezone.utc)
            db.commit()
        except Exception:
            db.rollback()
    yield sse({"done_turn": {"session_id": session_id, "interrupted": interrupted}})
    yield DONE


@router.post("/chat")
async def chat(req: ChatRequest, db: Session = Depends(get_db),
               user: User = Depends(get_current_active_user)):
    _ensure_enabled()
    if not req.message or not req.message.strip():
        raise HTTPException(422, "Empty message")
    if len(req.message) > settings.agent_max_input_chars:
        raise HTTPException(422, f"Message too long (max {settings.agent_max_input_chars} chars)")
    _get_session(req.session_id, user, db)

    db.add(ChatMessage(session_id=req.session_id, role="user", content=req.message))
    db.commit()
    _audit(db, user, req.session_id, "query",
           payload={"chars": len(req.message),
                    "context": req.context.model_dump(exclude_none=True) if req.context else None})

    graph = _build_graph(db, user, req.context)
    from langchain_core.messages import HumanMessage
    config = {"configurable": {"thread_id": str(req.session_id)},
              "recursion_limit": settings.agent_max_iterations * 2}
    messages = _rehydrate_if_needed(graph, config, db, req.session_id)
    messages.append(HumanMessage(content=req.message))
    graph_input = {"messages": messages}
    return StreamingResponse(
        _run_stream(graph, graph_input, config, db, req.session_id, user,
                    question=req.message),
        media_type="text/event-stream", headers=_SSE_HEADERS)


@router.post("/confirm")
async def confirm(req: ConfirmRequest, db: Session = Depends(get_db),
                  user: User = Depends(get_current_active_user)):
    _ensure_enabled()
    _get_session(req.session_id, user, db)
    _audit(db, user, req.session_id,
           "safe_action_approved" if req.approved else "safe_action_rejected",
           payload={"edited_args": req.edited_args})

    graph = _build_graph(db, user)
    from langgraph.types import Command
    config = {"configurable": {"thread_id": str(req.session_id)},
              "recursion_limit": settings.agent_max_iterations * 2}
    resume = {"approved": bool(req.approved), "edited_args": req.edited_args}
    return StreamingResponse(
        _run_stream(graph, Command(resume=resume), config, db, req.session_id, user),
        media_type="text/event-stream", headers=_SSE_HEADERS)
