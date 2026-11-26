from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base

JSONType = JSON().with_variant(JSONB(), "postgresql")
BigId = BigInteger().with_variant(Integer(), "sqlite")


def now():
    return datetime.now()


class Parser(Base):
    __tablename__ = "parsers"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    code: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Equipment(Base):
    __tablename__ = "equipment"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    factory: Mapped[str] = mapped_column(String(100), default="")
    customer: Mapped[str] = mapped_column(String(100), default="")
    product: Mapped[str] = mapped_column(String(100), default="")
    project: Mapped[str] = mapped_column(String(100), default="")
    process: Mapped[str] = mapped_column(String(100), default="")
    ip: Mapped[str] = mapped_column(String(100), default="")
    # fs: 로컬/UNC/마운트 경로, ftp, sftp, agent: 게이트웨이 PC 에이전트가 push
    access_method: Mapped[str] = mapped_column(String(20), default="fs")
    port: Mapped[int | None] = mapped_column(Integer, nullable=True)
    username: Mapped[str] = mapped_column(String(100), default="")
    password: Mapped[str] = mapped_column(String(200), default="")
    log_path: Mapped[str] = mapped_column(String(500), default="")
    # flat: log_path 에 파일이 바로 있음 / date: log_path 아래 날짜 폴더(20261124, 2026-11-24, 2026\11\24 …)를 자동 탐색
    folder_mode: Mapped[str] = mapped_column(String(20), default="flat")
    file_pattern: Mapped[str] = mapped_column(String(200), default="*.csv")
    lookback_days: Mapped[int] = mapped_column(Integer, default=1)
    encoding: Mapped[str] = mapped_column(String(30), default="utf-8")
    capture_interval_sec: Mapped[int] = mapped_column(Integer, default=300)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    parser_id: Mapped[int | None] = mapped_column(ForeignKey("parsers.id", ondelete="SET NULL"), nullable=True)
    options: Mapped[dict] = mapped_column(JSONType, default=dict)
    description: Mapped[str] = mapped_column(Text, default="")

    status: Mapped[str] = mapped_column(String(20), default="idle")
    last_capture_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    next_capture_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)

    parser: Mapped[Parser | None] = relationship(lazy="joined")


class CapturedFile(Base):
    __tablename__ = "captured_files"
    __table_args__ = (UniqueConstraint("equipment_id", "path"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(String(1000))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    mtime: Mapped[float] = mapped_column(Float, default=0)
    rows: Mapped[int] = mapped_column(Integer, default=0)
    # 파서 코드가 바뀌면 같은 파일도 다시 파싱하기 위해 보관
    parser_hash: Mapped[str] = mapped_column(String(40), default="")
    status: Mapped[str] = mapped_column(String(20), default="ok")
    error: Mapped[str] = mapped_column(Text, default="")
    captured_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Record(Base):
    __tablename__ = "records"
    __table_args__ = (Index("ix_records_eq_ts", "equipment_id", "ts"),)
    id: Mapped[int] = mapped_column(BigId, primary_key=True, autoincrement=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"))
    file_id: Mapped[int] = mapped_column(ForeignKey("captured_files.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    data: Mapped[dict] = mapped_column(JSONType)


class CaptureRun(Base):
    __tablename__ = "capture_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    equipment_id: Mapped[int] = mapped_column(ForeignKey("equipment.id", ondelete="CASCADE"), index=True)
    trigger: Mapped[str] = mapped_column(String(20), default="schedule")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="running")
    files_found: Mapped[int] = mapped_column(Integer, default=0)
    files_parsed: Mapped[int] = mapped_column(Integer, default=0)
    rows: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(Text, default="")


class NodeType(Base):
    """사용자 정의 Python 노드 (Match/Analysis 공용 라이브러리)."""

    __tablename__ = "node_types"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(100), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    category: Mapped[str] = mapped_column(String(50), default="Transform")
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(20), default="#a234c7")
    inputs: Mapped[int] = mapped_column(Integer, default=1)
    params: Mapped[list] = mapped_column(JSONType, default=list)
    code: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Flow(Base):
    __tablename__ = "flows"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20), default="analysis")  # match | analysis
    description: Mapped[str] = mapped_column(Text, default="")
    graph: Mapped[dict] = mapped_column(JSONType, default=dict)
    schedule_minutes: Mapped[int] = mapped_column(Integer, default=0)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str] = mapped_column(String(20), default="")
    last_error: Mapped[str] = mapped_column(Text, default="")
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Dataset(Base):
    """Flow Output 노드가 저장한 결과 테이블 (parquet 파일로 보관)."""

    __tablename__ = "datasets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    flow_id: Mapped[int | None] = mapped_column(ForeignKey("flows.id", ondelete="SET NULL"), nullable=True)
    node_id: Mapped[str] = mapped_column(String(100), default="")
    columns: Mapped[list] = mapped_column(JSONType, default=list)
    row_count: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Dashboard(Base):
    __tablename__ = "dashboards"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    slug: Mapped[str] = mapped_column(String(64), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    layout: Mapped[dict] = mapped_column(JSONType, default=dict)
    refresh_sec: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)
