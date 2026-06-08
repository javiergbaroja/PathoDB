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

log = logging.getLogger("pathodb_agent")
settings = get_settings()

router = APIRouter(prefix="/assistant", tags=["assistant"])

_SSE_HEADERS = {"X-Accel-Buffering": "no", "Cache-Control": "no-cache"}


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    session_id: int
    message: str

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

def _build_graph(db: Session, user: User):
    """Compile the agent graph or raise 503 if the stack/deps are unavailable."""
    try:
        from ..agent.graph import build_agent_graph
        return build_agent_graph(db, user)
    except ImportError as e:
        raise HTTPException(503, f"Agent dependencies not installed: {e}")
    except Exception as e:
        raise HTTPException(503, f"Agent unavailable: {e}")


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


# ─── Streaming core ───────────────────────────────────────────────────────────

async def _run_stream(graph, graph_input, config, db, session_id, user):
    """Translate a LangGraph run into SSE events and persist the assistant turn."""
    parts: list[str] = []
    citations: list[dict] = []
    interrupted = False
    pending = None
    try:
        async for mode, chunk in graph.astream(graph_input, config, stream_mode=["messages", "updates"]):
            if mode == "messages":
                msg, meta = chunk
                content = getattr(msg, "content", "") or ""
                if content and meta.get("langgraph_node") == "synthesizer":   # <-- CHANGE 1
                    parts.append(content)
                    yield sse({"token": content})
            elif mode == "updates":
                for node, update in (chunk or {}).items():
                    if node == "planner":                                      # <-- CHANGE 2a
                        yield sse({"stage": "planning"})
                    elif node == "synthesizer":                                # <-- CHANGE 2b
                        yield sse({"stage": "synthesizing"})
                    elif node == "__interrupt__":
                        intr = update[0] if isinstance(update, (list, tuple)) else update
                        pending = getattr(intr, "value", intr)
                        interrupted = True
                        _audit(db, user, session_id, "safe_action_requested",
                               tool_name=(pending or {}).get("action"), payload=pending)
                        yield sse({"confirmation_request": pending})
                    elif node == "agent":
                        for m in (update or {}).get("messages", []):
                            for tc in (getattr(m, "tool_calls", None) or []):
                                _audit(db, user, session_id, "tool_call",
                                       tool_name=tc.get("name"), payload=tc.get("args"))
                                yield sse({"tool_call": {"name": tc.get("name"), "args": tc.get("args", {})}})
                    elif node == "tools":
                        for m in (update or {}).get("messages", []):
                            data = parse_tool_content(getattr(m, "content", "") or "")
                            yield sse({"tool_result": {"name": getattr(m, "name", None),
                                                       "summary": data.get("summary")}})
                            if data.get("citations"):
                                citations.extend(data["citations"])
                                yield sse({"citations": data["citations"]})
    except Exception as e:  # pragma: no cover - runtime/LLM dependent
        log.error("Agent stream failed: %s", e, exc_info=True)
        yield sse({"error": str(e)})
        yield DONE
        return

    final_text = "".join(parts).strip()
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
    _audit(db, user, req.session_id, "query", payload={"chars": len(req.message)})

    graph = _build_graph(db, user)
    from langchain_core.messages import HumanMessage
    config = {"configurable": {"thread_id": str(req.session_id)},
              "recursion_limit": settings.agent_max_iterations * 2}
    graph_input = {"messages": [HumanMessage(content=req.message)]}
    return StreamingResponse(
        _run_stream(graph, graph_input, config, db, req.session_id, user),
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
