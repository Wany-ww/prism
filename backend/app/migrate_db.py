"""SQLite(prism.db) → PostgreSQL 데이터 이전.

    cd backend
    .venv\\Scripts\\python.exe -m app.migrate_db                  # backend/data/prism.db → PRISM_DATABASE_URL
    .venv\\Scripts\\python.exe -m app.migrate_db --source sqlite:///D:/backup/prism.db
    .venv\\Scripts\\python.exe -m app.migrate_db --replace        # 대상에 데이터가 있으면 지우고 다시 이전

- 대상 DB 에 테이블을 만들고, 모든 행을 같은 id 로 옮긴 뒤 id 시퀀스를 맞춘다. 전체가 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다.
- 데이터셋·수집 레코드(parquet 파일)는 DB 밖(backend/data)에 있으므로 옮길 필요가 없다.
- 원본 SQLite 파일은 그대로 둔다 (되돌리려면 .env 의 PRISM_DATABASE_URL 줄만 지우면 됨).
- 이전하는 동안 백엔드를 끄고 실행할 것 (실행 중이면 그 사이 바뀐 내용이 빠질 수 있음).
"""

import argparse
import math
import sys

from sqlalchemy import JSON, String, create_engine, func, inspect, select, text

from . import models  # noqa: F401  (테이블 등록)
from .config import DATA_DIR, DATABASE_URL
from .db import Base

CHUNK = 2000


def _clean_json(v):
    """PostgreSQL JSONB 가 못 받는 값(NaN/Infinity, \\u0000)을 정리."""
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, str):
        return v.replace("\x00", "")
    if isinstance(v, dict):
        return {(k.replace("\x00", "") if isinstance(k, str) else k): _clean_json(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean_json(x) for x in v]
    return v


def _hide(url: str) -> str:
    """로그에 비밀번호가 찍히지 않도록."""
    return create_engine(url).url.render_as_string(hide_password=True)


def migrate(source: str, target: str, replace: bool = False) -> dict:
    if not target.startswith("postgresql"):
        raise SystemExit(f"Target must be a PostgreSQL URL (PRISM_DATABASE_URL), got {_hide(target)}")
    src = create_engine(source)
    dst = create_engine(target)
    src_tables = set(inspect(src).get_table_names())
    tables = [t for t in Base.metadata.sorted_tables if t.name in src_tables]
    skipped = sorted(src_tables - {t.name for t in Base.metadata.sorted_tables})

    Base.metadata.create_all(dst)
    counts: dict[str, int] = {}
    with src.connect() as s, dst.begin() as d:
        existing = {t.name: d.scalar(select(func.count()).select_from(t)) for t in Base.metadata.sorted_tables}
        if any(existing.values()):
            if not replace:
                busy = ", ".join(f"{k}={v}" for k, v in existing.items() if v)
                raise SystemExit(f"Target already has data ({busy}). Run with --replace to overwrite it.")
            names = ", ".join(t.name for t in Base.metadata.sorted_tables)
            d.execute(text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))

        for t in tables:
            # 원본 SQLite 에 없는 컬럼(아직 ensure_columns 전)은 빼고 읽음 → 대상에서는 기본값/NULL
            src_cols = {c["name"] for c in inspect(src).get_columns(t.name)}
            cols = [c for c in t.columns if c.name in src_cols]
            json_cols = [c.name for c in cols if isinstance(c.type, JSON) or isinstance(getattr(c.type, "impl", None), JSON)]
            str_limits = {c.name: c.type.length for c in cols if isinstance(c.type, String) and c.type.length}
            n = 0
            result = s.execute(select(*cols).order_by(*t.primary_key.columns))
            while batch := result.fetchmany(CHUNK):
                rows = []
                for r in batch:
                    row = dict(r._mapping)
                    for k, v in row.items():
                        if isinstance(v, str):
                            v = v.replace("\x00", "")
                            if k in str_limits and len(v) > str_limits[k]:
                                raise SystemExit(f"{t.name}.{k} (id={row.get('id')}) is {len(v)} chars, longer than the column limit {str_limits[k]}.")
                            row[k] = v
                    for k in json_cols:
                        row[k] = _clean_json(row[k])
                    rows.append(row)
                d.execute(t.insert(), rows)
                n += len(rows)
            counts[t.name] = n
            # 같은 id 로 넣었으므로 다음 id 가 이어지도록 시퀀스 조정
            pk = list(t.primary_key.columns)
            if len(pk) == 1 and pk[0].autoincrement in (True, "auto") and pk[0].type.python_type is int:
                d.execute(
                    text(f"SELECT setval(pg_get_serial_sequence('{t.name}', '{pk[0].name}'), COALESCE(MAX({pk[0].name}), 1), MAX({pk[0].name}) IS NOT NULL) FROM {t.name}")
                )

        # 검증: 행 수 비교
        for t in tables:
            got = d.scalar(select(func.count()).select_from(t))
            want = s.scalar(select(func.count()).select_from(t))
            if got != want:
                raise SystemExit(f"Row count mismatch in {t.name}: source {want}, target {got} — nothing was changed.")
    return {"tables": counts, "skipped": skipped}


def main(argv=None):
    p = argparse.ArgumentParser(description="Copy PRISM metadata from SQLite to PostgreSQL")
    p.add_argument("--source", default=f"sqlite:///{(DATA_DIR / 'prism.db').as_posix()}")
    p.add_argument("--target", default=DATABASE_URL)
    p.add_argument("--replace", action="store_true", help="overwrite data that is already in the target")
    a = p.parse_args(argv)
    print(f"source: {_hide(a.source)}\ntarget: {_hide(a.target)}")
    out = migrate(a.source, a.target, a.replace)
    for k, v in out["tables"].items():
        print(f"  {k:<16} {v:>8,} rows")
    if out["skipped"]:
        print(f"  (not copied, not used by PRISM: {', '.join(out['skipped'])})")
    print("done")


if __name__ == "__main__":
    sys.exit(main())
