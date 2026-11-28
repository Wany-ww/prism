from sqlalchemy import create_engine, event
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import DATABASE_URL

_is_sqlite = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30} if _is_sqlite else {},
    pool_pre_ping=True,
    # PostgreSQL: API 프로세스 + 수집/Flow 작업 프로세스가 각자 풀을 가지므로 프로세스당 연결 수를 제한
    **({} if _is_sqlite else {"pool_size": 5, "max_overflow": 10, "pool_recycle": 1800}),
)

if not _is_sqlite:

    @event.listens_for(Session, "before_flush")
    def _strip_nul(session, _ctx, _instances):
        """PostgreSQL 문자열에는 NUL(\\x00)을 넣을 수 없다 — 바이너리 파일 파싱 오류 메시지 등에 섞여 들어오면 저장 전에 제거."""
        for obj in (*session.new, *session.dirty):
            for attr in sa_inspect(obj).mapper.column_attrs:
                v = obj.__dict__.get(attr.key)
                if isinstance(v, str) and "\x00" in v:
                    setattr(obj, attr.key, v.replace("\x00", ""))


if _is_sqlite:

    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def ensure_columns():
    """기존 DB 에 새로 추가된 컬럼을 ALTER TABLE 로 보강 (create_all 은 기존 테이블을 바꾸지 않음)."""
    from sqlalchemy import inspect, text

    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for col in table.columns:
                if col.name in existing:
                    continue
                ddl = f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"
                default = getattr(col.default, "arg", None)
                if isinstance(default, str):
                    ddl += " DEFAULT '" + default.replace("'", "''") + "'"
                elif isinstance(default, bool):
                    # PostgreSQL 의 boolean 은 1/0 을 받지 않음 (SQLite 3.23+ 도 TRUE/FALSE 를 이해함)
                    ddl += f" DEFAULT {'TRUE' if default else 'FALSE'}"
                elif isinstance(default, (int, float)):
                    ddl += f" DEFAULT {default}"
                if not col.nullable and default is not None and not callable(default):
                    ddl += " NOT NULL"
                conn.execute(text(ddl))
            for idx in table.indexes:
                idx.create(conn, checkfirst=True)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
