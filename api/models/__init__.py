"""
PathoDB API — ORM Models
SQLAlchemy models mirroring the database schema.
"""
from datetime import date, datetime
from sqlalchemy import (
      Boolean, Column, Date, ForeignKey, Integer, Numeric, Float,
      String, Text, TIMESTAMP, UniqueConstraint, ARRAY,
      func, Index
  )
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from ..database import Base


# ── Canonical vocabulary ─────────────────────────────────────────────────────
# Single source of truth for the enumerated string values used across routers.
# See docs/GLOSSARY.md for the user-facing terminology these map to.
PROJECT_TYPE_CELL_DETECTION    = "cell_detection"
PROJECT_TYPE_REGION_ANNOTATION = "region_annotation"
PROJECT_TYPE_TMA               = "tma"
PROJECT_TYPES = (
    PROJECT_TYPE_CELL_DETECTION,
    PROJECT_TYPE_REGION_ANNOTATION,
    PROJECT_TYPE_TMA,
)

SOURCE_TYPE_COHORT      = "cohort"
SOURCE_TYPE_FILE_IMPORT = "file_import"
SOURCE_TYPE_CUSTOM_LIST = "custom_list"
SOURCE_TYPES = (SOURCE_TYPE_COHORT, SOURCE_TYPE_FILE_IMPORT, SOURCE_TYPE_CUSTOM_LIST)


class User(Base):
    __tablename__ = "users"

    id            = Column(Integer, primary_key=True)
    username      = Column(Text, nullable=False, unique=True)
    email         = Column(Text, nullable=False, unique=True)
    password_hash = Column(Text, nullable=False)
    role          = Column(Text, nullable=False, default="researcher")
    is_active     = Column(Boolean, nullable=False, default=True)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())

    scans   = relationship("Scan", back_populates="registered_by_user")
    cohorts = relationship("Cohort", back_populates="user")


class Patient(Base):
    __tablename__ = "patients"

    id            = Column(Integer, primary_key=True)
    patient_code  = Column(Text, nullable=False, unique=True)
    date_of_birth = Column(Date)
    sex           = Column(Text)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    summary_text = Column(Text, nullable=True)
    summary_updated_at = Column(TIMESTAMP(timezone=True), nullable=True)

    submissions = relationship("Submission", back_populates="patient")


class Submission(Base):
    __tablename__ = "submissions"

    id                = Column(Integer, primary_key=True)
    patient_id        = Column(Integer, ForeignKey("patients.id"), nullable=False)
    lis_submission_id = Column(Text, nullable=False, unique=True)
    report_date       = Column(Date)
    malignancy_flag   = Column(Boolean)
    consent           = Column(Text)
    created_at        = Column(TIMESTAMP(timezone=True), server_default=func.now())

    patient = relationship("Patient", back_populates="submissions")
    probes  = relationship("Probe", back_populates="submission")
    reports = relationship("Report", back_populates="submission")


class Report(Base):
    __tablename__ = "reports"

    id            = Column(Integer, primary_key=True)
    submission_id = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    report_type   = Column(Text, nullable=False)   # 'macro' or 'microscopy'
    report_text   = Column(Text)
    report_date   = Column(Date)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("submission_id", "report_type"),
    )

    submission = relationship("Submission", back_populates="reports")


class Probe(Base):
    __tablename__ = "probes"

    id                  = Column(Integer, primary_key=True)
    submission_id       = Column(Integer, ForeignKey("submissions.id"), nullable=False)
    lis_probe_id        = Column(Text, nullable=False)
    submission_type     = Column(Text)
    snomed_topo_code    = Column(Text)
    topo_description    = Column(Text)
    location_additional = Column(Text)
    created_at          = Column(TIMESTAMP(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("submission_id", "lis_probe_id"),
    )

    submission = relationship("Submission", back_populates="probes")
    blocks     = relationship("Block", back_populates="probe")


class Block(Base):
    __tablename__ = "blocks"

    id             = Column(Integer, primary_key=True)
    probe_id       = Column(Integer, ForeignKey("probes.id"), nullable=False)
    block_label    = Column(Text, nullable=False)
    block_sequence = Column(Integer)
    block_info     = Column(Text)
    tissue_count   = Column(Integer)
    created_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("probe_id", "block_label"),
    )

    probe = relationship("Probe", back_populates="blocks")
    scans = relationship("Scan", back_populates="block")


