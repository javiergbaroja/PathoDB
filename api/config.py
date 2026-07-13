"""
PathoDB API — Configuration
Reads from environment variables / .env file.
"""
from pydantic_settings import BaseSettings
from functools import lru_cache
import torch

class Settings(BaseSettings):
    # Database
    database_url: str

    # JWT
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expiry_hours: int = 8
    jwt_refresh_expiry_days: int = 7

    # API
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    api_title: str = "PathoDB API"
    api_version: str = "1.0.0"

    # CORS — comma-separated list of allowed browser origins. Override in
    # production with the deployed frontend origin(s), e.g.
    #   cors_allow_origins=https://pathodb.example.org
    cors_allow_origins: str = "http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"

    # Scanner service account
    scanner_api_key: str = ""

    # Analysis — DL model inference on HPC
    # analysis_results_dir: absolute path on NFS where model output is written
    # models_dir: absolute path to the directory containing catalog.json and model scripts
    analysis_results_dir: str = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/analysis_results"
    models_dir: str = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models"

    # analysis_output_base_dirs: comma-separated list of absolute directory
    # prefixes under which batch jobs are permitted to write their output.
    # Custom `output_directory` values are only accepted if they resolve to a
    # path inside one of these bases. Leave empty to disable custom output
    # directories entirely (batch output then stays in analysis_results_dir).
    analysis_output_base_dirs: str = ""

    # ── Ollama / Patient Summary ───────────────────────────────────────────────
    # ollama_base_url: HTTP address of the running Ollama daemon.
    #   - Local dev / single-node HPC:  http://localhost:11434
    #   - If Ollama runs on a separate node:  http://<hostname>:11434
    # ollama_model: model tag to use. Must be pulled on the Ollama host.
    #   Recommended for CPU inference: llama3.2:3b (fast, sufficient quality)
    #   Higher quality option:         mistral:7b-instruct-q4_K_M
    # ollama_num_threads: CPU threads passed per-request to llama.cpp.
    #   Rule of thumb: physical_cores - 4  (leave headroom for OS + FastAPI).
    #   On a 24-core HPC allocation, 20 is a safe default.
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2:3b"
    ollama_num_threads: int = 20

    # ── Conversational agent (vLLM, OpenAI-compatible) ─────────────────────────
    # vLLM is served out-of-process (see docs/AGENT_SERVING.md). The agent talks
    # to it via an OpenAI-compatible client. Defaults target one RTX-4090.
    agent_enabled: bool = True
    vllm_base_url: str = "http://localhost:8001/v1"
    vllm_api_key: str = "EMPTY"            # vLLM ignores it; ChatOpenAI requires a value
    vllm_model: str = "Qwen/Qwen2.5-14B-Instruct-AWQ"
    vllm_temperature: float = 0.1
    vllm_max_tokens: int = 2048            # synthesis output ceiling

    # ── Task routing to a reasoning model (#10) ────────────────────────────────
    # The agent (tool-calling) always uses vllm_model above — the bake-off showed
    # Qwen2.5-14B is the most disciplined tool-caller. The PLANNER and SYNTHESIZER
    # (pure reasoning, no tools) can optionally use a separate reasoning model,
    # e.g. a Qwen3 "thinking" model that plans/narrates better. Router + chat
    # always use the fast default model. Empty base_url/model → reasoning uses the
    # default model (routing is a no-op; zero behaviour change).
    #   To exploit Qwen3 thinking cleanly, serve the reasoning endpoint with
    #   vLLM's --reasoning-parser (VLLM_REASONING_PARSER in slurm_vllm.sh) so
    #   <think> goes to a separate field and streamed `content` stays clean.
    vllm_reasoning_base_url: str = ""      # falls back to vllm_base_url
    vllm_reasoning_model: str = ""         # falls back to vllm_model
    vllm_reasoning_enable_thinking: bool = False
    vllm_reasoning_temperature: float = 0.25
    # Synthesizer-only profile: the node that writes the final answer/interpretation
    # can use a different model again (e.g. a medical model like MedGemma for
    # clinical prose) while planning stays on the reasoning/default model. Falls
    # back to the reasoning profile, then the default — so no-op until configured.
    vllm_synth_base_url: str = ""
    vllm_synth_model: str = ""
    vllm_synth_enable_thinking: bool = False
    vllm_request_timeout: float = 120.0
    # Fast path / entry routing (#3). When on, a cheap heuristic (else a tiny LLM
    # classifier) routes each turn: 'chat' answers directly (1 hop, no tools),
    # 'simple' skips the planner (agent->synthesizer), 'complex' uses the full
    # planner pipeline. Off = every turn takes the full planner->agent->synth path.
    agent_fast_path: bool = True
    # Whether the 'simple' route skips the planner. Default OFF: live testing on
    # Qwen2.5-14B showed the planner anchors the small model (gives it a clear
    # stop signal) even for one-shot lookups — skipping it made the agent wander
    # and answer worse. Re-test with a stronger model (bake-off #9) before
    # enabling. When off, 'simple' and 'complex' both use the full planner path;
    # only 'chat' takes the fast path.
    agent_simple_skips_planner: bool = False
    agent_max_iterations: int = 8          # tool-call loop ceiling (guardrail)
    # Sufficiency gate: before synthesizing, a cheap check asks whether every part
    # of the question was actually answered by the gathered data; if not, it sends
    # the agent back with a nudge naming what's missing (bounded by the retry cap).
    # Directly targets premature termination on multi-hop / multi-part questions.
    agent_sufficiency_check: bool = True
    agent_max_sufficiency_retries: int = 2
    agent_max_input_chars: int = 4000      # per-message user input cap
    agent_max_tool_rows: int = 25          # rows from a query surfaced to the model
    # Trim the message history fed to each LLM call to this approx token budget so
    # long / durable conversations can't overflow the vLLM context window. Keep it
    # comfortably below (vLLM --max-model-len) − vllm_max_tokens − prompt headroom.
    agent_max_context_tokens: int = 12000
    agent_max_cells: int = 400000          # cell cap for spatial single-cell feature tools
    # Conversation state. 'postgres' (PostgresSaver) is durable across restarts
    # and safe under multiple workers; 'memory' is in-process only (non-durable).
    agent_checkpointer: str = "postgres"   # 'postgres' | 'memory'
    agent_checkpointer_dsn: str = ""       # falls back to database_url when empty
    agent_checkpointer_pool_size: int = 4  # psycopg pool size for the checkpointer

    # ── Report RAG (pgvector) ──────────────────────────────────────────────────
    # embedding_model / embedding_dim MUST be changed together, and the
    # report_embeddings.embedding column must be vector(embedding_dim). Switching
    # models requires re-embedding the whole corpus (see slurm_embed.sh, which
    # migrates the column dim and truncates on a mismatch).
    rag_enabled: bool = True
    embedding_model: str = "BAAI/bge-m3"             # 1024-dim, 8192-token ctx
    embedding_dim: int = 1024
    embedding_device: str = "cpu" if not torch.cuda.is_available() else "cuda"
    embedding_batch_size: int = 32 if not torch.cuda.is_available() else 128
    # Cap the transformer sequence length. bge-m3 supports 8192 but pathology
    # reports are short; a smaller cap bounds padding cost without truncating.
    embedding_max_seq_length: int = 2048
    # Half-precision weights on GPU (~2x throughput, lower VRAM). Ignored on CPU.
    embedding_fp16: bool = True
    rag_top_k: int = 6
    # bge-m3's long context lets a chunk hold a whole report; larger chunks mean
    # fewer rows, faster ingest, and less retrieval fragmentation.
    rag_max_chunk_chars: int = 6000
    rag_chunk_overlap_chars: int = 200

    # ── Hybrid retrieval + reranking ───────────────────────────────────────────
    # Dense (pgvector cosine) alone misses exact-term / rare-token queries
    # (drug names, mutation strings, ICD-O codes). When rag_hybrid is on we also
    # run a Postgres full-text (tsvector) arm over the same chunks and fuse both
    # ranked lists with Reciprocal Rank Fusion — no score normalization, and it
    # degrades to whichever arm returned rows. Needs the GIN FTS index on
    # report_embeddings.chunk_text (built by slurm_embed.sh / db/schema.sql).
    rag_hybrid: bool = True
    rag_fts_config: str = "english"        # tsvector/tsquery language (corpus is English)
    rag_candidate_pool: int = 40           # candidates pulled per arm before fusion/rerank
    rag_rrf_k: int = 60                     # RRF damping constant (standard default)
    # Optional cross-encoder reranker over the fused candidate pool. Empty string
    # disables it (hybrid fusion still applies). A reranker sharpens precision@k
    # but loads a model + needs a device; enable once you can host it.
    #   recommended: BAAI/bge-reranker-v2-m3  (same family as bge-m3 embedder)
    rag_reranker_model: str = ""
    rag_reranker_device: str = "cpu" if not torch.cuda.is_available() else "cuda"
    rag_reranker_batch_size: int = 32

    # ── Knowledge grounding (glossary + docs) ──────────────────────────────────
    # A SECOND retrieval namespace, distinct from report RAG: the agent's
    # search_documentation tool grounds answers in PathoDB's own governed
    # vocabulary and dev docs. These files are small + static, so they're indexed
    # in process (lexical, no embeddings/DB) — see api/agent/knowledge.py.
    # Paths are comma-separated, relative to the project root (or absolute).
    knowledge_enabled: bool = True
    knowledge_doc_paths: str = "docs/GLOSSARY.md,README.md,docs/AGENT_SERVING.md"
    knowledge_top_k: int = 4
    knowledge_excerpt_chars: int = 700

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()