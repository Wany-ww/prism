import os
from datetime import datetime
from types import SimpleNamespace

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..capture.fetchers import CaptureError, candidate_locations, discover, open_fetcher
from ..capture.service import is_running, run_capture
from ..db import get_db
from ..engine.frames import frame_payload
from ..models import CapturedFile, CaptureRun, Equipment, Record
from ..scheduler import scheduler
from .common import get_or_404, row_dict

router = APIRouter(prefix="/api/equipment", tags=["capture"])
MASK = "********"


class EquipmentIn(BaseModel):
    name: str
    factory: str = ""
    product: str = ""
    project: str = ""
    process: str = ""
    ip: str = ""
    access_method: str = "fs"
    port: int | None = None
    username: str = ""
    password: str = ""
    log_path: str = ""
    file_pattern: str = "*.csv"
    lookback_days: int = 1
    encoding: str = "utf-8"
    capture_interval_sec: int = 300
    enabled: bool = True
    parser_id: int | None = None
    options: dict = Field(default_factory=dict)
    description: str = ""


def eq_out(eq: Equipment, stats: dict | None = None) -> dict:
    d = row_dict(eq)
    d["password"] = MASK if eq.password else ""
    d["parser_name"] = eq.parser.name if eq.parser else None
    d["running"] = is_running(eq.id)
    if stats is not None:
        d["file_count"], d["record_count"] = stats.get(eq.id, (0, 0))
    return d


def _apply(eq: Equipment, body: EquipmentIn):
    data = body.model_dump()
    if data["password"] == MASK:
        data.pop("password")
    for k, v in data.items():
        setattr(eq, k, v)
    eq.next_capture_at = None


@router.get("")
def list_equipment(db: Session = Depends(get_db)):
    stats = {
        r[0]: (r[1], int(r[2] or 0))
        for r in db.execute(
            select(CapturedFile.equipment_id, func.count(), func.sum(CapturedFile.rows)).group_by(CapturedFile.equipment_id)
        )
    }
    eqs = db.scalars(select(Equipment).order_by(Equipment.factory, Equipment.process, Equipment.name)).all()
    return [eq_out(e, stats) for e in eqs]


@router.get("/suggestions")
def suggestions(db: Session = Depends(get_db)):
    out = {}
    for f in ("factory", "product", "project", "process"):
        col = getattr(Equipment, f)
        out[f] = [v for v in db.scalars(select(col).distinct().order_by(col)) if v]
    return out


@router.get("/{eq_id}")
def get_equipment(eq_id: int, db: Session = Depends(get_db)):
    return eq_out(get_or_404(db, Equipment, eq_id))


@router.post("")
def create_equipment(body: EquipmentIn, db: Session = Depends(get_db)):
    if db.scalar(select(Equipment).where(Equipment.name == body.name)):
        raise HTTPException(409, "같은 이름의 설비가 있습니다.")
    eq = Equipment()
    _apply(eq, body)
    db.add(eq)
    db.commit()
    db.refresh(eq)
    return eq_out(eq)


@router.put("/{eq_id}")
def update_equipment(eq_id: int, body: EquipmentIn, db: Session = Depends(get_db)):
    eq = get_or_404(db, Equipment, eq_id)
    dup = db.scalar(select(Equipment).where(Equipment.name == body.name, Equipment.id != eq_id))
    if dup:
        raise HTTPException(409, "같은 이름의 설비가 있습니다.")
    _apply(eq, body)
    db.commit()
    db.refresh(eq)
    return eq_out(eq)


@router.delete("/{eq_id}")
def delete_equipment(eq_id: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, Equipment, eq_id))
    db.commit()
    return {"ok": True}


@router.post("/{eq_id}/capture")
def capture_now(eq_id: int, wait: bool = True, db: Session = Depends(get_db)):
    get_or_404(db, Equipment, eq_id)
    if not wait:
        scheduler.submit_capture(eq_id, "manual")
        return {"status": "queued"}
    return run_capture(eq_id, "manual")


