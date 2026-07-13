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
Qwen2.5-14B-Instruct-AWQ is ~10 GB in 4-bit and fits one 24 GB 4090 with room for KV cache. 
```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-14B-Instruct-AWQ --quantization awq \
  --served-model-name Qwen/Qwen2.5-14B-Instruct-AWQ \
  --max-model-len 16384 --gpu-memory-utilization 0.90 \
  --port 8001
# verify:
curl -s http://localhost:8001/v1/models | jq .
```
`--max-model-len` defaults to 16384 in `slurm_vllm.sh` (override with
`VLLM_MAX_MODEL_LEN`). 16k is comfortable on a 24 GB 4090 (~3 GB KV cache); 32768
is feasible on the H100 or a lightly-loaded 4090. Keep
`agent_max_context_tokens` (config) below this minus `vllm_max_tokens` so the
graph's history-trim guard never lets a call overflow.
Point the API at it (env / .env): `VLLM_BASE_URL=http://localhost:8001/v1`,
`VLLM_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ`.

Two-node option (2× 4090): run vLLM on the second GPU via `slurm_vllm.sh` and set
`VLLM_BASE_URL=http://<vllm-node>:8001/v1`.

## 4. Build the RAG index
```bash
python api/workers/embed_reports.py --report-type all   # idempotent; rerun as reports grow
```
Embeddings (`BAAI/bge-m3`, 1024-dim) run on CPU by default; set
`EMBEDDING_DEVICE=cuda` to use a free GPU slot. If you change `EMBEDDING_MODEL`, update `EMBEDDING_DIM` and the `vector(N)` column in `db/schema.sql`, then re-embed.

### Hybrid retrieval + reranking
`semantic_report_search` runs **hybrid** retrieval (`rag_hybrid`, default on): a dense pgvector arm (paraphrase/meaning) and a Postgres full-text arm (exact rare tokens, mutations, codes) are fused with Reciprocal Rank Fusion. The lexical arm needs the GIN FTS index `idx_report_embeddings_fts`  (`to_tsvector('english', chunk_text)`), built by `slurm_embed.sh` and `db/schema.sql`; its config **must** match `rag_fts_config`. If that index is missing the arm degrades silently to dense-only.

An optional cross-encoder **reranker** reorders the fused pool for  precision@k. It is **off by default** (`rag_reranker_model=""`); set it to a cross-encoder (recommended `BAAI/bge-reranker-v2-m3`) and pick
`rag_reranker_device` (a free GPU slot is ideal — it runs one forward pass per candidate). Missing/unloadable reranker → falls back to the fused order.

### Knowledge grounding (glossary + docs + SNOMED)
A **second, distinct** retrieval namespace grounds the agent in its own governed
vocabulary — separate from patient-report RAG so the model chooses deliberately:
- `search_documentation` — lexical search over `GLOSSARY.md` +  configured docs
  (`knowledge_doc_paths`), indexed **in process** by markdown section (no embeddings/DB — always available, even when vLLM/pgvector are down; edits are picked up on file mtime change).
- `lookup_snomed` — resolves codes ↔ terms over the `snomed_codes` table (morphology / etiology / topography), for interpreting governed SNOMED codes.

## 5. Health
```bash
curl -s http://localhost:8000/api/assistant/health -H "Authorization: Bearer <jwt>"
# → vllm.status, embeddings_available, rag_enabled
```

## Notes
- The API degrades gracefully: if vLLM is down → chat returns an SSE `error`; if pgvector/embeddings are unavailable → `semantic_report_search` reports so and the other tools still work.
- v1 uses an in-process LangGraph `MemorySaver` for the confirmation round-trip (single uvicorn worker). For multi-worker/durable deployments switch  `api/agent/checkpoint.py` to `PostgresSaver` (langgraph-checkpoint-postgres).
- **Phase 2 (multimodal):** serve `google/medgemma-4b-it` on the 2nd 4090 with vLLM and add a `slide_image_qa` tool — no changes to the chat endpoint or SSE schema.
