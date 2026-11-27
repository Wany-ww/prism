import os
import shutil
import tempfile
import time
from types import SimpleNamespace

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..capture.service import parser_context
from ..capture.store import record_ts
from ..db import get_db
from ..engine.frames import frame_payload
from ..engine.usercode import UserCodeError, call_user, load_function, to_frame
from ..models import Equipment, Parser
from .common import get_or_404, row_dict

router = APIRouter(prefix="/api/parsers", tags=["capture"])

PARSER_TEMPLATE = '''"""
parse(path, ctx) -> DataFrame | list[dict]
  path : 로컬에서 읽을 수 있는 로그 파일 경로 (원격 파일은 임시 파일로 내려받아 전달)
  ctx  : {"equipment": {ip, name, factory, product, project, process},
          "encoding": 설비에 설정된 인코딩, "options": 설비별 옵션(dict),
          "source_path": 원본 경로, "file_mtime": 파일 수정시각(datetime)}
반환 컬럼 중 `_ts` 는 레코드 시각으로 사용됩니다 (없으면 파일 수정시각).
pd, np, re, json, math, datetime 은 import 없이 사용할 수 있습니다.
"""


def parse(path, ctx):
    df = pd.read_csv(path, encoding=ctx["encoding"])
    df.columns = [str(c).strip() for c in df.columns]
    # df["_ts"] = pd.to_datetime(df["Date"] + " " + df["Time"])
    return df
'''


class ParserIn(BaseModel):
    name: str
    description: str = ""
    code: str = ""


@router.get("/template")
def template():
    return {"code": PARSER_TEMPLATE}


@router.get("")
def list_parsers(db: Session = Depends(get_db)):
    usage = dict(
        db.execute(select(Equipment.parser_id, func.count()).where(Equipment.parser_id.is_not(None)).group_by(Equipment.parser_id)).all()
    )
    out = []
    for p in db.scalars(select(Parser).order_by(Parser.name)):
        d = row_dict(p)
        d["used_by"] = usage.get(p.id, 0)
        out.append(d)
    return out


@router.get("/{pid}")
def get_parser(pid: int, db: Session = Depends(get_db)):
    return row_dict(get_or_404(db, Parser, pid))


@router.post("")
def create_parser(body: ParserIn, db: Session = Depends(get_db)):
    if db.scalar(select(Parser).where(Parser.name == body.name)):
        raise HTTPException(409, "A parser with the same name already exists.")
    p = Parser(name=body.name, description=body.description, code=body.code or PARSER_TEMPLATE)
    db.add(p)
    db.commit()
    return row_dict(p)


@router.put("/{pid}")
def update_parser(pid: int, body: ParserIn, db: Session = Depends(get_db)):
    p = get_or_404(db, Parser, pid)
    if db.scalar(select(Parser).where(Parser.name == body.name, Parser.id != pid)):
        raise HTTPException(409, "A parser with the same name already exists.")
    p.name, p.description, p.code = body.name, body.description, body.code
    db.commit()
    return row_dict(p)


@router.delete("/{pid}")
def delete_parser(pid: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, Parser, pid))
    db.commit()
    return {"ok": True}


@router.post("/test")
def test_parser(
    code: str = Form(...),
    equipment_id: int | None = Form(None),
    server_path: str | None = Form(None),
    encoding: str | None = Form(None),
    file: UploadFile | None = File(None),
    db: Session = Depends(get_db),
):
    """파서 코드를 저장하지 않고 샘플 파일로 실행해 결과를 미리 본다."""
    eq = db.get(Equipment, equipment_id) if equipment_id else None
    cfg = eq or SimpleNamespace(
        ip="", name="test", factory="", product="", project="", process="", encoding="utf-8", options={}
    )
    tmp_dir = None
    try:
        if file is not None and file.filename:
            tmp_dir = tempfile.mkdtemp(prefix="prism_test_")
            path = os.path.join(tmp_dir, os.path.basename(file.filename))
            with open(path, "wb") as f:
                shutil.copyfileobj(file.file, f)
            source = file.filename
        elif server_path:
            path = source = server_path
            if not os.path.exists(path):
                return {"ok": False, "error": f"File not found on the server: [{path}]"}
        else:
            return {"ok": False, "error": "Upload a file to test or enter a server path."}
        ctx = parser_context(cfg, source, os.path.getmtime(path))
        if encoding:
            ctx["encoding"] = encoding
        t0 = time.perf_counter()
        fn = load_function(code, "parse", "parser:test")
        df = to_frame(call_user(fn, "parser:test", path, ctx), "parser:test")
        elapsed = round((time.perf_counter() - t0) * 1000)
        ts = record_ts(df.head(5000), ctx["file_mtime"]).dropna()
        return {
            "ok": True,
            "elapsed_ms": elapsed,
            "has_ts": "_ts" in df.columns,
            "ts_min": ts.min().to_pydatetime() if len(ts) else None,
            "ts_max": ts.max().to_pydatetime() if len(ts) else None,
            "preview": frame_payload(df, 200),
        }
    except UserCodeError as e:
        return {"ok": False, "error": str(e), "detail": e.detail}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)
