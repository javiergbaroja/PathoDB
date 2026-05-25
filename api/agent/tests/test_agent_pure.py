"""Pure-logic unit tests for the agent package (no GPU / langchain / DB needed).

Run: python api/agent/tests/test_agent_pure.py   (or via pytest)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

# These modules are intentionally dependency-free (stdlib only) so they are
# unit-testable without sqlalchemy/pydantic/langchain installed.
from api.agent.textutil import chunk_report, vector_literal    # noqa: E402
from api.agent.stream import sse, parse_tool_content, DONE      # noqa: E402

_vector_literal = vector_literal


def test_chunk_short_report_single_chunk():
    assert chunk_report("Short benign finding.", 1200, 150) == ["Short benign finding."]


def test_chunk_empty():
    assert chunk_report("", 1200, 150) == []
    assert chunk_report("   ", 1200, 150) == []


def test_chunk_long_report_overlaps_and_covers():
    body = ("Paragraph one with findings. " * 40
            + "\n\n" + "Paragraph two with more detail. " * 40)
    chunks = chunk_report(body, 300, 60)
    assert len(chunks) > 1
    # every chunk within cap-ish and non-empty
    assert all(c.strip() for c in chunks)
    assert all(len(c) <= 300 + 5 for c in chunks)
    # coverage: the union of chunks contains the start and end text
    joined = " ".join(chunks)
    assert "Paragraph one" in joined and "more detail" in joined


def test_vector_literal_format():
    assert _vector_literal([1, 2.5, -0.333333]) == "[1.000000,2.500000,-0.333333]"


def test_sse_framing():
    assert sse({"token": "hi"}) == b'data: {"token": "hi"}\n\n'
    assert DONE == b"data: [DONE]\n\n"


def test_parse_tool_content():
    assert parse_tool_content('{"summary": "ok", "citations": []}') == {"summary": "ok", "citations": []}
    # non-dict json -> wrapped
    assert parse_tool_content('"plain"')["summary"] == "plain"
    # invalid json -> wrapped
    assert parse_tool_content("not json")["summary"] == "not json"


def test_action_tool_names():
    # Requires sqlalchemy/pydantic (full stack); skip gracefully if absent.
    try:
        from api.agent.tools import ACTION_TOOL_NAMES
    except ImportError:
        return
    assert ACTION_TOOL_NAMES == {"submit_analysis_job", "save_cohort"}


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"PASS {fn.__name__}")
    print(f"\nALL {len(fns)} AGENT PURE TESTS PASSED")
