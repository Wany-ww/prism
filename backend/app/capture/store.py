"""수집 원본 레코드 저장소: records/<equipment_id>/<captured_file_id>.parquet

예전에는 레코드 1행 = SQL 1행(JSON)이었는데, 컬럼이 수천 개면 저장·조회가 모두 느리고 메모리를 많이 써서
수집 파일 단위 parquet 로 바꿨다. 조회는 시각 범위가 겹치는 파일만, 필요한 컬럼만 읽는다.
parquet 읽기/쓰기와 시각 범위 거르기는 Rust 엔진(prism_core)이 한다.
"""

import json
import logging
import os
import shutil
import uuid
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import inspect, or_, select, text

from ..config import RECORDS_DIR
from ..engine import native
from ..engine.frames import to_table, write_parquet
from ..engine.native import core
from ..models import CapturedFile, Equipment

log = logging.getLogger("prism.records")


def file_path(eq_id: int, file_id: int) -> Path:
    return RECORDS_DIR / str(eq_id) / f"{file_id}.parquet"


def _dedupe_columns(cols) -> list[str]:
    seen: dict[str, int] = {}
    out = []
    for c in map(str, cols):
        if c in seen:
            seen[c] += 1
            out.append(f"{c}_{seen[c]}")
        else:
            seen[c] = 0
            out.append(c)
    return out


def record_ts(df: pd.DataFrame, default_ts: datetime | None) -> pd.Series:
    """레코드 시각: `_ts` 컬럼이 있으면 그 값, 없거나 비어 있으면 default_ts."""
    if "_ts" in df.columns:
        ts = pd.to_datetime(df["_ts"], errors="coerce")
        if getattr(ts.dt, "tz", None) is not None:
            ts = ts.dt.tz_convert(None)
    else:
        ts = pd.Series(pd.NaT, index=df.index, dtype="datetime64[us]")
    if default_ts is not None:
        ts = ts.fillna(pd.Timestamp(default_ts))
    return ts.astype("datetime64[us]")


def write_records(eq_id: int, file_id: int, df: pd.DataFrame, default_ts: datetime | None) -> dict:
    """파서 결과를 저장."""
    df = df.copy()
    df.columns = _dedupe_columns(df.columns)
    ts = record_ts(df, default_ts)
    df = df.drop(columns=["_ts"], errors="ignore")
    df.insert(0, "_ts", ts)
    path = file_path(eq_id, file_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex[:8]}.tmp")
    write_parquet(to_table(df), tmp)
    os.replace(tmp, path)
    valid = ts.dropna()
    return {
        "rows": int(len(df)),
        "ts_min": valid.min().to_pydatetime() if len(valid) else None,
        "ts_max": valid.max().to_pydatetime() if len(valid) else None,
        "hours": {k: int(v) for k, v in valid.dt.strftime("%Y-%m-%d %H").value_counts().items()},
    }


def delete_file(eq_id: int, file_id: int):
    try:
        os.remove(file_path(eq_id, file_id))
    except FileNotFoundError:
        pass


def delete_equipment(eq_id: int):
    shutil.rmtree(RECORDS_DIR / str(eq_id), ignore_errors=True)


def _concat(tables: list) -> pd.DataFrame:
    # 같은 이름 컬럼이 파일마다 타입이 다르면 담을 수 있는 타입(정수+실수 → 실수, 그 밖 → 문자열)으로 맞춰 합침
    if not tables:
        return pd.DataFrame()
    return native.to_pandas(core.concat(tables))


def _read(path: Path, columns: list[str] | None, since=None, until=None):
    # 시각 범위에 걸리는 행이 없으면 다른 컬럼은 읽지 않는다 (메타데이터 해석도 파일당 한 번)
    if not path.exists():
        return None
    cols = None if columns is None else list(dict.fromkeys(["_ts", *columns]))
    return core.read_parquet(
        str(path),
        cols,
        None if since is None else native.to_us(since),
        None if until is None else native.to_us(until),
    )


def load_records(db, equipment_ids: list[int], since: datetime | None = None, until: datetime | None = None, columns: list[str] | None = None) -> pd.DataFrame:
    """설비들의 레코드를 시각순으로. columns 를 주면 그 컬럼(+ _ts, _equipment)만 읽는다."""
    q = select(CapturedFile.id, CapturedFile.equipment_id).where(CapturedFile.equipment_id.in_(equipment_ids), CapturedFile.rows > 0)
    if since:
        q = q.where(or_(CapturedFile.ts_max.is_(None), CapturedFile.ts_max >= since))
    if until:
        q = q.where(or_(CapturedFile.ts_min.is_(None), CapturedFile.ts_min <= until))
    files = db.execute(q.order_by(CapturedFile.id)).all()
    names = dict(db.execute(select(Equipment.id, Equipment.name).where(Equipment.id.in_(equipment_ids))).all())
    tables = []
    for fid, eq_id in files:
        t = _read(file_path(eq_id, fid), columns, since, until)
        if t is not None and t.num_rows:
            tables.append(t.append_str("_equipment", names.get(eq_id, "")))
    df = _concat(tables)
    if df.empty:
        return pd.DataFrame({"_ts": pd.Series(dtype="datetime64[us]"), "_equipment": pd.Series(dtype=object)})
    df = df.sort_values("_ts", kind="stable", na_position="first").reset_index(drop=True)
    return df[[c for c in df.columns if c not in ("_ts", "_equipment")] + ["_ts", "_equipment"]]


