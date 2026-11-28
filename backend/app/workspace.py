"""설정 폴더: 설비·Parser·노드 라이브러리·Match/Analysis Flow·대시보드를 폴더 하나(하위 폴더/파일)로 정리해 내보내고 들여온다.

서버를 옮기거나 같은 설정으로 서버를 하나 더 만들 때 쓴다. 기본 위치는 설치 폴더의 settings\\ 이고,
이 폴더를 새 서버의 같은 위치에 복사한 뒤 install.bat 을 실행하면 자동으로 들여온다.

    settings/
      prism-settings.json          목록 (내보낸 시각, 항목 수, 형식 버전)
      README.txt
      parsers/<이름>.json, .py      Parser 설명 + 코드
      node-library/<key>.json, .py 노드 라이브러리 정의 + 코드
      equipment/<설비명>.json       설비 설정 (Parser 는 이름으로 참조)
      flows/match/<이름>.json       Match Flow (설비 데이터 노드는 설비 이름으로 참조)
      flows/analysis/<이름>.json    Analysis Flow
      dashboards/<이름>.json        대시보드
      secrets/equipment-passwords.json   FTP/SFTP 비밀번호 (선택했을 때만)

DB id 는 서버마다 달라지므로 모두 '이름'으로 참조한다. 수집 레코드·데이터셋(parquet)은 '데이터'라 넣지 않는다 —
Flow 를 다시 실행하면 데이터셋이 다시 만들어지고, 수집 이력까지 옮기려면 backend/data 폴더를 통째로 복사한다.

화면(Settings > Move to another server)과 명령줄에서 같은 코드를 쓴다:
    python -m app.workspace export [폴더] [--secrets]
    python -m app.workspace import [폴더|zip] [--overwrite] [--activate] [--dry-run]
"""

import argparse
import copy
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

from sqlalchemy import select

from .models import Dashboard, Equipment, Flow, NodeType, Parser

BUNDLE_TYPE = "prism-workspace"
VERSION = 1
PARTS = ("parsers", "node_types", "equipment", "flows", "dashboards")
FOLDER_TYPE = "prism-settings"
FOLDER_VERSION = 2
MANIFEST = "prism-settings.json"
# 내보내기 때 새로 쓰는 항목 (폴더 안 다른 파일은 건드리지 않음)
MANAGED = (MANIFEST, "README.txt", "parsers", "node-library", "equipment", "flows", "dashboards", "secrets")

EQUIPMENT_FIELDS = (
    "name", "factory", "customer", "product", "project", "process", "ip", "access_method", "port", "username",
    "log_path", "folder_mode", "file_pattern", "lookback_days", "encoding", "capture_interval_sec", "enabled",
    "options", "description",
)  # fmt: skip
NODE_TYPE_FIELDS = ("key", "name", "category", "description", "color", "inputs", "params", "code")


class BundleError(ValueError):
    pass


# ---------- Flow 그래프: 설비 id ↔ 이름 ----------


def _source_nodes(graph: dict):
    for n in (graph or {}).get("nodes", []):
        d = n.get("data") or {}
        if d.get("kind") == "source":
            yield d.setdefault("params", {})


def graph_to_portable(graph: dict, eq_names: dict[int, str]) -> dict:
    """설비 데이터 노드의 equipment_ids(이 서버의 id)를 equipment(설비 이름 목록)로 바꾼 사본."""
    g = copy.deepcopy(graph or {"nodes": [], "edges": []})
    for p in _source_nodes(g):
        ids = [int(i) for i in p.pop("equipment_ids", None) or []]
        p["equipment"] = [eq_names[i] for i in ids if i in eq_names]
    return g


def graph_from_portable(graph: dict, eq_ids: dict[str, int]) -> tuple[dict, list[str]]:
    """equipment(이름) → equipment_ids(이 서버의 id). 이 서버에 없는 설비 이름은 빼고 목록으로 돌려줌.
    예전 형식(equipment_ids 만 있는 파일)은 id 를 그대로 둔다."""
    g = copy.deepcopy(graph or {"nodes": [], "edges": []})
    missing: list[str] = []
    for p in _source_nodes(g):
        if "equipment" not in p:
            continue
        names = [str(x) for x in p.pop("equipment") or []]
        p["equipment_ids"] = [eq_ids[n] for n in names if n in eq_ids]
        missing += [n for n in names if n not in eq_ids]
    return g, sorted(set(missing))


def eq_name_map(db) -> dict[int, str]:
    return dict(db.execute(select(Equipment.id, Equipment.name)).all())


# ---------- 내보내기 ----------


