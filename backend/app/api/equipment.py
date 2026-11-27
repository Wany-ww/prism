import copy
import os
from datetime import datetime
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..capture import store
from ..capture.fetchers import CaptureError, candidate_locations, discover, open_fetcher, resolve_locations
from ..db import get_db
from ..engine.frames import frame_payload
from ..models import CapturedFile, CaptureRun, Equipment, Flow
from ..scheduler import scheduler
from .common import get_or_404, row_dict

router = APIRouter(prefix="/api/equipment", tags=["capture"])
MASK = "********"


class EquipmentIn(BaseModel):
    name: str
    factory: str = ""
    customer: str = ""
    product: str = ""
    project: str = ""
    process: str = ""
    ip: str = ""
    access_method: str = "fs"
    port: int | None = None
    username: str = ""
    password: str = ""
    log_path: str = ""
    folder_mode: str = "flat"
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
    d["running"] = scheduler.is_capturing(eq.id)
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
    for f in ("factory", "customer", "product", "project", "process"):
        col = getattr(Equipment, f)
        out[f] = [v for v in db.scalars(select(col).distinct().order_by(col)) if v]
    return out


@router.get("/{eq_id}")
def get_equipment(eq_id: int, db: Session = Depends(get_db)):
    return eq_out(get_or_404(db, Equipment, eq_id))


@router.post("")
def create_equipment(body: EquipmentIn, db: Session = Depends(get_db)):
    if db.scalar(select(Equipment).where(Equipment.name == body.name)):
        raise HTTPException(409, "Equipment with the same name already exists.")
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
        raise HTTPException(409, "Equipment with the same name already exists.")
    _apply(eq, body)
    db.commit()
    db.refresh(eq)
    return eq_out(eq)


@router.delete("/{eq_id}")
def delete_equipment(eq_id: int, db: Session = Depends(get_db)):
    return _delete(db, [eq_id])


class DeleteIn(BaseModel):
    ids: list[int]


@router.post("/delete")
def delete_many(body: DeleteIn, db: Session = Depends(get_db)):
    return _delete(db, body.ids)


def _flows_using(db, ids: set[int]) -> list[Flow]:
    out = []
    for f in db.scalars(select(Flow)):
        for n in (f.graph or {}).get("nodes", []):
            d = n.get("data") or {}
            if d.get("kind") == "source" and ids & {int(i) for i in (d.get("params") or {}).get("equipment_ids") or []}:
                out.append(f)
                break
    return out


@router.get("/{eq_id}/usage")
def usage(eq_id: int, db: Session = Depends(get_db)):
    """삭제 전 확인용: 수집 데이터 양과 이 설비를 쓰는 Flow."""
    get_or_404(db, Equipment, eq_id)
    files, rows = db.execute(
        select(func.count(), func.coalesce(func.sum(CapturedFile.rows), 0)).where(CapturedFile.equipment_id == eq_id)
    ).one()
    return {
        "files": files,
        "records": int(rows),
        "flows": [{"id": f.id, "name": f.name, "kind": f.kind} for f in _flows_using(db, {eq_id})],
    }


def _delete(db, ids: list[int]) -> dict:
    """설비 삭제: 수집 파일·레코드·수집 이력은 함께 삭제되고, Flow 의 설비 데이터 노드에서는 선택이 해제된다."""
    eqs = db.scalars(select(Equipment).where(Equipment.id.in_(ids))).all()
    if not eqs:
        raise HTTPException(404, "Equipment not found")
    if any(scheduler.is_capturing(e.id) for e in eqs):
        raise HTTPException(409, "Some equipment is capturing right now. Try again shortly.")
    gone = {e.id for e in eqs}
    db.execute(delete(CapturedFile).where(CapturedFile.equipment_id.in_(gone)))
    db.execute(delete(CaptureRun).where(CaptureRun.equipment_id.in_(gone)))
    flows = _flows_using(db, gone)
    for f in flows:
        graph = copy.deepcopy(f.graph)
        for n in graph.get("nodes", []):
            p = (n.get("data") or {}).get("params") or {}
            if n.get("data", {}).get("kind") == "source":
                p["equipment_ids"] = [i for i in p.get("equipment_ids") or [] if int(i) not in gone]
        f.graph = graph
    for e in eqs:
        db.delete(e)
    db.commit()
    for i in gone:
        store.delete_equipment(i)
    return {"ok": True, "deleted": sorted(gone), "flows_updated": [f.name for f in flows]}


@router.post("/{eq_id}/capture")
def capture_now(eq_id: int, wait: bool = True, db: Session = Depends(get_db)):
    get_or_404(db, Equipment, eq_id)
    if not wait:
        scheduler.submit_capture(eq_id, "manual")
        return {"status": "queued"}
    return scheduler.run_capture_wait(eq_id, "manual")


@router.post("/{eq_id}/reset")
def reset_equipment(eq_id: int, db: Session = Depends(get_db)):
    """수집 이력/레코드 삭제 → 다음 수집 시 전체 재파싱."""
    eq = get_or_404(db, Equipment, eq_id)
    if scheduler.is_capturing(eq_id):
        raise HTTPException(409, "This equipment is capturing right now. Try again shortly.")
    db.execute(delete(CapturedFile).where(CapturedFile.equipment_id == eq_id))
    eq.next_capture_at = None
    db.commit()
    store.delete_equipment(eq_id)
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
        if cfg.access_method == "agent":
            locations = [{"dir": d, "pattern": p} for d, p in candidate_locations(cfg)]
            msg = "Agent method: paths are on the gateway PC."
            if cfg.folder_mode == "date":
                msg += " The agent finds dated folders on the gateway PC."
            return {"ok": True, "locations": locations[-1:] if cfg.folder_mode == "date" else locations, "files": [], "message": msg}
        with open_fetcher(cfg) as f:
            locations = [{"dir": d, "pattern": p} for d, p in resolve_locations(f, cfg)]
            files = discover(f, cfg)
        if cfg.folder_mode == "date" and not locations:
            return {
                "ok": False,
                "error": f"No dated folders for the last {cfg.lookback_days + 1} day(s) under [{cfg.log_path}]. Check the root folder path and lookback days.",
                "locations": [],
            }
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
    df, total = store.latest_records(db, eq_id, max(0, offset), max(1, min(limit, 5000)))
    # 컬럼이 많으면 행 수를 줄여 응답을 수 MB 이하로
    return frame_payload(df, max(20, 300_000 // max(1, df.shape[1])), row_count=total)


@router.get("/{eq_id}/fields")
def fields(eq_id: int, db: Session = Depends(get_db)):
    return store.fields(db, eq_id)


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
