import io
import json
from urllib.parse import quote

from fastapi import HTTPException
from fastapi.responses import StreamingResponse


def row_dict(obj, exclude: tuple = ()) -> dict:
    return {c.name: getattr(obj, c.name) for c in obj.__table__.columns if c.name not in exclude}


def get_or_404(db, model, obj_id):
    obj = db.get(model, obj_id)
    if obj is None:
        raise HTTPException(404, f"{model.__name__} {obj_id} not found")
    return obj


def json_download(payload: dict, filename: str) -> StreamingResponse:
    """Flow/대시보드 내보내기: payload 를 .json 파일로 바로 다운로드."""
    buf = io.BytesIO(json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
    return StreamingResponse(
        buf,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}.json"},
    )
