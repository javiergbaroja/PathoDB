"""
PathoDB API — Configuration
Reads from environment variables / .env file.
"""
from pydantic_settings import BaseSettings
from functools import lru_cache


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
    vllm_max_tokens: int = 1024
    vllm_request_timeout: float = 120.0
    agent_max_iterations: int = 8          # tool-call loop ceiling (guardrail)
    agent_max_input_chars: int = 4000      # per-message user input cap
    agent_max_tool_rows: int = 25          # rows from a query surfaced to the model
    agent_checkpointer_dsn: str = ""       # falls back to database_url when empty

    # ── Report RAG (pgvector) ──────────────────────────────────────────────────
    rag_enabled: bool = True
    embedding_model: str = "BAAI/bge-base-en-v1.5"   # 768-dim → matches schema
    embedding_dim: int = 768
    embedding_device: str = "cpu"          # "cuda" if a GPU slot is free
    embedding_batch_size: int = 32
    rag_top_k: int = 6
    rag_max_chunk_chars: int = 1200
    rag_chunk_overlap_chars: int = 150

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()