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
# 수집 원본 레코드: 설비별 폴더에 수집 파일 1개당 parquet 1개
RECORDS_DIR = DATA_DIR / "records"
STAGING_DIR = DATA_DIR / "staging"
FRONTEND_DIST = ROOT_DIR / "frontend" / "dist"
# 서버 이전용 설정 폴더 (설비·Parser·노드·Flow·대시보드). 새 서버의 같은 위치에 복사하고 install.bat 을 실행하면 들여온다.
SETTINGS_DIR = Path(os.environ.get("PRISM_SETTINGS_DIR", ROOT_DIR / "settings"))
# 게이트웨이 PC 용 수집 에이전트 실행 파일 (화면에서 내려받음)
AGENT_EXE = ROOT_DIR / "agent" / "prism-agent.exe"

DATABASE_URL = os.environ.get("PRISM_DATABASE_URL", f"sqlite:///{(DATA_DIR / 'prism.db').as_posix()}")

SCHEDULER_ENABLED = os.environ.get("PRISM_SCHEDULER", "1") == "1"
# 수집·Flow 는 API 와 다른 프로세스에서 실행 (GIL 때문에 무거운 작업이 화면 응답을 막지 않도록)
CAPTURE_WORKERS = int(os.environ.get("PRISM_CAPTURE_WORKERS", os.environ.get("PRISM_WORKERS", "4")))
FLOW_WORKERS = int(os.environ.get("PRISM_FLOW_WORKERS", "2"))
# 데이터셋 메모리 캐시 한도 (MB). 이보다 큰 조회 결과는 캐시하지 않는다.
CACHE_MB = int(os.environ.get("PRISM_CACHE_MB", "1024"))
# Agent(push) 업로드 인증 토큰. 비어 있으면 검사하지 않음.
AGENT_TOKEN = os.environ.get("PRISM_AGENT_TOKEN", "")
SEED_DEMO = os.environ.get("PRISM_SEED_DEMO", "1") == "1"

# 알림 웹훅 (Slack 등 incoming webhook 호환 URL). 비어 있으면 알림 기능이 꺼진다.
ALERT_WEBHOOK = os.environ.get("PRISM_ALERT_WEBHOOK", "")
# 같은 설비/Flow 는 이 시간(초) 안에 한 번만 알림 (상태가 자주 바뀌어도 스팸 방지)
ALERT_MIN_INTERVAL_SEC = int(os.environ.get("PRISM_ALERT_MIN_INTERVAL_SEC", "300"))

# Neo4j 제품 계보 그래프 (선택). URI 가 비어 있으면 그래프 기능은 꺼진다.
NEO4J_URI = os.environ.get("PRISM_NEO4J_URI", "")
NEO4J_USER = os.environ.get("PRISM_NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.environ.get("PRISM_NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.environ.get("PRISM_NEO4J_DATABASE", "neo4j")

# AI Agent: 프롬프트로 Flow·대시보드를 만들어 주는 에이전트. 지금은 이 서버에 로그인된 Claude Code CLI 를 임시로 사용.
AI_CLAUDE_BIN = os.environ.get("PRISM_CLAUDE_BIN", "")  # 비어 있으면 PATH 에서 claude 를 찾음
# 에이전트가 호출할 PRISM API 주소 (백엔드 자신)
AI_API_URL = os.environ.get("PRISM_AI_API_URL", "http://127.0.0.1:8000")
AI_TIMEOUT_MIN = int(os.environ.get("PRISM_AI_TIMEOUT_MIN", "30"))
AI_MODEL = os.environ.get("PRISM_AI_MODEL", "")  # 비어 있으면 Claude Code 기본 모델
AGENT_DIR = DATA_DIR / "agent"

for d in (DATA_DIR, DATASET_DIR, RECORDS_DIR, STAGING_DIR):
    d.mkdir(parents=True, exist_ok=True)
