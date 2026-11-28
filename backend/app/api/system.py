from fastapi import APIRouter, HTTPException

from ..sysmon import db_detail, monitor

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/metrics")
def metrics(since: float = 0):
    """서버 자원·DB 표본 (5초 간격, 최근 1시간). since 이후 표본만."""
    return monitor.metrics(since)


@router.get("/db")
def database():
    try:
        return db_detail()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(503, f"Database is not reachable: {e}") from e
