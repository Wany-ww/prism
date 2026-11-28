"""설치(install.bat) 때 한 번: DB 접속 확인, 테이블 생성/보정, 기본 데이터, 네이티브 엔진 확인.

    python -m app.setup
"""

import re
import sys


def main() -> int:
    from . import models  # noqa: F401  (테이블 등록)
    from .capture.store import migrate_sql_records
    from .config import DATABASE_URL, SEED_DEMO
    from .db import Base, SessionLocal, engine, ensure_columns
    from .engine.native import core
    from .seed import seed_all

    print(f"native engine prism_core {core.version()}")
    print("database", re.sub(r"://([^:/@]+):[^@]*@", r"://\1:***@", DATABASE_URL))
    Base.metadata.create_all(engine)
    ensure_columns()
    migrate_sql_records(engine, SessionLocal)
    seed_all(SEED_DEMO, background=False)
    with SessionLocal() as db:
        from sqlalchemy import func, select

        counts = {m.__tablename__: db.scalar(select(func.count()).select_from(m)) for m in (models.Equipment, models.Parser, models.Flow, models.Dashboard)}
    print("tables ready: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
