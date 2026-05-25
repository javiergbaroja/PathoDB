"""LangGraph checkpointer provider.

v1 uses an in-process MemorySaver: it is sufficient for the confirmation
round-trip (the /chat interrupt and the follow-up /confirm hit the same uvicorn
process and resume the same thread_id). For multi-worker / restart-durable
deployments, swap this for langgraph-checkpoint-postgres (PostgresSaver), which
is already listed in requirements.txt.
"""
_saver = None


def get_checkpointer():
    global _saver
    if _saver is None:
        from langgraph.checkpoint.memory import MemorySaver
        _saver = MemorySaver()
    return _saver
