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

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User
from .checkpoint import get_checkpointer
from .prompts import SYSTEM_PROMPT, PLANNER_PROMPT, SYNTHESIS_PROMPT
from .tools import get_tools, ACTION_TOOL_NAMES

log = logging.getLogger("pathodb_agent")


def build_agent_graph(db: Session, user: User):
    """Compile the plan-and-execute agent graph for this request."""
    from typing import Annotated, TypedDict
    from langchain_core.messages import SystemMessage, HumanMessage, ToolMessage
    from langgraph.graph import StateGraph, START, END
    from langgraph.graph.message import add_messages
    from langgraph.types import interrupt

    from .llm import get_chat_model, get_reasoning_model

    settings = get_settings()

    class AgentState(TypedDict):
        messages: Annotated[list, add_messages]

    tools = get_tools(db, user)
    tools_by_name = {t.name: t for t in tools}
    model = get_chat_model().bind_tools(tools)
    reasoning = get_reasoning_model()

    # ── Available tool names for the planner prompt ──────────────────────────
    tool_descriptions = "\n".join(
        f"- {t.name}: {t.description[:120]}" for t in tools
    )

    # ── Planner node ─────────────────────────────────────────────────────────
    def planner_node(state: AgentState):
        """Generate a step-by-step plan before the agent begins executing.

        The plan is injected as a SystemMessage so the agent can reference it
        during its tool-calling loop. For simple queries, the planner outputs
        a 1-step plan so overhead is minimal.
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

        prompt = PLANNER_PROMPT.format(
            tool_list=tool_descriptions,
            user_question=user_msg,
        )
        plan_response = reasoning.invoke([
            SystemMessage(content=prompt),
        ])

        plan_text = plan_response.content.strip()
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
        """
        msgs = state["messages"]
        if not msgs or getattr(msgs[0], "type", None) != "system":
            msgs = [SystemMessage(content=SYSTEM_PROMPT)] + list(msgs)
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
        msgs = list(state["messages"])

        # Build a synthesis-focused message list:
        # [synthesis_prompt, ...full_conversation]
        synth_msgs = [SystemMessage(content=SYNTHESIS_PROMPT)] + msgs
        return {"messages": [reasoning.invoke(synth_msgs)]}

    # ── Routing ──────────────────────────────────────────────────────────────
    def route_after_agent(state: AgentState):
        """After agent responds: if it called tools, execute them.
        Otherwise, move to synthesis."""
        last = state["messages"][-1]
        if getattr(last, "tool_calls", None):
            return "tools"
        return "synthesizer"

    # ── Build graph ──────────────────────────────────────────────────────────
    graph = StateGraph(AgentState)

    graph.add_node("planner", planner_node)
    graph.add_node("agent", agent_node)
    graph.add_node("tools", tool_node)
    graph.add_node("synthesizer", synthesizer_node)

    # Flow: START -> planner -> agent -> {tools loop | synthesizer} -> END
    graph.add_edge(START, "planner")
    graph.add_edge("planner", "agent")
    graph.add_conditional_edges("agent", route_after_agent,
                                {"tools": "tools", "synthesizer": "synthesizer"})
    graph.add_edge("tools", "agent")
    graph.add_edge("synthesizer", END)

    return graph.compile(checkpointer=get_checkpointer())