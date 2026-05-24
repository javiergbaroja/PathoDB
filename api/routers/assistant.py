from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List, Optional, Any

from ..database import get_db
from ..auth import get_current_user
from ..config import get_settings

router = APIRouter(tags=["assistant"])
settings = get_settings()

class AssistantQuery(BaseModel):
    query: str

class AssistantResponse(BaseModel):
    answer: str
    data: Optional[dict] = None

@router.post("/query", response_model=AssistantResponse)
async def query_assistant(
    request: AssistantQuery,
    db: Session = Depends(get_db),
    current_user: Any = Depends(get_current_user)
):
    # Heavy LangChain deps are imported lazily so this experimental endpoint
    # can never prevent the rest of the API from starting if they are absent.
    # Requires: pip install langchain langchain-community langchain-huggingface
    try:
        from langchain_community.agent_toolkits import create_sql_agent
        from langchain_community.utilities import SQLDatabase
        from langchain_huggingface import HuggingFaceEndpoint  # Or your local MedGemma loader
    except ImportError as e:
        raise HTTPException(
            status_code=503,
            detail=f"Assistant dependencies not installed: {e}",
        )

    hf_token = getattr(settings, "hf_token", None)
    if not hf_token:
        raise HTTPException(
            status_code=503,
            detail="Assistant is not configured (missing hf_token).",
        )

    try:
        db_engine = SQLDatabase.from_uri(settings.database_url)

        # 1. Initialize MedGemma (Conceptual)
        # In a real Phase 4, you'd point this to your local model instance
        llm = HuggingFaceEndpoint(
            repo_id="google/medgemma-7b",
            task="text-generation",
            huggingfacehub_api_token=hf_token
        )

        # 2. Create the SQL Agent
        # It automatically looks at your table schemas (patients, scans, etc.)
        agent_executor = create_sql_agent(llm, db=db_engine, agent_type="tool-calling", verbose=True)

        # 3. Execute the RAG Pipeline
        # We wrap the user query with context to ensure it stays clinical
        prompt = f"You are the PathoDB clinical assistant. User query: {request.query}"
        result = agent_executor.invoke({"input": prompt})

        # 4. Optional: Post-process result to find Slide IDs
        # If the query result contains scans, we can extract them to make them clickable
        # (For now, we return the text; in a full impl, you'd parse IDs here)
        
        return {
            "answer": result["output"],
            "data": None # We can populate this with slide objects later
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Assistant Error: {str(e)}")