class Stain(Base):
    __tablename__ = "stains"

    id             = Column(Integer, primary_key=True)
    stain_name     = Column(Text, nullable=False, unique=True)
    stain_category = Column(Text, nullable=False, default="other")
    aliases        = Column(ARRAY(Text), nullable=False, default=list)
    needs_review   = Column(Boolean, nullable=False, default=False)
    created_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())

    scans = relationship("Scan", back_populates="stain")


class Scan(Base):
    __tablename__ = "scans"

    id              = Column(Integer, primary_key=True)
    block_id        = Column(Integer, ForeignKey("blocks.id"), nullable=False)
    stain_id        = Column(Integer, ForeignKey("stains.id"), nullable=False)
    file_path       = Column(Text, nullable=False, unique=True)
    file_format     = Column(Text)
    magnification   = Column(Numeric(4, 1))
    registered_by   = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())

    block              = relationship("Block", back_populates="scans")
    stain              = relationship("Stain", back_populates="scans")
    registered_by_user = relationship("User", back_populates="scans")


class Cohort(Base):
    __tablename__ = "cohorts"

    id           = Column(Integer, primary_key=True)
    user_id      = Column(Integer, ForeignKey("users.id"), nullable=False)
    name         = Column(Text, nullable=False)
    description  = Column(Text)
    filter_json  = Column(JSONB, nullable=False)
    result_count = Column(Integer)
    last_run_at  = Column(TIMESTAMP(timezone=True))
    created_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="cohorts")


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"

    id            = Column(Integer, primary_key=True)
    scan_id       = Column(Integer, ForeignKey("scans.id"), nullable=False)
    model_id      = Column(Text, nullable=False)
    slurm_job_id  = Column(Integer, nullable=True)
    status        = Column(Text, nullable=False, default="queued")
    scope         = Column(Text, nullable=False, default="whole_slide")
    params_json   = Column(JSONB, nullable=False, default=dict)
    roi_json      = Column(JSONB, nullable=True)
    result_path   = Column(Text, nullable=True)
    progress      = Column(Integer, nullable=False, default=0)
    error_message = Column(Text, nullable=True)
    submitted_by  = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at    = Column(TIMESTAMP(timezone=True), server_default=func.now())

    scan              = relationship("Scan")
    submitted_by_user = relationship("User", foreign_keys=[submitted_by])

class Project(Base):
    __tablename__ = "projects"

    id           = Column(Integer, primary_key=True)
    owner_id     = Column(Integer, ForeignKey("users.id"), nullable=False)
    name         = Column(Text, nullable=False)
    description  = Column(Text)
    project_type = Column(Text, nullable=False)   # 'cell_detection' | 'region_annotation'
    classes      = Column(JSONB, nullable=False, default=list)  # [{id,name,color}]
    source_type  = Column(Text, nullable=False)   # 'cohort' | 'file_import'
    cohort_id    = Column(Integer, ForeignKey("cohorts.id"), nullable=True)
    created_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())

    owner  = relationship("User", foreign_keys=[owner_id])
    cohort = relationship("Cohort", foreign_keys=[cohort_id])
    scans  = relationship("ProjectScan", back_populates="project", cascade="all, delete-orphan",
                          order_by="ProjectScan.sort_order")
    shares = relationship("ProjectShare", back_populates="project", cascade="all, delete-orphan")


class ProjectScan(Base):
    __tablename__ = "project_scans"

    id         = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    scan_id    = Column(Integer, ForeignKey("scans.id"), nullable=False)
    sort_order = Column(Integer, nullable=False, default=0)
    added_at   = Column(TIMESTAMP(timezone=True), server_default=func.now())

    project = relationship("Project", back_populates="scans")
    scan    = relationship("Scan")


class ProjectShare(Base):
    __tablename__ = "project_shares"

    id                  = Column(Integer, primary_key=True)
    project_id          = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    shared_with_user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    access_level        = Column(Text, nullable=False, default="read")  # 'read' | 'edit'
    shared_by           = Column(Integer, ForeignKey("users.id"), nullable=True)
    shared_at           = Column(TIMESTAMP(timezone=True), server_default=func.now())

    project          = relationship("Project", back_populates="shares")
    shared_with_user = relationship("User", foreign_keys=[shared_with_user_id])


