"""LangGraph agent graph.

Built per request (closing over the request's db session + user) but sharing a
module-level checkpointer so a safe-action `interrupt()` can pause one request
and resume in a later /confirm request under the same thread_id.

Graph: START -> agent -> (tool_calls? tools : END) -> agent ...
The tool node executes read tools immediately; for safe actions it calls
interrupt({action, args}) and only runs them after the resumed value approves.
"""
import json
import logging

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User
from .checkpoint import get_checkpointer
from .prompts import SYSTEM_PROMPT
from .tools import get_tools, ACTION_TOOL_NAMES

log = logging.getLogger("pathodb_agent")


def build_agent_graph(db: Session, user: User):
    """Compile the agent graph for this request. Lazily imports langgraph/langchain."""
    from typing import Annotated, TypedDict
    from langchain_core.messages import SystemMessage, ToolMessage
    from langgraph.graph import StateGraph, START, END
    from langgraph.graph.message import add_messages
    from langgraph.types import interrupt

    from .llm import get_chat_model

    class AgentState(TypedDict):
        messages: Annotated[list, add_messages]

    tools = get_tools(db, user)
    tools_by_name = {t.name: t for t in tools}
    model = get_chat_model().bind_tools(tools)

    def agent_node(state: AgentState):
        msgs = state["messages"]
        if not msgs or getattr(msgs[0], "type", None) != "system":
            msgs = [SystemMessage(content=SYSTEM_PROMPT)] + list(msgs)
        return {"messages": [model.invoke(msgs)]}

    def tool_node(state: AgentState):
        last = state["messages"][-1]
        out = []
        for call in getattr(last, "tool_calls", []) or []:
            name = call["name"]
            args = call.get("args", {}) or {}
            cid = call["id"]
            if name in ACTION_TOOL_NAMES:
                decision = interrupt({"action": name, "args": args})  # pauses until /confirm
                approved = isinstance(decision, dict) and decision.get("approved")
                if not approved:
                    out.append(ToolMessage(
                        content=json.dumps({"summary": "User declined the action.", "citations": []}),
                        name=name, tool_call_id=cid))
                    continue
                if decision.get("edited_args"):
                    args = {**args, **decision["edited_args"]}
            tool = tools_by_name.get(name)
            if tool is None:
                content = json.dumps({"summary": f"Unknown tool '{name}'", "citations": []})
            else:
                try:
                    content = tool.invoke(args)
                except Exception as e:  # pragma: no cover - runtime/LLM dependent
                    content = json.dumps({"summary": f"Tool error: {e}", "citations": []})
            if not isinstance(content, str):
                content = json.dumps(content, default=str)
            out.append(ToolMessage(content=content, name=name, tool_call_id=cid))
        return {"messages": out}

    def route(state: AgentState):
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    graph = StateGraph(AgentState)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", route, {"tools": "tools", END: END})
    graph.add_edge("tools", "agent")
    return graph.compile(checkpointer=get_checkpointer())
