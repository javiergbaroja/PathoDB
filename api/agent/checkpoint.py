"""LangGraph checkpointer provider.

Durable conversation state keyed on thread_id = chat session id, backed by a
process-wide psycopg pool. Survives API restarts and is safe across uvicorn
workers, so a cold graph reconstructs prior turns instead of forgetting them.

CRITICAL — sync vs async:
    The FastAPI server drives the graph with `graph.astream` (async), whose loop
    calls the checkpointer's *async* methods (aget_tuple/aput). The sync
    PostgresSaver does NOT implement those (raises NotImplementedError), so the
    server MUST use AsyncPostgresSaver. The eval harness drives the graph with
    `graph.invoke` (sync) and needs the sync PostgresSaver. AsyncPostgresSaver
    and PostgresSaver are disjoint (each implements only one half); only
    MemorySaver implements both.

    So the async server calls `init_async_checkpointer()` from its lifespan to
    install the AsyncPostgresSaver singleton; any other (sync) process lets
    get_checkpointer() lazily build the sync PostgresSaver. Both share the same
    checkpoint tables.

Falls back to an in-process MemorySaver if Postgres is unreachable or
`agent_checkpointer='memory'`. MemorySaver implements both sync and async, so it
is always a safe fallback. The fallback is logged loudly because it
re-introduces the durability gap it is meant to fix.
"""
import logging

from ..config import get_settings

log = logging.getLogger("pathodb_agent")

_saver = None
_pool = None          # sync ConnectionPool
_async_pool = None    # AsyncConnectionPool


def _normalize_dsn(dsn: str) -> str:
    """psycopg wants a plain libpq URI, not a SQLAlchemy driver URL."""
    for prefix in ("postgresql+psycopg2", "postgresql+psycopg", "postgres+psycopg2"):
        if dsn.startswith(prefix):
            return "postgresql" + dsn[len(prefix):]
    return dsn


def _memory_saver(reason: str = ""):
    global _saver
    from langgraph.checkpoint.memory import MemorySaver
    _saver = MemorySaver()
    log.info("Agent checkpointer: MemorySaver (in-process, non-durable)%s",
             f" — {reason}" if reason else "")
    return _saver


async def init_async_checkpointer():
    """Install the async-capable checkpointer for the FastAPI server. Call once
    from the app lifespan BEFORE any request builds the graph. Idempotent."""
    global _saver, _async_pool
    if _saver is not None:
        return _saver

    settings = get_settings()
    if settings.agent_checkpointer != "postgres":
        return _memory_saver()

    try:
        from psycopg_pool import AsyncConnectionPool
        from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

        dsn = _normalize_dsn(settings.agent_checkpointer_dsn or settings.database_url)
        _async_pool = AsyncConnectionPool(
            conninfo=dsn,
            max_size=settings.agent_checkpointer_pool_size,
            # autocommit + no prepared-statement cache are required by the
            # Postgres saver (it manages its own transactions and pipelines).
            kwargs={"autocommit": True, "prepare_threshold": 0},
            open=False,
        )
        await _async_pool.open()
        saver = AsyncPostgresSaver(_async_pool)
        await saver.setup()  # idempotent: creates the checkpoint tables if missing
        _saver = saver
        log.info("Agent checkpointer: AsyncPostgresSaver (durable, async)")
        return _saver
    except Exception as e:
        log.error(
            "AsyncPostgresSaver unavailable (%s) — falling back to in-process "
            "MemorySaver. Conversation memory will NOT survive restarts or scale "
            "past one worker. Check the checkpointer DSN and that the role may "
            "CREATE tables.", e, exc_info=True,
        )
        if _async_pool is not None:
            try:
                await _async_pool.close()
            except Exception:
                pass
            _async_pool = None
        return _memory_saver("async Postgres setup failed")


async def close_checkpointer():
    """Close the async pool on app shutdown."""
    global _async_pool
    if _async_pool is not None:
        try:
            await _async_pool.close()
        except Exception:
            pass
        _async_pool = None


def get_checkpointer():
    """Return the process-wide checkpointer singleton.

    If the async server already installed one (init_async_checkpointer), return
    it. Otherwise — a sync process such as the eval harness — lazily build the
    sync PostgresSaver, which works with graph.invoke().
    """
    global _saver, _pool
    if _saver is not None:
        return _saver

    settings = get_settings()

    if settings.agent_checkpointer == "postgres":
        try:
            from psycopg_pool import ConnectionPool
            from langgraph.checkpoint.postgres import PostgresSaver

            dsn = _normalize_dsn(settings.agent_checkpointer_dsn or settings.database_url)
            _pool = ConnectionPool(
                conninfo=dsn,
                max_size=settings.agent_checkpointer_pool_size,
                kwargs={"autocommit": True, "prepare_threshold": 0},
                open=False,
            )
            _pool.open()
            saver = PostgresSaver(_pool)
            saver.setup()  # idempotent: creates the checkpoint tables if missing
            _saver = saver
            log.info("Agent checkpointer: PostgresSaver (durable, sync)")
            return _saver
        except Exception as e:
            log.error(
                "PostgresSaver unavailable (%s) — falling back to in-process "
                "MemorySaver. Conversation memory will NOT survive restarts or "
                "scale past one worker. Check the checkpointer DSN and that the "
                "role may CREATE tables.", e, exc_info=True,
            )
            if _pool is not None:
                try:
                    _pool.close()
                except Exception:
                    pass
                _pool = None

    return _memory_saver()
