import io
from datetime import datetime, timedelta

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..engine.frames import delete_dataset_file, frame_payload, load_dataset
from ..models import CapturedFile, CaptureRun, Dashboard, Dataset, Equipment, Flow, NodeType, Parser, Record
from .common import get_or_404, row_dict

router = APIRouter(prefix="/api", tags=["data"])


def _load(db, name: str) -> pd.DataFrame:
    try:
        return load_dataset(db, name)
    except KeyError as e:
        raise HTTPException(404, str(e)) from e


# ---------- Datasets ----------


@router.get("/datasets")
def list_datasets(db: Session = Depends(get_db)):
    flows = dict(db.execute(select(Flow.id, Flow.name)).all())
    out = []
    for d in db.scalars(select(Dataset).order_by(Dataset.name)):
        r = row_dict(d)
        r["flow_name"] = flows.get(d.flow_id)
        out.append(r)
    return out


@router.get("/datasets/{name}/data")
def dataset_data(name: str, limit: int = 1000, offset: int = 0, columns: str = "", db: Session = Depends(get_db)):
    df = _load(db, name)
    if columns:
        cols = [c for c in columns.split(",") if c in df.columns]
        df = df[cols]
    return frame_payload(df, min(limit, 200000) if limit > 0 else None, offset)


@router.get("/datasets/{name}/csv")
def dataset_csv(name: str, db: Session = Depends(get_db)):
    df = _load(db, name)
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    data = io.BytesIO(buf.getvalue().encode("utf-8-sig"))
    from urllib.parse import quote

    return StreamingResponse(
        data,
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}.csv"},
    )


@router.delete("/datasets/{ds_id}")
def delete_dataset(ds_id: int, db: Session = Depends(get_db)):
    ds = get_or_404(db, Dataset, ds_id)
    delete_dataset_file(ds.id)
    db.delete(ds)
    db.commit()
    return {"ok": True}


# ---------- Trace ----------


@router.get("/trace/search")
def trace_search(dataset: str, q: str, column: str = "", mode: str = "exact", limit: int = 50, db: Session = Depends(get_db)):
    """매칭 결과 데이터셋에서 제품 키(QR, VAID 등)로 공정 이력을 검색."""
    df = _load(db, dataset)
    q = q.strip()
    cols = [column] if column and column in df.columns else [c for c in df.columns if not pd.api.types.is_datetime64_any_dtype(df[c])]
    mask = pd.Series(False, index=df.index)
    for c in cols:
        s = df[c].astype(str).str.strip()
        mask |= s.str.contains(q, case=False, regex=False) if mode == "contains" else (s == q) | (s.str.removesuffix(".0") == q)
    return frame_payload(df[mask], limit)


# ---------- Dashboards ----------


class DashboardIn(BaseModel):
    name: str
    description: str = ""
    layout: dict = Field(default_factory=lambda: {"widgets": []})
    refresh_sec: int = 0


@router.get("/dashboards")
def list_dashboards(db: Session = Depends(get_db)):
    out = []
    for d in db.scalars(select(Dashboard).order_by(Dashboard.name)):
        r = row_dict(d, exclude=("layout",))
        r["widget_count"] = len((d.layout or {}).get("widgets", []))
        out.append(r)
    return out


@router.get("/dashboards/{did}")
def get_dashboard(did: int, db: Session = Depends(get_db)):
    return row_dict(get_or_404(db, Dashboard, did))


@router.post("/dashboards")
def create_dashboard(body: DashboardIn, db: Session = Depends(get_db)):
    d = Dashboard(**body.model_dump())
    db.add(d)
    db.commit()
    return row_dict(d)


@router.put("/dashboards/{did}")
def update_dashboard(did: int, body: DashboardIn, db: Session = Depends(get_db)):
    d = get_or_404(db, Dashboard, did)
    for k, v in body.model_dump().items():
        setattr(d, k, v)
    db.commit()
    return row_dict(d)


@router.delete("/dashboards/{did}")
def delete_dashboard(did: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, Dashboard, did))
    db.commit()
    return {"ok": True}


# ---------- Overview ----------


@router.get("/overview/activity")
def activity(hours: int = 24, db: Session = Depends(get_db)):
    """설비별 시간당 레코드 수 (홈 타일 스파크라인용)."""
    hours = max(1, min(hours, 24 * 14))
    start = (datetime.now() - timedelta(hours=hours - 1)).replace(minute=0, second=0, microsecond=0)
    if db.bind.dialect.name == "postgresql":
        bucket = func.to_char(func.date_trunc("hour", Record.ts), "YYYY-MM-DD HH24")
    else:
        bucket = func.strftime("%Y-%m-%d %H", Record.ts)
    rows = db.execute(
        select(Record.equipment_id, bucket.label("b"), func.count())
        .where(Record.ts >= start)
        .group_by(Record.equipment_id, bucket)
    ).all()
    keys = [(start + timedelta(hours=i)).strftime("%Y-%m-%d %H") for i in range(hours)]
    idx = {k: i for i, k in enumerate(keys)}
    out: dict[int, list[int]] = {}
    for eq_id, b, n in rows:
        if b in idx:
            out.setdefault(eq_id, [0] * hours)[idx[b]] = n
    return {"hours": keys, "series": out}


@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    eq_status = dict(db.execute(select(Equipment.status, func.count()).group_by(Equipment.status)).all())
    recent = db.execute(
        select(CaptureRun, Equipment.name)
        .join(Equipment, Equipment.id == CaptureRun.equipment_id)
        .order_by(CaptureRun.id.desc())
        .limit(15)
    ).all()
    return {
        "equipment": db.scalar(select(func.count()).select_from(Equipment)),
        "equipment_enabled": db.scalar(select(func.count()).select_from(Equipment).where(Equipment.enabled.is_(True))),
        "equipment_status": eq_status,
        "records": int(db.scalar(select(func.sum(CapturedFile.rows))) or 0),
        "parsers": db.scalar(select(func.count()).select_from(Parser)),
        "node_types": db.scalar(select(func.count()).select_from(NodeType)),
        "flows": dict(db.execute(select(Flow.kind, func.count()).group_by(Flow.kind)).all()),
        "datasets": db.scalar(select(func.count()).select_from(Dataset)),
        "dashboards": db.scalar(select(func.count()).select_from(Dashboard)),
        "recent_runs": [{**row_dict(r), "equipment": name} for r, name in recent],
    }
