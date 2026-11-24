import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent


def _load_env_file(path: Path):
    """backend/.env 의 KEY=VALUE 를 기본값으로 읽는다 (이미 설정된 환경변수가 우선). 비밀번호는 이 파일에 두고 git 에 올리지 않는다."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(BACKEND_DIR / ".env")

DATA_DIR = Path(os.environ.get("PRISM_DATA_DIR", BACKEND_DIR / "data"))
DATASET_DIR = DATA_DIR / "datasets"
STAGING_DIR = DATA_DIR / "staging"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"

DATABASE_URL = os.environ.get("PRISM_DATABASE_URL", f"sqlite:///{(DATA_DIR / 'prism.db').as_posix()}")

SCHEDULER_ENABLED = os.environ.get("PRISM_SCHEDULER", "1") == "1"
SCHEDULER_WORKERS = int(os.environ.get("PRISM_WORKERS", "4"))
# Agent(push) 업로드 인증 토큰. 비어 있으면 검사하지 않음.
AGENT_TOKEN = os.environ.get("PRISM_AGENT_TOKEN", "")
SEED_DEMO = os.environ.get("PRISM_SEED_DEMO", "1") == "1"

# Neo4j 제품 계보 그래프 (선택). URI 가 비어 있으면 그래프 기능은 꺼진다.
NEO4J_URI = os.environ.get("PRISM_NEO4J_URI", "")
NEO4J_USER = os.environ.get("PRISM_NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("PRISM_NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.environ.get("PRISM_NEO4J_DATABASE", "neo4j")

for d in (DATA_DIR, DATASET_DIR, STAGING_DIR):
    d.mkdir(parents=True, exist_ok=True)
