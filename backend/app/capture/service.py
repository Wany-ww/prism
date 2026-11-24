import hashlib
import json
import threading
from datetime import datetime

import pandas as pd
from sqlalchemy import delete, insert, select

from ..db import SessionLocal
from ..engine.usercode import UserCodeError, call_user, load_function, to_frame
from ..models import CapturedFile, CaptureRun, Equipment, Record
from .fetchers import CaptureError, discover, open_fetcher, template_vars

_locks: dict[int, threading.Lock] = {}
_locks_guard = threading.Lock()
INSERT_CHUNK = 2000


def equipment_lock(eq_id: int) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(eq_id, threading.Lock())


def is_running(eq_id: int) -> bool:
    return equipment_lock(eq_id).locked()


def parser_hash(eq: Equipment) -> str:
    return hashlib.sha1((eq.parser.code if eq.parser else "").encode("utf-8")).hexdigest()


def parser_fn(eq: Equipment):
    if eq.parser is None:
        raise CaptureError("No parser is assigned.")
    return load_function(eq.parser.code, "parse", f"parser:{eq.parser.name}")


def parser_context(eq, source_path: str, mtime: float | None) -> dict:
    return {
        "equipment": template_vars(eq),
        "encoding": eq.encoding or "utf-8",
        "options": dict(eq.options or {}),
        "source_path": source_path,
        "file_mtime": datetime.fromtimestamp(mtime) if mtime else None,
    }


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


def frame_to_rows(df: pd.DataFrame, default_ts: datetime | None) -> list[tuple[datetime | None, dict]]:
    """파서 결과 → (ts, data) 목록. `_ts` 컬럼이 있으면 레코드 시각으로 사용."""
    df = df.copy()
    df.columns = _dedupe_columns(df.columns)
    if "_ts" in df.columns:
        ts = pd.to_datetime(df.pop("_ts"), errors="coerce")
        if getattr(ts.dt, "tz", None) is not None:
            ts = ts.dt.tz_convert(None)
        ts_list = [None if pd.isna(t) else t.to_pydatetime() for t in ts]
    else:
        ts_list = [None] * len(df)
    ts_list = [t or default_ts for t in ts_list]
    data = json.loads(df.to_json(orient="records", date_format="iso", force_ascii=False)) if len(df) else []
    return list(zip(ts_list, data))


def run_parser(eq, local_path: str, source_path: str, mtime: float | None) -> pd.DataFrame:
    fn = parser_fn(eq)
    label = f"parser:{eq.parser.name}"
    return to_frame(call_user(fn, label, local_path, parser_context(eq, source_path, mtime)), label)


def ingest_file(db, eq: Equipment, local_path: str, source_path: str, size: int, mtime: float) -> int:
    df = run_parser(eq, local_path, source_path, mtime)
    rows = frame_to_rows(df, datetime.fromtimestamp(mtime) if mtime else datetime.now())

    cf = db.scalar(select(CapturedFile).where(CapturedFile.equipment_id == eq.id, CapturedFile.path == source_path))
    if cf is None:
        cf = CapturedFile(equipment_id=eq.id, path=source_path)
        db.add(cf)
        db.flush()
    else:
        db.execute(delete(Record).where(Record.file_id == cf.id))
    for i in range(0, len(rows), INSERT_CHUNK):
        chunk = rows[i : i + INSERT_CHUNK]
        db.execute(insert(Record), [{"equipment_id": eq.id, "file_id": cf.id, "ts": t, "data": d} for t, d in chunk])
    cf.size, cf.mtime, cf.rows = size, mtime, len(rows)
    cf.status, cf.error, cf.parser_hash, cf.captured_at = "ok", "", parser_hash(eq), datetime.now()
    db.commit()
    return len(rows)


def _mark_file_error(db, eq: Equipment, source_path: str, size: int, mtime: float, err: str):
    cf = db.scalar(select(CapturedFile).where(CapturedFile.equipment_id == eq.id, CapturedFile.path == source_path))
    if cf is None:
        cf = CapturedFile(equipment_id=eq.id, path=source_path, rows=0)
        db.add(cf)
    cf.size, cf.mtime, cf.status, cf.error = size, mtime, "error", err[:4000]
    cf.parser_hash, cf.captured_at = parser_hash(eq), datetime.now()
    db.commit()


