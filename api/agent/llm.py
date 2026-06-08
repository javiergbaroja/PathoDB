"""vLLM (OpenAI-compatible) chat model factory + health probe.

vLLM is served out-of-process (docs/AGENT_SERVING.md). The agent talks to it via
LangChain's ChatOpenAI pointed at the local base_url.
"""
import logging

from ..config import get_settings

log = logging.getLogger("pathodb_agent")


def get_chat_model():
    """Return a streaming ChatOpenAI bound to the local vLLM server (lazy import).

    Used by the executor node — tools are bound externally in graph.py.
    """
    settings = get_settings()
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        base_url=settings.vllm_base_url,
        api_key=settings.vllm_api_key,
        model=settings.vllm_model,
        temperature=settings.vllm_temperature,
        max_tokens=settings.vllm_max_tokens,
        timeout=settings.vllm_request_timeout,
        streaming=True,
    )


def get_reasoning_model():
    """Return a streaming ChatOpenAI for planning and synthesis (no tools).

    Same vLLM model but with a slightly higher temperature for more natural
    prose in the synthesizer, and no tools bound (the planner and synthesizer
    never call tools — they only reason over text).
    """
    settings = get_settings()
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(
        base_url=settings.vllm_base_url,
        api_key=settings.vllm_api_key,
        model=settings.vllm_model,
        temperature=0.25,
        max_tokens=settings.vllm_max_tokens,
        timeout=settings.vllm_request_timeout,
        streaming=True,
    )


async def vllm_health() -> dict:
    """Probe the vLLM /models endpoint. Mirrors summarize.ollama_health shape."""
    settings = get_settings()
    url = settings.vllm_base_url.rstrip("/") + "/models"
    try:
        import httpx
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {settings.vllm_api_key}"})
            resp.raise_for_status()
            data = resp.json()
            models = [m.get("id") for m in data.get("data", [])]
            return {
                "status": "ok",
                "base_url": settings.vllm_base_url,
                "configured_model": settings.vllm_model,
                "available_models": models,
                "model_available": (settings.vllm_model in models) if models else False,
            }
    except Exception as e:
        return {"status": "offline", "base_url": settings.vllm_base_url, "error": str(e)}