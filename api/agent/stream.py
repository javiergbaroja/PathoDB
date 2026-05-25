"""SSE framing helpers for the agent chat stream.

Event schema (extends summarize.py's): reuses {"token"}, {"error"}, [DONE] and
adds {"tool_call"}, {"tool_result"}, {"citations"}, {"confirmation_request"},
{"done_turn"}.
"""
import json

DONE = b"data: [DONE]\n\n"


def sse(obj) -> bytes:
    return f"data: {json.dumps(obj, default=str)}\n\n".encode()


def parse_tool_content(content: str) -> dict:
    try:
        data = json.loads(content)
        return data if isinstance(data, dict) else {"summary": str(data), "citations": []}
    except Exception:
        return {"summary": content, "citations": []}