def latest_records(db, eq_id: int, offset: int, limit: int) -> tuple[pd.DataFrame, int]:
    """최근 레코드부터 offset..offset+limit (필요한 파일만 읽음)."""
    files = db.execute(
        select(CapturedFile.id, CapturedFile.ts_max, CapturedFile.rows)
        .where(CapturedFile.equipment_id == eq_id, CapturedFile.rows > 0)
        .order_by(CapturedFile.ts_max.desc().nulls_last(), CapturedFile.id.desc())
    ).all()
    total = int(sum(f.rows for f in files))
    need = offset + limit
    tables, got, oldest = [], 0, None
    for f in files:
        # 충분히 모였고, 남은 파일은 모두 지금까지 모은 것보다 오래됐으면 그만 읽음
        if got >= need and oldest is not None and (f.ts_max is None or pd.Timestamp(f.ts_max) < oldest):
            break
        t = _read(file_path(eq_id, f.id), None)
        if t is None or not t.num_rows:
            continue
        t = t.append_i64("__f", np.full(t.num_rows, f.id, dtype=np.int64)).append_i64("__r", np.arange(t.num_rows, dtype=np.int64))
        tables.append(t)
        got += t.num_rows
        lo = native.to_pandas(t.select(["_ts"]))["_ts"].min() if "_ts" in t.column_names else pd.NaT
        if pd.notna(lo):
            oldest = lo if oldest is None else min(oldest, lo)
    df = _concat(tables)
    if df.empty:
        return pd.DataFrame({"_ts": pd.Series(dtype="datetime64[us]")}), total
    df = df.sort_values(["_ts", "__f", "__r"], ascending=False, na_position="last").iloc[offset:need]
    return df.drop(columns=["__f", "__r"]).reset_index(drop=True), total


def fields(db, eq_id: int) -> list[str]:
    ids = db.scalars(
        select(CapturedFile.id).where(CapturedFile.equipment_id == eq_id, CapturedFile.rows > 0).order_by(CapturedFile.id.desc()).limit(20)
    ).all()
    keys: dict[str, None] = {}
    for fid in ids:
        p = file_path(eq_id, fid)
        if p.exists():
            for n, _ in core.read_schema(str(p)):
                if n != "_ts":
                    keys.setdefault(n, None)
    return list(keys) + ["_ts", "_equipment"]


def migrate_sql_records(engine, session_factory):
    """예전 records 테이블(JSON 행)을 parquet 로 옮기고 테이블 이름을 records_legacy 로 바꾼다 (한 번만 실행).
    문제가 없으면 records_legacy 는 직접 지워도 된다 (DROP TABLE records_legacy)."""
    if not inspect(engine).has_table("records"):
        return
    with engine.connect() as conn:
        pairs = conn.execute(text("SELECT DISTINCT file_id, equipment_id FROM records")).all()
    log.info("migrating %d captured files from SQL records to parquet", len(pairs))
    with session_factory() as db:
        for file_id, eq_id in pairs:
            with engine.connect() as conn:
                rows = conn.execute(text("SELECT ts, data FROM records WHERE file_id = :f ORDER BY id"), {"f": file_id}).all()
            df = pd.DataFrame([json.loads(d) if isinstance(d, str) else (d or {}) for _, d in rows])
            df["_ts"] = pd.to_datetime(pd.Series([r[0] for r in rows], dtype="object"), errors="coerce")
            meta = write_records(eq_id, file_id, df, None)
            cf = db.get(CapturedFile, file_id)
            if cf is not None:
                cf.rows, cf.ts_min, cf.ts_max, cf.hours = meta["rows"], meta["ts_min"], meta["ts_max"], meta["hours"]
        db.commit()
    with engine.begin() as conn:
        if inspect(conn).has_table("records_legacy"):
            conn.execute(text("DROP TABLE records_legacy"))
        # 인덱스 이름은 DB 전체에서 겹치면 안 되므로 지워 둔다 (보관용 테이블이라 필요 없음)
        for ix in ("ix_records_eq_ts", "ix_records_file_id"):
            conn.execute(text(f"DROP INDEX IF EXISTS {ix}"))
        conn.execute(text("ALTER TABLE records RENAME TO records_legacy"))
    log.info("records migration done (old table kept as records_legacy; drop it once everything looks right)")