def export_bundle(db, include_secrets: bool = False) -> dict:
    parsers = {p.id: p for p in db.scalars(select(Parser).order_by(Parser.name))}
    eqs = list(db.scalars(select(Equipment).order_by(Equipment.name)))
    names = {e.id: e.name for e in eqs}
    equipment = []
    for e in eqs:
        item = {f: getattr(e, f) for f in EQUIPMENT_FIELDS}
        item["parser"] = parsers[e.parser_id].name if e.parser_id in parsers else None
        if include_secrets and e.password:
            item["password"] = e.password
        equipment.append(item)
    return {
        "_type": BUNDLE_TYPE,
        "version": VERSION,
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "includes_secrets": include_secrets,
        "parsers": [{"name": p.name, "description": p.description, "code": p.code} for p in parsers.values()],
        "node_types": [{f: getattr(n, f) for f in NODE_TYPE_FIELDS} for n in db.scalars(select(NodeType).order_by(NodeType.key))],
        "equipment": equipment,
        "flows": [
            {"name": f.name, "kind": f.kind, "description": f.description, "schedule_minutes": f.schedule_minutes, "graph": graph_to_portable(f.graph, names)}
            for f in db.scalars(select(Flow).order_by(Flow.kind, Flow.name))
        ],
        "dashboards": [
            {"name": d.name, "slug": d.slug, "description": d.description, "refresh_sec": d.refresh_sec, "layout": d.layout}
            for d in db.scalars(select(Dashboard).order_by(Dashboard.name))
        ],
    }


# ---------- 폴더 형식 ----------

_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

README = """PRISM 설정 폴더

이 폴더를 새 서버의 PRISM 설치 폴더 안 settings\\ 에 복사한 뒤 install.bat 을 실행하면 설정이 들여와집니다.
(이미 설치된 서버라면 화면의 Settings > Move to another server 또는 명령줄
 .runtime\\python\\python.exe -m app.workspace import settings  로 들여옵니다.)

parsers/        Parser 설명(.json)과 코드(.py)
node-library/   노드 라이브러리 정의(.json)와 코드(.py)
equipment/      설비 설정 — Parser 는 이름으로 참조
flows/match/    Match Flow — 설비 데이터 노드는 설비 이름으로 참조
flows/analysis/ Analysis Flow
dashboards/     대시보드
secrets/        FTP/SFTP 비밀번호 (내보낼 때 선택한 경우에만, 옮긴 뒤 지우세요)

들여올 때 같은 이름이 있으면 기본은 건너뛰고, 설비 수집과 Flow 자동 실행은 꺼진 채로 들어옵니다.
수집 레코드와 데이터셋은 데이터라 들어 있지 않습니다 (Flow 를 한 번 실행하면 다시 만들어집니다).
"""


def safe_name(name: str) -> str:
    """Windows 파일 이름으로 쓸 수 있게 (금지 문자 → _, 예약어 피함)."""
    s = _BAD.sub("_", str(name)).strip().rstrip(". ") or "_"
    if s.split(".")[0].upper() in _RESERVED:
        s = "_" + s
    return s[:120]


class _Names:
    """같은 폴더 안 파일 이름이 겹치지 않게 (Windows 는 대소문자 구분 없음)."""

    def __init__(self):
        self.used: set[str] = set()

    def __call__(self, name: str) -> str:
        base = safe_name(name)
        out, n = base, 1
        while out.lower() in self.used:
            n += 1
            out = f"{base}~{n}"
        self.used.add(out.lower())
        return out


