# PathoDB Agent — Model Serving

The conversational agent (`/api/assistant/*`) talks to a **vLLM** OpenAI-compatible
server. vLLM runs **out-of-process** (like Ollama for the summarizer); the API only
holds a client pointing at its base URL. Defaults target a single **RTX-4090**.

## 1. Install (conda env `langchain`)
```bash
conda activate langchain
pip install -r api/requirements.txt        # langchain, langgraph, sentence-transformers, pgvector, ...
pip install vllm                            # GPU-specific; not pinned in requirements.txt
```

## 2. Enable pgvector + apply schema
```bash
psql "$DATABASE_URL" -f db/schema.sql        # idempotent: creates the vector ext + new tables
```

## 3. Serve the agent LLM with vLLM
Qwen2.5-14B-Instruct-AWQ is ~10 GB in 4-bit and fits one 24 GB 4090 with room for
KV cache. The node's GPU is free because the Ollama summarizer is CPU-bound.
```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-14B-Instruct-AWQ --quantization awq \
  --served-model-name Qwen/Qwen2.5-14B-Instruct-AWQ \
  --max-model-len 8192 --gpu-memory-utilization 0.90 \
  --port 8001
# verify:
curl -s http://localhost:8001/v1/models | jq .
```
Point the API at it (env / .env): `VLLM_BASE_URL=http://localhost:8001/v1`,
`VLLM_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ`.

Two-node option (2× 4090): run vLLM on the second GPU via `slurm_vllm.sh` and set
`VLLM_BASE_URL=http://<vllm-node>:8001/v1`.

## 4. Build the RAG index
```bash
python api/workers/embed_reports.py --report-type all   # idempotent; rerun as reports grow
```
Embeddings (`BAAI/bge-base-en-v1.5`, 768-dim) run on CPU by default; set
`EMBEDDING_DEVICE=cuda` to use a free GPU slot. If you change `EMBEDDING_MODEL`,
update `EMBEDDING_DIM` and the `vector(N)` column in `db/schema.sql`, then re-embed.

## 5. Health
```bash
curl -s http://localhost:8000/api/assistant/health -H "Authorization: Bearer <jwt>"
# → vllm.status, embeddings_available, rag_enabled
```

## Notes
- The API degrades gracefully: if vLLM is down → chat returns an SSE `error`; if
  pgvector/embeddings are unavailable → `semantic_report_search` reports so and the
  other tools still work.
- v1 uses an in-process LangGraph `MemorySaver` for the confirmation round-trip
  (single uvicorn worker). For multi-worker/durable deployments switch
  `api/agent/checkpoint.py` to `PostgresSaver` (langgraph-checkpoint-postgres).
- **Phase 2 (multimodal):** serve `google/medgemma-4b-it` on the 2nd 4090 with vLLM
  and add a `slide_image_qa` tool — no changes to the chat endpoint or SSE schema.
