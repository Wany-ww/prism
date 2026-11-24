import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import models  # noqa: F401  (테이블 등록)
from .api import agent, data, equipment, flows, parsers
from .config import FRONTEND_DIST, SCHEDULER_ENABLED, SEED_DEMO
from .db import Base, engine
from .scheduler import scheduler
from .seed import seed_all

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(engine)
    seed_all(SEED_DEMO)
    if SCHEDULER_ENABLED:
        scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="PRISM - 카메라 제조 공정 Tracking", lifespan=lifespan)
for r in (equipment.router, parsers.router, flows.router, data.router, agent.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True}


if FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        f = (FRONTEND_DIST / path).resolve()
        if path and f.is_file() and f.is_relative_to(FRONTEND_DIST.resolve()):
            return FileResponse(f)
        return FileResponse(FRONTEND_DIST / "index.html")
