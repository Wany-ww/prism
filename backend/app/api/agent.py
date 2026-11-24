"""별도 LAN 설비용 Agent(push) API.

게이트웨이 PC(대표 설비 PC, 작업 PC 등)에서 agent/prism_agent.py 를 실행하면
서버에서 설정을 받아 로그 파일을 찾아 변경된 파일만 업로드한다.
"""

import os
import shutil
import tempfile

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..capture.fetchers import candidate_locations
from ..capture.service import ingest_uploaded, parser_hash
from ..config import AGENT_TOKEN, STAGING_DIR
from ..db import get_db
from ..models import CapturedFile, Equipment

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _auth(token: str | None):
    if AGENT_TOKEN and token != AGENT_TOKEN:
        raise HTTPException(401, "invalid agent token")


def _equipment(db, name: str) -> Equipment:
    eq = db.scalar(select(Equipment).where(Equipment.name == name))
    if eq is None:
        raise HTTPException(404, f"설비 '{name}' 없음")
    return eq


@router.get("/config")
def agent_config(equipment: str, x_agent_token: str | None = Header(None), db: Session = Depends(get_db)):
    _auth(x_agent_token)
    eq = _equipment(db, equipment)
    known = {
        cf.path: [cf.size, cf.mtime, cf.parser_hash]
        for cf in db.scalars(select(CapturedFile).where(CapturedFile.equipment_id == eq.id))
    }
    return {
        "id": eq.id,
        "name": eq.name,
        "enabled": eq.enabled,
        "interval_sec": eq.capture_interval_sec,
        "parser_hash": parser_hash(eq),
        "locations": [{"dir": d, "pattern": p} for d, p in candidate_locations(eq)],
        "known": known,
    }


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
        return ingest_uploaded(eq.id, local, path, size, mtime)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
