import json
import re
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..engine.frames import dataset_columns, delete_dataset_file, frame_payload, iter_csv, load_dataset, norm_keys, read_range, search_dataset
from ..models import CapturedFile, CaptureRun, Dashboard, Dataset, Equipment, Flow, NodeType, Parser
from .common import get_or_404, json_download, row_dict

router = APIRouter(prefix="/api", tags=["data"])


def _columns(db, name: str) -> list[str]:
    try:
        return dataset_columns(db, name)
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
def dataset_data(
    name: str,
    limit: int = 1000,
    offset: int = 0,
    columns: str = "",
    filter_col: str = "",
    filter_values: str = "",
    db: Session = Depends(get_db),
):
    """columns 를 주면 그 컬럼만 읽음. filter_col/filter_values(JSON 배열) 를 주면 해당 컬럼 값이 목록에 있는 행만 반환."""
    all_cols = _columns(db, name)
    cols = [c for c in columns.split(",") if c in all_cols] if columns else None
    limit = min(limit, 200000) if limit > 0 else None
    if not filter_col:
        df, total = read_range(db, name, max(0, offset), limit, cols)
        return frame_payload(df, None, row_count=total)
    if filter_col not in all_cols:
        raise HTTPException(400, f"Column '{filter_col}' does not exist.")
    try:
        values = json.loads(filter_values or "[]")
    except ValueError as e:
        raise HTTPException(400, "filter_values must be a JSON array.") from e
    wanted = set(norm_keys(pd.Series([str(v) for v in values], dtype=object)))
    df = load_dataset(db, name, None if cols is None else list(dict.fromkeys([*cols, filter_col])))
    df = df[norm_keys(df[filter_col]).isin(wanted)]
    if cols is not None:
        df = df[cols]
    return frame_payload(df, limit, offset)


@router.get("/datasets/{name}/csv")
def dataset_csv(name: str, db: Session = Depends(get_db)):
    from urllib.parse import quote

    _columns(db, name)
    return StreamingResponse(
        iter_csv(db, name),
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


KEY_COL_RE = re.compile(r"(vaid|qr|serial|s/?n$|tray no|lot|barcode|id$)", re.I)


def key_columns(meta: list[dict]) -> list[str]:
    """제품 키로 보이는 컬럼 (QR, VAID, Serial, Lot, …_id). 시각 컬럼은 제외."""
    return [c["name"] for c in meta if c["dtype"] != "datetime" and KEY_COL_RE.search(c["name"])]


@router.get("/trace/search")
def trace_search(dataset: str, q: str, column: str = "", mode: str = "exact", limit: int = 50, db: Session = Depends(get_db)):
    """매칭 결과 데이터셋에서 제품 키(QR, VAID 등)로 공정 이력을 검색.
    컬럼을 지정하지 않으면 키처럼 보이는 컬럼만 찾는다 (수천 개 컬럼을 모두 문자열로 바꿔 비교하면 검색 1번에 몇 분씩 걸림)."""
    ds = db.scalar(select(Dataset).where(Dataset.name == dataset))
    if ds is None:
        raise HTTPException(404, f"Dataset [{dataset}] does not exist. Run its flow first.")
    meta = ds.columns or []
    names = [c["name"] for c in meta]
    q = q.strip()
    if column:
        cols = [c for c in column.split(",") if c in names]
    else:
        cols = key_columns(meta) or [c["name"] for c in meta if c["dtype"] == "string"][:50]
    if not cols:
        raise HTTPException(400, "No column to search. Pick a key column.")

    def match(sub: pd.DataFrame):
        mask = np.zeros(len(sub), dtype=bool)
        for c in sub.columns:
            s = sub[c].astype(str).str.strip()
            hit = s.str.contains(q, case=False, regex=False) if mode == "contains" else (s == q) | (s.str.removesuffix(".0") == q)
            mask |= hit.fillna(False).to_numpy(dtype=bool)
        return mask

    df, total = search_dataset(db, dataset, cols, match, max(1, min(limit, 1000)))
    out = frame_payload(df, None, row_count=total)
    out["searched_columns"] = cols
    return out


# ---------- Dashboards ----------

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    return base or "dashboard"


def _unique_slug(db: Session, base: str, exclude_id: int | None = None) -> str:
    """base 가 이미 쓰이고 있으면 -2, -3 ... 을 붙여 비어있는 식별자를 찾음."""
    slug, n = base, 2
    while True:
        q = select(Dashboard.id).where(Dashboard.slug == slug)
        if exclude_id is not None:
            q = q.where(Dashboard.id != exclude_id)
        if db.scalar(q) is None:
            return slug
        slug = f"{base}-{n}"
        n += 1


def _resolve_slug(db: Session, requested: str, name: str, *, current: str = "", exclude_id: int | None = None) -> str:
    """요청받은 식별자를 검증하거나(형식/중복), 비어 있으면 이름에서 자동 생성. current 는 수정 시 기존 값 유지용."""
    requested = requested.strip().lower()
    if requested:
        if not _SLUG_RE.match(requested):
            raise HTTPException(400, "식별자는 소문자, 숫자, 하이픈(-)만 사용할 수 있습니다.")
        q = select(Dashboard.id).where(Dashboard.slug == requested)
        if exclude_id is not None:
            q = q.where(Dashboard.id != exclude_id)
        if db.scalar(q) is not None:
            raise HTTPException(400, f"식별자 [{requested}] 는 이미 사용 중입니다.")
        return requested
    if current:
        return current
    return _unique_slug(db, _slugify(name), exclude_id=exclude_id)


class DashboardIn(BaseModel):
    name: str
    slug: str = ""
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


@router.get("/dashboards/lookup/{key}")
def lookup_dashboard(key: str, db: Session = Depends(get_db)):
    """숫자면 id로, 아니면 slug(식별자)로 대시보드를 찾음 — 풀스크린 주소(/view/<id 또는 식별자>)가 쓰는 엔드포인트."""
    d = db.get(Dashboard, int(key)) if key.isdigit() else None
    if d is None:
        d = db.scalar(select(Dashboard).where(Dashboard.slug == key))
    if d is None:
        raise HTTPException(404, f"Dashboard [{key}] not found")
    return row_dict(d)


@router.get("/dashboards/{did}")
def get_dashboard(did: int, db: Session = Depends(get_db)):
    return row_dict(get_or_404(db, Dashboard, did))


@router.post("/dashboards")
def create_dashboard(body: DashboardIn, db: Session = Depends(get_db)):
    data = body.model_dump()
    slug = _resolve_slug(db, data.pop("slug"), data["name"])
    d = Dashboard(**data, slug=slug)
    db.add(d)
    db.commit()
    return row_dict(d)


@router.put("/dashboards/{did}")
def update_dashboard(did: int, body: DashboardIn, db: Session = Depends(get_db)):
    d = get_or_404(db, Dashboard, did)
    data = body.model_dump()
    data["slug"] = _resolve_slug(db, data.pop("slug"), data["name"], current=d.slug, exclude_id=did)
    for k, v in data.items():
        setattr(d, k, v)
    db.commit()
    return row_dict(d)


@router.delete("/dashboards/{did}")
def delete_dashboard(did: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, Dashboard, did))
    db.commit()
    return {"ok": True}


