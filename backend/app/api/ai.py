from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..ai_agent import AgentUnavailable, runner
from ..db import get_db
from ..models import AgentJob
from .common import get_or_404, row_dict

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _agent_or_404(agent_id: str) -> dict:
    try:
        return runner.agent(agent_id)
    except KeyError:
        raise HTTPException(404, f"Unknown agent '{agent_id}'") from None


@router.get("/agents")
def agents():
    return runner.agents()


@router.post("/agents/{agent_id}/download")
def download(agent_id: str):
    a = _agent_or_404(agent_id)
    if not a["downloadable"]:
        raise HTTPException(400, f"{a['name']} is not downloaded through PRISM — it uses the CLI installed on this server.")
    # 전용 에이전트 배포 서버가 생기면 여기서 내려받아 AGENT_DIR 에 설치
    raise HTTPException(501, "The PRISM AI Agent download server is not available yet. Use Claude Code for now.")


@router.post("/agents/{agent_id}/start")
def start(agent_id: str):
    _agent_or_404(agent_id)
    try:
        return runner.start_agent(agent_id)
    except AgentUnavailable as e:
        raise HTTPException(409, str(e)) from e


@router.post("/agents/{agent_id}/stop")
def stop(agent_id: str):
    _agent_or_404(agent_id)
    return runner.stop_agent(agent_id)


@router.get("/agents/{agent_id}/check")
def check(agent_id: str):
    _agent_or_404(agent_id)
    return runner.check(agent_id)


class JobIn(BaseModel):
    prompt: str
    agent: str = "claude-code"


def _job_out(j: AgentJob, since: int | None = None) -> dict:
    d = row_dict(j, exclude=("events",) if since is None else ())
    if since is not None:
        d["events"] = (j.events or [])[since:]
        d["event_count"] = len(j.events or [])
    return d


def _settle(db, j: AgentJob):
    """서버가 다시 시작돼 실제로는 돌고 있지 않은 작업을 정리."""
    if j.status in ("queued", "running") and not runner.is_live(j.id):
        j.status, j.error = "error", "Interrupted — the server restarted while this request was running."
        db.commit()


@router.post("/jobs")
def create_job(body: JobIn, db: Session = Depends(get_db)):
    _agent_or_404(body.agent)
    try:
        jid = runner.submit(body.prompt, body.agent)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except AgentUnavailable as e:
        raise HTTPException(409, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e
    return _job_out(db.get(AgentJob, jid), since=0)


@router.get("/jobs")
def list_jobs(limit: int = 20, db: Session = Depends(get_db)):
    jobs = db.scalars(select(AgentJob).order_by(AgentJob.id.desc()).limit(max(1, min(limit, 100)))).all()
    for j in jobs:
        _settle(db, j)
    return [_job_out(j) for j in jobs]


@router.get("/jobs/{jid}")
def get_job(jid: int, since: int = 0, db: Session = Depends(get_db)):
    """since: 이미 받은 진행 기록 개수 — 그 뒤 것만 돌려줌 (화면이 1~2초마다 이어 받기)."""
    j = get_or_404(db, AgentJob, jid)
    _settle(db, j)
    return _job_out(j, since=max(0, since))


@router.post("/jobs/{jid}/cancel")
def cancel_job(jid: int, db: Session = Depends(get_db)):
    j = get_or_404(db, AgentJob, jid)
    if not runner.cancel(jid):
        raise HTTPException(409, "This request is not running.")
    return {"ok": True, "id": j.id}
