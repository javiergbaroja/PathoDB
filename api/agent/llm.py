"""vLLM (OpenAI-compatible) chat model factory + health probe.

vLLM is served out-of-process (docs/AGENT_SERVING.md). The agent talks to it via
LangChain's ChatOpenAI pointed at the local base_url.
"""
import logging

from ..config import get_settings

log = logging.getLogger("pathodb_agent")


def _extra_body(model: str, thinking=None) -> dict:
    """Vendor request extensions keyed off the served model.

    Qwen3 "thinking" models emit <think>…</think> before the answer. In the
    tool-calling loop and the router that breaks parsing, so it must be OFF; in
    the planner/synthesizer it can be ON (roadmap #10) — ideally with the server
    started with --reasoning-parser so `content` stays clean.

    `thinking`: True/False forces enable_thinking; None = auto (disable for base
    Qwen3, which defaults to thinking; leave other models unset). Non-Qwen3
    models ignore the flag.
    """
    if thinking is not None:
        return {"chat_template_kwargs": {"enable_thinking": bool(thinking)}}
    m = (model or "").lower()
    if "qwen3" in m and "2507" not in m:
        return {"chat_template_kwargs": {"enable_thinking": False}}
    return {}


def _chat(base_url, model, temperature, thinking=None, guided=None):
    """Build a streaming ChatOpenAI for one model profile.

    `guided`: an optional vLLM guided-decoding fragment (e.g.
    {"guided_choice": [...]} or {"guided_json": {...}}) merged INTO the vendor
    extra_body rather than replacing it, so a guided profile keeps its thinking
    kwargs. The constraint is baked into this instance, so guided and unguided
    variants of the same profile are separate objects.
    """
    settings = get_settings()
    from langchain_openai import ChatOpenAI
    body = dict(_extra_body(model, thinking) or {})
    if guided:
        body.update(guided)
    return ChatOpenAI(
        base_url=base_url,
        api_key=settings.vllm_api_key,
        model=model,
        temperature=temperature,
        max_tokens=settings.vllm_max_tokens,
        timeout=settings.vllm_request_timeout,
        streaming=True,
        # Ask vLLM for token usage even when streaming (stream_options.include_usage);
        # without it streamed responses carry no usage_metadata (eval + RunTrace
        # would report zero tokens).
        stream_usage=True,
        extra_body=body or None,
    )


def get_chat_model():
    """Tool-calling agent model (the default vllm_model). Tools bound in graph.py."""
    s = get_settings()
    return _chat(s.vllm_base_url, s.vllm_model, s.vllm_temperature)


def get_fast_model(guided=None):
    """Fast, always-non-thinking model for the router classifier and direct chat
    answers — these must stay snappy and never emit <think>. `guided` optionally
    constrains decoding (e.g. the router's guided_choice)."""
    s = get_settings()
    return _chat(s.vllm_base_url, s.vllm_model, s.vllm_temperature, thinking=False,
                 guided=guided)


def get_reasoning_model(guided=None):
    """Planner + synthesizer model (#10). Uses the reasoning profile when
    configured (a separate endpoint/model, optionally a Qwen3 thinking model);
    otherwise the default model — so this is a no-op until configured. `guided`
    optionally constrains decoding (the planner's guided_json); callers must not
    pass it for a thinking model — a <think> preamble can't satisfy a strict JSON
    grammar (the graph gates this)."""
    s = get_settings()
    base_url = s.vllm_reasoning_base_url or s.vllm_base_url
    model = s.vllm_reasoning_model or s.vllm_model
    thinking = True if s.vllm_reasoning_enable_thinking else None
    return _chat(base_url, model, s.vllm_reasoning_temperature, thinking=thinking,
                 guided=guided)


def get_synth_model():
    """Synthesizer model — writes the final answer/interpretation. Uses the synth
    profile if set, else the reasoning profile, else the default. Lets a medical
    model (e.g. MedGemma) write clinical prose while a general model plans."""
    s = get_settings()
    base_url = s.vllm_synth_base_url or s.vllm_reasoning_base_url or s.vllm_base_url
    model = s.vllm_synth_model or s.vllm_reasoning_model or s.vllm_model
    if s.vllm_synth_model:
        thinking = True if s.vllm_synth_enable_thinking else None
    else:
        thinking = True if s.vllm_reasoning_enable_thinking else None
    return _chat(base_url, model, s.vllm_reasoning_temperature, thinking=thinking)


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