@router.get("/dashboards/{did}/export")
def export_dashboard(did: int, db: Session = Depends(get_db)):
    """다른 PRISM 서버로 옮길 수 있게 대시보드 정의를 .json 파일로 내려받음 (위젯은 데이터셋 이름으로 참조하므로,
    옮긴 환경에 같은 이름의 데이터셋이 있어야 그대로 동작함)."""
    d = get_or_404(db, Dashboard, did)
    payload = {
        "_type": "prism-dashboard",
        "version": 1,
        "name": d.name,
        "description": d.description,
        "refresh_sec": d.refresh_sec,
        "layout": d.layout,
    }
    return json_download(payload, d.name)


@router.post("/dashboards/import")
def import_dashboard(body: dict, db: Session = Depends(get_db)):
    if body.get("_type") != "prism-dashboard":
        raise HTTPException(400, "This file is not a PRISM dashboard export.")
    name = str(body.get("name") or "Imported dashboard").strip() or "Imported dashboard"
    layout = body.get("layout") if isinstance(body.get("layout"), dict) else {"widgets": []}
    refresh_sec = body.get("refresh_sec") if isinstance(body.get("refresh_sec"), int) else 0
    slug = _unique_slug(db, _slugify(name))
    d = Dashboard(name=f"{name} (imported)", slug=slug, description=str(body.get("description") or ""), layout=layout, refresh_sec=refresh_sec)
    db.add(d)
    db.commit()
    return row_dict(d)


# ---------- Overview ----------


@router.get("/overview/activity")
def activity(hours: int = 24, db: Session = Depends(get_db)):
    """설비별 시간당 레코드 수 (홈 타일 스파크라인용)."""
    hours = max(1, min(hours, 24 * 14))
    start = (datetime.now() - timedelta(hours=hours - 1)).replace(minute=0, second=0, microsecond=0)
    # 수집 파일마다 저장해 둔 시간대별 건수를 합산 (레코드 본문은 읽지 않음)
    rows = db.execute(
        select(CapturedFile.equipment_id, CapturedFile.hours).where(CapturedFile.ts_max >= start, CapturedFile.rows > 0)
    ).all()
    keys = [(start + timedelta(hours=i)).strftime("%Y-%m-%d %H") for i in range(hours)]
    idx = {k: i for i, k in enumerate(keys)}
    out: dict[int, list[int]] = {}
    for eq_id, hist in rows:
        for b, n in (hist or {}).items():
            if b in idx:
                out.setdefault(eq_id, [0] * hours)[idx[b]] += int(n)
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