@router.post("/{eq_id}/reset")
def reset_equipment(eq_id: int, db: Session = Depends(get_db)):
    """수집 이력/레코드 삭제 → 다음 수집 시 전체 재파싱."""
    eq = get_or_404(db, Equipment, eq_id)
    db.execute(delete(Record).where(Record.equipment_id == eq_id))
    db.execute(delete(CapturedFile).where(CapturedFile.equipment_id == eq_id))
    eq.next_capture_at = None
    db.commit()
    return {"ok": True}


class ProbeIn(EquipmentIn):
    id: int | None = None


@router.post("/probe")
def probe(body: ProbeIn, db: Session = Depends(get_db)):
    """저장 전 설정으로 접근 경로/파일 목록을 확인."""
    cfg = SimpleNamespace(**body.model_dump())
    if body.id and body.password == MASK:
        cfg.password = get_or_404(db, Equipment, body.id).password
    try:
        locations = [{"dir": d, "pattern": p} for d, p in candidate_locations(cfg)]
        if cfg.access_method == "agent":
            return {"ok": True, "locations": locations, "files": [], "message": "Agent 방식: 게이트웨이 PC 기준 경로입니다."}
        with open_fetcher(cfg) as f:
            files = discover(f, cfg)
    except CaptureError as e:
        return {"ok": False, "error": str(e), "locations": []}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "locations": []}
    known = {}
    if body.id:
        known = {cf.path: cf for cf in db.scalars(select(CapturedFile).where(CapturedFile.equipment_id == body.id))}
    return {
        "ok": True,
        "locations": locations,
        "total": len(files),
        "files": [
            {
                "path": f.path,
                "size": f.size,
                "mtime": datetime.fromtimestamp(f.mtime),
                "captured": known[f.path].status if f.path in known else None,
            }
            for f in files[-300:]
        ],
    }


@router.get("/{eq_id}/files")
def files(eq_id: int, limit: int = 300, db: Session = Depends(get_db)):
    q = (
        select(CapturedFile)
        .where(CapturedFile.equipment_id == eq_id)
        .order_by(CapturedFile.captured_at.desc())
        .limit(limit)
    )
    return [row_dict(c) for c in db.scalars(q)]


@router.get("/{eq_id}/runs")
def runs(eq_id: int, limit: int = 50, db: Session = Depends(get_db)):
    q = select(CaptureRun).where(CaptureRun.equipment_id == eq_id).order_by(CaptureRun.id.desc()).limit(limit)
    return [row_dict(r) for r in db.scalars(q)]


@router.get("/{eq_id}/records")
def records(eq_id: int, limit: int = 200, offset: int = 0, db: Session = Depends(get_db)):
    total = db.scalar(select(func.count()).select_from(Record).where(Record.equipment_id == eq_id))
    q = (
        select(Record.ts, Record.data)
        .where(Record.equipment_id == eq_id)
        .order_by(Record.ts.desc(), Record.id.desc())
        .offset(offset)
        .limit(limit)
    )
    rows = db.execute(q).all()
    df = pd.DataFrame([r.data for r in rows])
    df.insert(0, "_ts", pd.to_datetime(pd.Series([r.ts for r in rows], dtype="object")))
    out = frame_payload(df, None)
    out["row_count"] = total
    return out


@router.get("/{eq_id}/fields")
def fields(eq_id: int, db: Session = Depends(get_db)):
    q = select(Record.data).where(Record.equipment_id == eq_id).order_by(Record.id.desc()).limit(200)
    keys: dict[str, None] = {}
    for d in db.scalars(q):
        for k in d or {}:
            keys.setdefault(k, None)
    return list(keys) + ["_ts", "_equipment"]


@router.get("/{eq_id}/parser-sample")
def latest_file(eq_id: int, db: Session = Depends(get_db)):
    """파서 테스트용: 이 설비에서 발견되는 최신 파일 경로."""
    eq = get_or_404(db, Equipment, eq_id)
    if eq.access_method != "fs":
        return {"path": None}
    try:
        with open_fetcher(eq) as f:
            found = discover(f, eq)
    except Exception:
        found = []
    return {"path": found[-1].path if found and os.path.exists(found[-1].path) else None}
