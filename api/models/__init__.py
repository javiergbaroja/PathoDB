"""
PathoDB API — ORM Models
SQLAlchemy models mirroring the database schema.
"""
from datetime import date, datetime
from sqlalchemy import (
      Boolean, Column, Date, ForeignKey, Integer, Numeric,
      String, Text, TIMESTAMP, UniqueConstraint, ARRAY,
      func, Index
  )
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from ..database import Base


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
