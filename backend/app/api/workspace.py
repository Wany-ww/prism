"""설정 폴더 화면 API (Settings > Move to another server)."""

import shutil
import tempfile
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import workspace
from ..config import SETTINGS_DIR, STAGING_DIR
from ..db import get_db
from ..models import Dashboard, Equipment, Flow, NodeType, Parser

router = APIRouter(prefix="/api/workspace", tags=["workspace"])
UPLOAD_DIR = STAGING_DIR / "settings-upload"


def _folder_info() -> dict:
    try:
        m = workspace.read_manifest(SETTINGS_DIR)
    except workspace.BundleError:
        m = None
    return {"path": str(SETTINGS_DIR), "manifest": m}


@router.get("/summary")
def summary(db: Session = Depends(get_db)):
    """설정 화면: 이 서버에 있는 설정 항목 수와 설정 폴더 상태."""
    count = lambda m: db.scalar(select(func.count()).select_from(m))  # noqa: E731
    return {
        "parsers": count(Parser),
        "node_types": count(NodeType),
        "equipment": count(Equipment),
        "flows": count(Flow),
        "dashboards": count(Dashboard),
        "equipment_with_password": db.scalar(select(func.count()).select_from(Equipment).where(Equipment.password != "")),
        "folder": _folder_info(),
    }


class SaveIn(BaseModel):
    secrets: bool = False


@router.post("/save")
def save(body: SaveIn, db: Session = Depends(get_db)):
    """이 서버의 설정 폴더(settings\\)에 저장."""
    try:
        workspace.write_folder(workspace.export_bundle(db, include_secrets=body.secrets), SETTINGS_DIR)
    except OSError as e:
        raise HTTPException(500, f"Could not write {SETTINGS_DIR}: {e}") from e
    return _folder_info()


@router.get("/export.zip")
def export_zip(background: BackgroundTasks, secrets: bool = False, db: Session = Depends(get_db)):
    """설정 폴더와 같은 구조를 zip 으로 내려받기."""
    tmp = Path(tempfile.mkdtemp(prefix="prism-export-"))
    workspace.write_folder(workspace.export_bundle(db, include_secrets=secrets), tmp / "settings")
    name = f"prism-settings-{datetime.now():%Y%m%d-%H%M}"
    zpath = tmp / f"{name}.zip"
    workspace.zip_folder(tmp / "settings", zpath, arc_root=name)
    background.add_task(shutil.rmtree, tmp, True)
    return FileResponse(zpath, media_type="application/zip", filename=f"{name}.zip")


def _clean_uploads(max_age_sec: int = 86400):
    if not UPLOAD_DIR.exists():
        return
    for d in UPLOAD_DIR.iterdir():
        try:
            if time.time() - d.stat().st_mtime > max_age_sec:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def _safe_rel(name: str) -> Path | None:
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".", "..")]
    return Path(*[workspace.safe_name(p) if p != workspace.MANIFEST else p for p in parts]) if parts else None


@router.post("/upload")
async def upload(files: list[UploadFile] = File(...)):
    """설정 폴더(폴더 선택으로 올린 파일들) 또는 zip 하나를 임시로 올림 → token. 미리보기/들여오기는 /import 로."""
    _clean_uploads()
    token = uuid.uuid4().hex
    dest = UPLOAD_DIR / token
    dest.mkdir(parents=True)
    try:
        if len(files) == 1 and (files[0].filename or "").lower().endswith(".zip"):
            zpath = dest / "upload.zip"
            with open(zpath, "wb") as fh:
                shutil.copyfileobj(files[0].file, fh)
            root = workspace.extract_zip(zpath, dest / "x")
        else:
            for f in files:
                rel = _safe_rel(f.filename or "")
                if rel is None:
                    continue
                target = dest / "x" / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "wb") as fh:
                    shutil.copyfileobj(f.file, fh)
            root = workspace.find_root(dest / "x")
        manifest = workspace.read_manifest(root)
    except (workspace.BundleError, zipfile.BadZipFile) as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(400, str(e) if isinstance(e, workspace.BundleError) else "The file is not a valid zip.") from e
    (dest / "root.txt").write_text(str(root), encoding="utf-8")
    return {"token": token, "manifest": manifest}


class ImportIn(BaseModel):
    source: str = "folder"  # folder: 이 서버의 settings\ / upload: /upload 로 올린 것
    token: str = ""
    overwrite: bool = False
    activate: bool = False
    parts: list[str] = Field(default_factory=lambda: list(workspace.PARTS))
    dry_run: bool = False


def _upload_root(token: str) -> Path:
    if not token or not token.isalnum():
        raise HTTPException(400, "Upload the settings folder again.")
    f = UPLOAD_DIR / token / "root.txt"
    if not f.exists():
        raise HTTPException(400, "The uploaded settings expired. Upload them again.")
    return Path(f.read_text(encoding="utf-8"))


@router.post("/import")
def import_(body: ImportIn, db: Session = Depends(get_db)):
    try:
        root = _upload_root(body.token) if body.source == "upload" else SETTINGS_DIR
        bundle = workspace.read_folder(root)
        result = workspace.import_bundle(db, bundle, overwrite=body.overwrite, activate=body.activate, parts=body.parts, dry_run=body.dry_run)
    except workspace.BundleError as e:
        raise HTTPException(400, str(e)) from e
    if body.source == "upload" and not body.dry_run:
        shutil.rmtree(UPLOAD_DIR / body.token, ignore_errors=True)
    return result