def _dump(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


def _code(path: Path, code: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    # 줄바꿈은 원래 코드 그대로 (Windows 에서 \r\n 으로 바뀌지 않게)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(code or "")


def write_folder(bundle: dict, folder: Path) -> dict:
    """bundle(export_bundle 결과)을 폴더 구조로 저장. 폴더 안 PRISM 관리 항목만 새로 쓰고 다른 파일은 그대로 둔다."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f".writing-{uuid.uuid4().hex[:8]}"
    tmp.mkdir()
    try:
        names = _Names()
        for p in bundle["parsers"]:
            f = names(p["name"])
            _code(tmp / "parsers" / f"{f}.py", p.get("code") or "")
            _dump(tmp / "parsers" / f"{f}.json", {"name": p["name"], "description": p.get("description") or "", "code_file": f"{f}.py"})
        names = _Names()
        for n in bundle["node_types"]:
            f = names(n["key"])
            meta = {k: v for k, v in n.items() if k != "code"}
            meta["code_file"] = f"{f}.py"
            _code(tmp / "node-library" / f"{f}.py", n.get("code") or "")
            _dump(tmp / "node-library" / f"{f}.json", meta)
        names = _Names()
        passwords = {}
        for e in bundle["equipment"]:
            e = dict(e)
            if "password" in e:
                passwords[e["name"]] = e.pop("password")
            _dump(tmp / "equipment" / f"{names(e['name'])}.json", e)
        if passwords:
            _dump(tmp / "secrets" / "equipment-passwords.json", passwords)
        by_kind: dict[str, _Names] = {}
        for fl in bundle["flows"]:
            kind = fl.get("kind") if fl.get("kind") in ("match", "analysis") else "analysis"
            _dump(tmp / "flows" / kind / f"{by_kind.setdefault(kind, _Names())(fl['name'])}.json", fl)
        names = _Names()
        for d in bundle["dashboards"]:
            _dump(tmp / "dashboards" / f"{names(d['name'])}.json", d)
        counts = {k: len(bundle[k]) for k in PARTS}
        manifest = {
            "_type": FOLDER_TYPE,
            "version": FOLDER_VERSION,
            "exported_at": bundle["exported_at"],
            "includes_secrets": bool(passwords),
            "counts": counts,
        }
        _dump(tmp / MANIFEST, manifest)
        (tmp / "README.txt").write_text(README, encoding="utf-8")
        # 바꿔치기: 이전 관리 항목을 지우고 새로 만든 것으로
        for item in MANAGED:
            old = folder / item
            if old.is_dir():
                shutil.rmtree(old)
            elif old.exists():
                old.unlink()
        for child in tmp.iterdir():
            os.replace(child, folder / child.name)
        return manifest
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _load_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as e:
        raise BundleError(f"{path.name}: not valid JSON ({e.msg}, line {e.lineno})") from e


def _items(folder: Path) -> list[dict]:
    return [_load_json(p) for p in sorted(folder.glob("*.json"))] if folder.is_dir() else []


def _with_code(folder: Path, meta: dict) -> dict:
    meta = dict(meta)
    cf = meta.pop("code_file", None)
    if cf and "code" not in meta:
        path = folder / cf
        meta["code"] = path.read_text(encoding="utf-8") if path.exists() else ""
    return meta


def read_manifest(folder: Path) -> dict | None:
    path = Path(folder) / MANIFEST
    if not path.exists():
        return None
    m = _load_json(path)
    return m if isinstance(m, dict) and m.get("_type") == FOLDER_TYPE else None


def read_folder(folder: Path) -> dict:
    """설정 폴더 → bundle(import_bundle 입력)."""
    folder = Path(folder)
    manifest = read_manifest(folder)
    if manifest is None:
        raise BundleError(f"{folder} is not a PRISM settings folder ({MANIFEST} is missing).")
    if int(manifest.get("version") or 0) > FOLDER_VERSION:
        raise BundleError(f"This settings folder was made by a newer PRISM (version {manifest.get('version')}). Update this server first.")
    passwords = {}
    pw_file = folder / "secrets" / "equipment-passwords.json"
    if pw_file.exists():
        passwords = _load_json(pw_file) or {}
    equipment = []
    for e in _items(folder / "equipment"):
        if e.get("name") in passwords:
            e["password"] = passwords[e["name"]]
        equipment.append(e)
    return {
        "_type": BUNDLE_TYPE,
        "version": VERSION,
        "exported_at": manifest.get("exported_at"),
        "includes_secrets": bool(passwords),
        "parsers": [_with_code(folder / "parsers", p) for p in _items(folder / "parsers")],
        "node_types": [_with_code(folder / "node-library", n) for n in _items(folder / "node-library")],
        "equipment": equipment,
        "flows": _items(folder / "flows" / "match") + _items(folder / "flows" / "analysis"),
        "dashboards": _items(folder / "dashboards"),
    }


def find_root(folder: Path) -> Path:
    """압축을 풀거나 폴더째 올린 경우 prism-settings.json 이 있는 하위 폴더를 찾음."""
    folder = Path(folder)
    if (folder / MANIFEST).exists():
        return folder
    for p in sorted(folder.rglob(MANIFEST)):
        if len(p.relative_to(folder).parts) <= 3:
            return p.parent
    raise BundleError(f"No {MANIFEST} found — choose the settings folder (or a zip of it) exported from PRISM.")


def extract_zip(zip_path, dest: Path) -> Path:
    dest = Path(dest)
    with zipfile.ZipFile(zip_path) as z:
        for info in z.infolist():
            target = (dest / info.filename).resolve()
            if not target.is_relative_to(dest.resolve()):
                raise BundleError("The zip contains unsafe paths.")
        z.extractall(dest)
    return find_root(dest)


def zip_folder(folder: Path, zip_path, arc_root: str = "prism-settings"):
    folder = Path(folder)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(folder.rglob("*")):
            rel = p.relative_to(folder)
            if p.is_file() and rel.parts[0] in MANAGED:
                z.write(p, f"{arc_root}/{rel.as_posix()}")


def load_source(path) -> dict:
    """폴더 / zip / (예전) 단일 JSON 묶음 → bundle."""
    path = Path(path)
    if path.is_dir():
        return read_folder(find_root(path))
    if path.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="prism-settings-"))
        try:
            return read_folder(extract_zip(path, tmp))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    if path.name == MANIFEST:
        return read_folder(path.parent)
    data = _load_json(path)
    _check(data)
    return data


# ---------- 들여오기 ----------


def _check(bundle: dict):
    if not isinstance(bundle, dict) or bundle.get("_type") != BUNDLE_TYPE:
        raise BundleError("This file is not a PRISM settings bundle (prism-workspace).")
    if int(bundle.get("version") or 0) > VERSION:
        raise BundleError(f"This bundle was made by a newer PRISM (version {bundle.get('version')}). Update this server first.")
    for part in PARTS:
        if not isinstance(bundle.get(part, []), list):
            raise BundleError(f"'{part}' must be a list.")


def import_bundle(db, bundle: dict, *, overwrite: bool = False, activate: bool = False, parts=PARTS, dry_run: bool = False) -> dict:
    """묶음을 이 서버에 반영. 이름(노드는 key, Flow 는 이름+종류)이 같은 항목은 overwrite 면 덮어쓰고 아니면 건너뜀.
    activate=False 면 설비 자동 수집과 Flow 자동 실행을 끈 채로 들여온다 (경로·접속이 새 서버에서 맞는지 확인한 뒤 켜도록).
    dry_run 이면 무엇이 바뀔지만 계산하고 DB 는 그대로 둔다."""
    from .api.data import _slugify, _unique_slug  # 대시보드 식별자 규칙을 화면 API 와 같게

    _check(bundle)
    parts = [p for p in PARTS if p in set(parts)]
    items: list[dict] = []
    notes: list[str] = []

    def act(kind: str, name: str, exists: bool, warnings: list[str] | None = None) -> str:
        action = ("overwrite" if overwrite else "skip") if exists else "create"
        items.append({"type": kind, "name": name, "action": action, "warnings": warnings or []})
        return action

    try:
        # 1) Parser
        parser_ids = dict(db.execute(select(Parser.name, Parser.id)).all())
        if "parsers" in parts:
            for p in bundle.get("parsers", []):
                name = str(p.get("name") or "").strip()
                if not name:
                    continue
                cur = db.scalar(select(Parser).where(Parser.name == name))
                a = act("parser", name, cur is not None)
                if a == "skip":
                    continue
                cur = cur or Parser(name=name)
                cur.description, cur.code = p.get("description") or "", p.get("code") or ""
                db.add(cur)
                db.flush()
                parser_ids[name] = cur.id

        # 2) 노드 라이브러리
        if "node_types" in parts:
            for n in bundle.get("node_types", []):
                key = str(n.get("key") or "").strip()
                if not key:
                    continue
                cur = db.scalar(select(NodeType).where(NodeType.key == key))
                if act("node_type", key, cur is not None) == "skip":
                    continue
                cur = cur or NodeType(key=key)
                for f in NODE_TYPE_FIELDS:
                    if f in n and f != "key":
                        setattr(cur, f, n[f])
                db.add(cur)

        # 3) 설비
        if "equipment" in parts:
            for e in bundle.get("equipment", []):
                name = str(e.get("name") or "").strip()
                if not name:
                    continue
                warn = []
                pname = e.get("parser")
                if pname and pname not in parser_ids:
                    warn.append(f"Parser '{pname}' is not on this server — set it after import.")
                cur = db.scalar(select(Equipment).where(Equipment.name == name))
                if act("equipment", name, cur is not None, warn) == "skip":
                    continue
                cur = cur or Equipment(name=name)
                for f in EQUIPMENT_FIELDS:
                    if f in e and f != "name":
                        setattr(cur, f, e[f])
                if e.get("password"):
                    cur.password = e["password"]  # 묶음에 비밀번호가 없으면 이 서버에 있던 값을 유지
                cur.parser_id = parser_ids.get(pname) if pname else None
                cur.next_capture_at = None
                if not activate:
                    cur.enabled = False
                db.add(cur)
            db.flush()

        # 4) Flow (설비 이름 → 이 서버의 id)
        if "flows" in parts:
            eq_ids = {v: k for k, v in eq_name_map(db).items()}
            for f in bundle.get("flows", []):
                name = str(f.get("name") or "").strip()
                kind = f.get("kind") if f.get("kind") in ("match", "analysis") else "analysis"
                if not name:
                    continue
                graph, missing = graph_from_portable(f.get("graph") or {}, eq_ids)
                warn = [f"Equipment not on this server: {', '.join(missing)}"] if missing else []
                cur = db.scalar(select(Flow).where(Flow.name == name, Flow.kind == kind))
                if act(f"{kind}_flow", name, cur is not None, warn) == "skip":
                    continue
                cur = cur or Flow(name=name, kind=kind)
                cur.description, cur.graph = f.get("description") or "", graph
                cur.schedule_minutes = int(f.get("schedule_minutes") or 0) if activate else 0
                cur.next_run_at = None
                db.add(cur)

        # 5) 대시보드
        if "dashboards" in parts:
            for d in bundle.get("dashboards", []):
                name = str(d.get("name") or "").strip()
                if not name:
                    continue
                cur = db.scalar(select(Dashboard).where(Dashboard.name == name))
                if act("dashboard", name, cur is not None) == "skip":
                    continue
                if cur is None:
                    cur = Dashboard(name=name, slug=_unique_slug(db, (d.get("slug") or "").strip() or _slugify(name)))
                cur.description = d.get("description") or ""
                cur.layout = d.get("layout") if isinstance(d.get("layout"), dict) else {"widgets": []}
                cur.refresh_sec = int(d.get("refresh_sec") or 0)
                db.add(cur)

        if not activate and any(i["type"] == "equipment" and i["action"] != "skip" for i in items):
            notes.append("Imported equipment is disabled. Check paths and accounts on this server, then turn capture on.")
        if not activate and any(i["type"].endswith("_flow") and i["action"] != "skip" for i in items):
            notes.append("Imported flows have auto-run off. Run them once to rebuild their datasets, then set a schedule.")
        if dry_run:
            db.rollback()
        else:
            db.commit()
    except Exception:
        db.rollback()
        raise

    summary: dict[str, int] = {}
    for i in items:
        summary[i["action"]] = summary.get(i["action"], 0) + 1
    return {"dry_run": dry_run, "summary": summary, "items": items, "notes": notes}


# ---------- 명령줄 ----------


def main(argv=None):
    from .config import SETTINGS_DIR
    from .db import Base, SessionLocal, engine, ensure_columns

    p = argparse.ArgumentParser(description="Export / import PRISM settings (equipment, parsers, nodes, flows, dashboards)")
    sub = p.add_subparsers(dest="cmd", required=True)
    pe = sub.add_parser("export", help=f"write the settings folder (default {SETTINGS_DIR})")
    pe.add_argument("folder", nargs="?", default=str(SETTINGS_DIR))
    pe.add_argument("--secrets", action="store_true", help="include FTP/SFTP passwords (secrets/equipment-passwords.json)")
    pe.add_argument("--zip", help="also write a zip of the folder to this path")
    pi = sub.add_parser("import", help="import a settings folder or a zip of it")
    pi.add_argument("source", nargs="?", default=str(SETTINGS_DIR))
    pi.add_argument("--overwrite", action="store_true", help="replace items with the same name (default: skip them)")
    pi.add_argument("--activate", action="store_true", help="keep capture/auto-run settings on (default: imported as off)")
    pi.add_argument("--dry-run", action="store_true", help="show what would change without saving")
    a = p.parse_args(argv)

    Base.metadata.create_all(engine)
    ensure_columns()
    with SessionLocal() as db:
        if a.cmd == "export":
            m = write_folder(export_bundle(db, a.secrets), Path(a.folder))
            if a.zip:
                zip_folder(Path(a.folder), a.zip)
            print(f"settings saved to {a.folder}: " + ", ".join(f"{k} {v}" for k, v in m["counts"].items()))
            return 0
        try:
            r = import_bundle(db, load_source(a.source), overwrite=a.overwrite, activate=a.activate, dry_run=a.dry_run)
        except (BundleError, OSError, zipfile.BadZipFile) as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        for i in r["items"]:
            w = f"  ! {'; '.join(i['warnings'])}" if i["warnings"] else ""
            print(f"  {i['action']:<9} {i['type']:<15} {i['name']}{w}")
        print(("(dry run, nothing saved) " if r["dry_run"] else "") + ", ".join(f"{k} {v}" for k, v in r["summary"].items()))
        for n in r["notes"]:
            print(f"note: {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
