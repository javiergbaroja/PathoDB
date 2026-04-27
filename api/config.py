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

    # Scanner service account
    scanner_api_key: str = ""

    # Analysis — DL model inference on HPC
    # analysis_results_dir: absolute path on NFS where model output is written
    # models_dir: absolute path to the directory containing catalog.json and model scripts
    analysis_results_dir: str = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/analysis_results"
    models_dir: str = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models"

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache
def get_settings() -> Settings:
    return Settings()