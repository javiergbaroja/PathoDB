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
    block_lis_ref: str          # Any unique block reference the script knows
    lis_submission_id: str      # Submission ID to locate the block
    lis_probe_id: str           # Probe ID within that submission
    block_label: str            # Block label within that probe
    stain_name: str             # Resolved against stains table on server side
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
    """All fields optional — combined with AND, multiple values within a field use OR."""
    snomed_topo_codes: Optional[List[str]] = None
    topo_description_search: Optional[str] = None    # free-text substring
    submission_types: Optional[List[str]] = None
    stain_names: Optional[List[str]] = None
    stain_categories: Optional[List[str]] = None
    file_formats: Optional[List[str]] = None
    magnification_min: Optional[Decimal] = None
    magnification_max: Optional[Decimal] = None
    submission_date_from: Optional[date] = None
    submission_date_to: Optional[date] = None
    malignancy_flag: Optional[bool] = None
    has_scan: Optional[bool] = None
    block_info_search: Optional[str] = None          # free-text substring
    return_level: Literal["patient", "submission", "probe", "block", "scan"] = "block"

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


# Update forward references
PatientWithSubmissions.model_rebuild()
SubmissionResponse.model_rebuild()
ProbeResponse.model_rebuild()
BlockResponse.model_rebuild()