class Annotation(Base):
    __tablename__ = "annotations"

    id              = Column(Integer, primary_key=True)
    project_id      = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    scan_id         = Column(Integer, ForeignKey("scans.id"), nullable=False)
    created_by      = Column(Integer, ForeignKey("users.id"), nullable=True)
    class_id        = Column(Text)
    class_name      = Column(Text)
    annotation_type = Column(Text, nullable=False)
    bbox_x          = Column(Numeric, nullable=False, default=0)
    bbox_y          = Column(Numeric, nullable=False, default=0)
    bbox_w          = Column(Numeric, nullable=False, default=0)
    bbox_h          = Column(Numeric, nullable=False, default=0)
    geometry        = Column(JSONB, nullable=False, default=dict)
    area_px         = Column(Numeric)
    notes           = Column(Text)
    created_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at      = Column(TIMESTAMP(timezone=True), server_default=func.now())

    project    = relationship("Project")
    scan       = relationship("Scan")
    creator    = relationship("User", foreign_keys=[created_by])


# Add this to api/models/__init__.py

class TMACore(Base):
    __tablename__ = "tma_cores"

    id                  = Column(Integer, primary_key=True)
    project_id          = Column(Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    row_idx             = Column(Integer, nullable=False)
    col_idx             = Column(Integer, nullable=False)
    donor_block_id      = Column(Integer, ForeignKey("blocks.id"), nullable=True)
    core_type           = Column(Text, nullable=False, default="tissue")
    control_description = Column(Text, nullable=True)
    bbox_x              = Column(Numeric, nullable=True)
    bbox_y              = Column(Numeric, nullable=True)
    bbox_w              = Column(Numeric, nullable=True)
    bbox_h              = Column(Numeric, nullable=True)
    created_at          = Column(TIMESTAMP(timezone=True), server_default=func.now())

    project     = relationship("Project", backref="tma_cores")
    donor_block = relationship("Block")


class SlideRegistration(Base):
    """A similarity transform aligning a moving slide onto a fixed slide.

    Stored once per unordered scan pair; the transform maps moving-slide
    full-resolution pixels -> fixed-slide full-resolution pixels.
    """
    __tablename__ = "slide_registrations"

    id             = Column(Integer, primary_key=True)
    fixed_scan_id  = Column(Integer, ForeignKey("scans.id", ondelete="CASCADE"), nullable=False)
    moving_scan_id = Column(Integer, ForeignKey("scans.id", ondelete="CASCADE"), nullable=False)
    scale          = Column(Float, nullable=False)
    rotation       = Column(Float, nullable=False)   # radians, moving -> fixed
    tx             = Column(Float, nullable=False)
    ty             = Column(Float, nullable=False)
    method         = Column(Text, nullable=False, default="manual")  # 'manual' | 'auto'
    created_by     = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at     = Column(TIMESTAMP(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("fixed_scan_id", "moving_scan_id"),
    )


# ── Conversational agent persistence ─────────────────────────────────────────
# (The pgvector-dependent ReportEmbedding model lives in api/agent/models.py so
#  the core models module keeps no hard dependency on pgvector.)

class ChatSession(Base):
    __tablename__ = "chat_session"

    id         = Column(Integer, primary_key=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    title      = Column(Text, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())
    updated_at = Column(TIMESTAMP(timezone=True), server_default=func.now())

    user     = relationship("User")
    messages = relationship("ChatMessage", back_populates="session",
                            cascade="all, delete-orphan", order_by="ChatMessage.id")


class ChatMessage(Base):
    __tablename__ = "chat_message"

    id         = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("chat_session.id", ondelete="CASCADE"), nullable=False)
    role       = Column(Text, nullable=False)   # 'user' | 'assistant' | 'tool' | 'system'
    content    = Column(Text, nullable=True)
    tool_calls = Column(JSONB, nullable=True)
    citations  = Column(JSONB, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())

    session = relationship("ChatSession", back_populates="messages")


class AgentAudit(Base):
    __tablename__ = "agent_audit"

    id         = Column(Integer, primary_key=True)
    user_id    = Column(Integer, ForeignKey("users.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("chat_session.id"), nullable=True)
    event_type = Column(Text, nullable=False)   # query | tool_call | safe_action_requested|approved|rejected
    tool_name  = Column(Text, nullable=True)
    payload    = Column(JSONB, nullable=True)
    created_at = Column(TIMESTAMP(timezone=True), server_default=func.now())