def _err_text(e: Exception) -> str:
    if isinstance(e, UserCodeError) and e.detail:
        return f"{e}\n{e.detail}"
    return str(e)


def _finish(db, eq: Equipment, run: CaptureRun, status: str, message: str):
    run.status, run.message, run.finished_at = status, message[:8000], datetime.now()
    eq.status = status
    eq.last_capture_at = run.finished_at
    eq.last_error = "" if status == "ok" else message[:4000]
    if status != "error":
        eq.last_success_at = run.finished_at
    db.commit()


def run_capture(equipment_id: int, trigger: str = "schedule") -> dict:
    lock = equipment_lock(equipment_id)
    if not lock.acquire(blocking=False):
        return {"status": "busy", "message": "Already capturing."}
    try:
        with SessionLocal() as db:
            eq = db.get(Equipment, equipment_id)
            if eq is None:
                return {"status": "error", "message": "Equipment not found"}
            run = CaptureRun(equipment_id=eq.id, trigger=trigger)
            db.add(run)
            eq.status = "running"
            db.commit()
            errors: list[str] = []
            try:
                parser_fn(eq)
                phash = parser_hash(eq)
                with open_fetcher(eq) as fetcher:
                    files = discover(fetcher, eq)
                    run.files_found = len(files)
                    known = {
                        cf.path: cf
                        for cf in db.scalars(select(CapturedFile).where(CapturedFile.equipment_id == eq.id))
                    }
                    for rf in files:
                        cf = known.get(rf.path)
                        if cf and cf.size == rf.size and abs(cf.mtime - rf.mtime) < 1e-3 and cf.parser_hash == phash:
                            continue
                        try:
                            with fetcher.local(rf) as local_path:
                                n = ingest_file(db, eq, local_path, rf.path, rf.size, rf.mtime)
                            run.files_parsed += 1
                            run.rows += n
                        except Exception as e:
                            db.rollback()
                            msg = _err_text(e)
                            errors.append(f"{rf.path}: {msg}")
                            _mark_file_error(db, eq, rf.path, rf.size, rf.mtime, msg)
                status = "ok" if not errors else ("warning" if run.files_parsed else "error")
                msg = f"found {run.files_found} / parsed {run.files_parsed} / {run.rows} rows"
                if errors:
                    msg += "\n" + "\n".join(errors[:20])
                _finish(db, eq, run, status, msg)
            except Exception as e:
                db.rollback()
                _finish(db, eq, run, "error", _err_text(e))
            return {
                "status": run.status,
                "message": run.message,
                "files_found": run.files_found,
                "files_parsed": run.files_parsed,
                "rows": run.rows,
            }
    finally:
        lock.release()


def ingest_uploaded(equipment_id: int, local_path: str, source_path: str, size: int, mtime: float) -> dict:
    """Agent(push) 업로드 파일 처리."""
    with equipment_lock(equipment_id):
        with SessionLocal() as db:
            eq = db.get(Equipment, equipment_id)
            run = CaptureRun(equipment_id=eq.id, trigger="agent", files_found=1)
            db.add(run)
            db.commit()
            try:
                n = ingest_file(db, eq, local_path, source_path, size, mtime)
                run.files_parsed, run.rows = 1, n
                _finish(db, eq, run, "ok", f"[{source_path}] {n} rows")
                return {"status": "ok", "rows": n}
            except Exception as e:
                db.rollback()
                msg = _err_text(e)
                _mark_file_error(db, eq, source_path, size, mtime, msg)
                _finish(db, eq, run, "error", f"{source_path}: {msg}")
                return {"status": "error", "message": msg}


def load_records(db, equipment_ids: list[int], since: datetime | None = None, until: datetime | None = None) -> pd.DataFrame:
    q = select(Record.equipment_id, Record.ts, Record.data).where(Record.equipment_id.in_(equipment_ids))
    if since:
        q = q.where(Record.ts >= since)
    if until:
        q = q.where(Record.ts <= until)
    q = q.order_by(Record.ts, Record.id)
    rows = db.execute(q).all()
    names = dict(db.execute(select(Equipment.id, Equipment.name).where(Equipment.id.in_(equipment_ids))).all())
    df = pd.DataFrame([r.data for r in rows])
    df["_ts"] = pd.to_datetime(pd.Series([r.ts for r in rows], dtype="object"))
    df["_equipment"] = [names.get(r.equipment_id, "") for r in rows]
    return df
