import os
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
ROOT_DIR = BACKEND_DIR.parent

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

for d in (DATA_DIR, DATASET_DIR, STAGING_DIR):
    d.mkdir(parents=True, exist_ok=True)
