"""PathoDB conversational agent package.

All heavy dependencies (langchain, langgraph, sentence-transformers, vLLM) are
imported lazily inside functions so importing this package never breaks API
startup. The chat router degrades to HTTP 503 when a dependency is missing.
"""
