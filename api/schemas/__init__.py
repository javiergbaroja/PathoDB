"""
PathoDB API — Pydantic Schemas
Request/response models for all endpoints.
"""
from datetime import date, datetime
from decimal import Decimal
from typing import Optional, List, Union, Literal
from pydantic import BaseModel, EmailStr, field_validator


# ─── Auth ─────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"

class RefreshRequest(BaseModel):
    refresh_token: str

class UserCreate(BaseModel):
    username: str
    email: str
    password: str
    role: str = "researcher"

class UserResponse(BaseModel):
    id: int
    username: str
    email: str
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── Patients ─────────────────────────────────────────────────────────────────

class PatientResponse(BaseModel):
    id: int
    patient_code: str
    date_of_birth: Optional[date]
    sex: Optional[str]
    created_at: datetime

    model_config = {"from_attributes": True}

class PatientWithSubmissions(PatientResponse):
    submissions: List["SubmissionSummary"] = []


# ─── Submissions ──────────────────────────────────────────────────────────────

class SubmissionSummary(BaseModel):
    id: int
    lis_submission_id: str
    report_date: Optional[date]
    malignancy_flag: Optional[bool]
    consent: Optional[str]

    model_config = {"from_attributes": True}

class SubmissionResponse(SubmissionSummary):
    patient_id: int
    probes: List["ProbeSummary"] = []
    reports: List["ReportSummary"] = []


# ─── Reports ──────────────────────────────────────────────────────────────────

class ReportSummary(BaseModel):
    id: int
    report_type: str
    report_date: Optional[date]
    report_text: Optional[str] = None
    model_config = {"from_attributes": True}

class ReportResponse(ReportSummary):
    report_text: Optional[str]
    submission_id: int


# ─── Probes ───────────────────────────────────────────────────────────────────

class ProbeSummary(BaseModel):
    id: int
    lis_probe_id: str
    submission_type: Optional[str]
    snomed_topo_code: Optional[str]
    topo_description: Optional[str]
    location_additional: Optional[str]

    model_config = {"from_attributes": True}

class ProbeResponse(ProbeSummary):
    submission_id: int
    blocks: List["BlockSummary"] = []


# ─── Blocks ───────────────────────────────────────────────────────────────────

class BlockSummary(BaseModel):
    id: int
    block_label: str
    block_sequence: Optional[int]
    block_info: Optional[str]
    tissue_count: Optional[int]

    model_config = {"from_attributes": True}

class BlockResponse(BlockSummary):
    probe_id: int
    scans: List["ScanSummary"] = []


# ─── Stains ───────────────────────────────────────────────────────────────────

class StainResponse(BaseModel):
    id: int
    stain_name: str
    stain_category: str
    aliases: List[str]
    needs_review: bool

    model_config = {"from_attributes": True}

class StainCreate(BaseModel):
    stain_name: str
    stain_category: str
    aliases: List[str] = []

class StainResolveRequest(BaseModel):
    name: str


# ─── Scans ────────────────────────────────────────────────────────────────────

class ScanSummary(BaseModel):
    id: int
    stain_id: int
    stain_name: Optional[str] = None
    stain_category: Optional[str] = None
    file_path: str
    file_format: Optional[str]
    magnification: Optional[Decimal]
    created_at: datetime

    model_config = {"from_attributes": True}

class ScanResponse(ScanSummary):
    block_id: int
    block_label: Optional[str] = None
    probe_id: Optional[int] = None
    lis_probe_id: Optional[str] = None
    submission_id: Optional[int] = None
    lis_submission_id: Optional[str] = None
    patient_id: Optional[int] = None
    patient_code: Optional[str] = None

class ScanRegisterRequest(BaseModel):
    """Payload sent by scanner-side scripts to register a new scan."""
    block_lis_ref: str
    lis_submission_id: str
    lis_probe_id: str
    block_label: str
    stain_name: str
    file_path: str
    file_format: Optional[str] = None
    magnification: Optional[Decimal] = None


# ─── Hierarchy ────────────────────────────────────────────────────────────────

class HierarchyBlock(BlockSummary):
    scans: List[ScanSummary] = []

class HierarchyProbe(ProbeSummary):
    blocks: List[HierarchyBlock] = []

class HierarchySubmission(SubmissionSummary):
    reports: List[ReportSummary] = []
    probes: List[HierarchyProbe] = []

class HierarchyResponse(PatientResponse):
    submissions: List[HierarchySubmission] = []


# ─── Cohorts ──────────────────────────────────────────────────────────────────

class CohortFilter(BaseModel):
    snomed_topo_codes: Optional[List[str]] = None
    topo_description_search: Optional[Union[str, List[str]]] = None
    submission_types: Optional[List[str]] = None
    malignancy_flag: Optional[bool] = None
    submission_date_from: Optional[date] = None
    submission_date_to: Optional[date] = None
    block_info_search: Optional[str] = None
    has_scan: Optional[bool] = None
    stain_names: Optional[List[str]] = None
    stain_categories: Optional[List[str]] = None
    file_formats: Optional[List[str]] = None
    magnification_min: Optional[float] = None
    magnification_max: Optional[float] = None
    return_level: str = "block"

    is_list_query: bool = False
    ids: Optional[List[str]] = None
    id_type: Optional[str] = None
    b_scope: Optional[str] = 'all'

class CohortSave(BaseModel):
    name: str
    description: Optional[str] = None
    filter_json: CohortFilter

class CohortResponse(BaseModel):
    id: int
    name: str
    description: Optional[str]
    filter_json: dict
    result_count: Optional[int]
    last_run_at: Optional[datetime]
    created_at: datetime

    model_config = {"from_attributes": True}


# ─── Pagination ───────────────────────────────────────────────────────────────

class PaginatedResponse(BaseModel):
    total: int
    page: int
    page_size: int
    results: list


# ─── Analysis ─────────────────────────────────────────────────────────────────

class AnalysisRunRequest(BaseModel):
    model_id: str
    scope: str = "whole_slide"
    params: dict = {}
    roi_json: Optional[dict] = None   # {x0, y0, x1, y1} slide-level pixel coords

class AnalysisJobResponse(BaseModel):
    id: int
    scan_id: int
    model_id: str
    slurm_job_id: Optional[int]
    status: str
    scope: str
    params_json: dict
    roi_json: Optional[dict]
    result_path: Optional[str]
    progress: int
    error_message: Optional[str]
    submitted_by: Optional[int]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# Update forward references
PatientWithSubmissions.model_rebuild()
SubmissionResponse.model_rebuild()
ProbeResponse.model_rebuild()
BlockResponse.model_rebuild()