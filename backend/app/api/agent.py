"""별도 LAN 설비용 Agent(push) API.

게이트웨이 PC(대표 설비 PC, 작업 PC 등)에서 prism-agent.exe(Rust, 설치 불필요)를 실행하면
서버에서 설정을 받아 로그 파일을 찾아 변경된 파일만 업로드한다. 실행 파일은 화면(설비 설정)에서 내려받는다.
"""

import os
import shutil
import tempfile
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..capture.fetchers import DATE_FOLDER_DEPTH, candidate_locations, day_keys, render
from ..capture.service import parser_hash
from ..config import AGENT_EXE, AGENT_TOKEN, STAGING_DIR
from ..db import get_db
from ..models import CapturedFile, Equipment
from ..scheduler import scheduler

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.get("/download")
def agent_download():
    """게이트웨이 PC 용 수집 에이전트 실행 파일 (Windows x64, 설치 불필요)."""
    if not AGENT_EXE.exists():
        raise HTTPException(404, "agent/prism-agent.exe is not built on this server (scripts\\build-native.ps1).")
    return FileResponse(AGENT_EXE, media_type="application/octet-stream", filename="prism-agent.exe")


def _auth(token: str | None):
    if AGENT_TOKEN and token != AGENT_TOKEN:
        raise HTTPException(401, "invalid agent token")


def _equipment(db, name: str) -> Equipment:
    eq = db.scalar(select(Equipment).where(Equipment.name == name))
    if eq is None:
        raise HTTPException(404, f"Equipment [{name}] not found")
    return eq


@router.get("/config")
def agent_config(equipment: str, x_agent_token: str | None = Header(None), db: Session = Depends(get_db)):
    _auth(x_agent_token)
    eq = _equipment(db, equipment)
    known = {
        cf.path: [cf.size, cf.mtime, cf.parser_hash]
        for cf in db.scalars(select(CapturedFile).where(CapturedFile.equipment_id == eq.id))
    }
    out = {
        "id": eq.id,
        "name": eq.name,
        "enabled": eq.enabled,
        "interval_sec": eq.capture_interval_sec,
        "parser_hash": parser_hash(eq),
        "locations": [{"dir": d, "pattern": p} for d, p in candidate_locations(eq)],
        "known": known,
    }
    if eq.folder_mode == "date":
        # 에이전트가 게이트웨이 PC 에서 날짜 폴더를 찾도록: 폴더 숫자열 → 그 날짜의 파일 패턴
        now = datetime.now()
        out["locations"] = []
        out["date_folders"] = {
            "base": render(eq.log_path or "", eq, now),
            "depth": DATE_FOLDER_DEPTH,
            "keys": {k: render(eq.file_pattern or "*", eq, d) for k, d in day_keys(eq, now).items()},
        }
    return out


@router.post("/upload")
def agent_upload(
    equipment: str = Form(...),
    path: str = Form(...),
    size: int = Form(...),
    mtime: float = Form(...),
    file: UploadFile = File(...),
    x_agent_token: str | None = Header(None),
    db: Session = Depends(get_db),
):
    _auth(x_agent_token)
    eq = _equipment(db, equipment)
    tmp_dir = tempfile.mkdtemp(dir=STAGING_DIR)
    try:
        local = os.path.join(tmp_dir, os.path.basename(path.replace("\\", "/")) or "upload")
        with open(local, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return scheduler.ingest(eq.id, local, path, size, mtime)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
