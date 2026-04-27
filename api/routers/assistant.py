from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List, Optional, Any

from ..database import get_db
from ..auth import get_current_user
# You'll need: pip install langchain langchain-experimental langchain-huggingface
from langchain_community.agent_toolkits import create_sql_agent
from langchain_community.utilities import SQLDatabase
from langchain_huggingface import HuggingFaceEndpoint # Or your local MedGemma loader

router = APIRouter(tags=["assistant"])

class AssistantQuery(BaseModel):
    query: str

class AssistantResponse(BaseModel):
    answer: str
    data: Optional[dict] = None

# Initialize the SQLDatabase wrapper for LangChain
# This assumes your database URL is in your settings
from ..config import get_settings
settings = get_settings()
db_engine = SQLDatabase.from_uri(settings.database_url)

@router.post("/query", response_model=AssistantResponse)
async def query_assistant(
    request: AssistantQuery,
    db: Session = Depends(get_db),
    current_user: Any = Depends(get_current_user)
):
    try:
        # 1. Initialize MedGemma (Conceptual)
        # In a real Phase 4, you'd point this to your local model instance
        llm = HuggingFaceEndpoint(
            repo_id="google/medgemma-7b", 
            task="text-generation",
            huggingfacehub_api_token=settings.hf_token
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