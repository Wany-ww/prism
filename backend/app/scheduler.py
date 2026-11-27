"""수집·Flow 스케줄러.

무거운 작업(파싱, Match, 데이터셋 저장, 미리보기)은 API 와 다른 프로세스 풀에서 실행한다.
같은 프로세스의 스레드로 돌리면 파이썬 GIL 때문에 작업 중에는 화면 API 응답까지 느려지기 때문.
같은 설비/Flow 는 대기 중이든 실행 중이든 한 번만 큐에 들어간다.
"""

import logging
import multiprocessing as mp
import threading
from concurrent.futures import Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from datetime import datetime, timedelta

from sqlalchemy import or_, select

from .capture.service import ingest_uploaded, is_running, run_capture
from .config import CAPTURE_WORKERS, FLOW_WORKERS
from .db import SessionLocal
from .engine.flow import preview_job, run_flow
from .models import Equipment, Flow

log = logging.getLogger("prism.scheduler")


def _warm():
    return True


class _Pool:
    """죽은 작업 프로세스가 생기면(예: 메모리 부족) 풀을 새로 만드는 ProcessPoolExecutor 래퍼."""

    def __init__(self, name: str, workers: int):
        self.name, self.workers = name, max(1, workers)
        self._pool: ProcessPoolExecutor | None = None
        self._lock = threading.Lock()

    def _get(self) -> ProcessPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = ProcessPoolExecutor(
                    max_workers=self.workers, mp_context=mp.get_context("spawn"), max_tasks_per_child=100
                )
            return self._pool

    def reset(self):
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)

    def submit(self, fn, *args) -> Future:
        try:
            return self._get().submit(fn, *args)
        except BrokenProcessPool:
            log.warning("%s pool broken, restarting", self.name)
            self.reset()
            return self._get().submit(fn, *args)

    def warm(self):
        for _ in range(self.workers):
            self.submit(_warm)

    def shutdown(self):
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


def _result(pool: _Pool, fut: Future, what: str):
    try:
        return fut.result()
    except BrokenProcessPool:
        pool.reset()
        msg = f"The worker process for {what} stopped unexpectedly (out of memory?)."
        return {"status": "error", "message": msg, "error": msg}
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        return {"status": "error", "message": msg, "error": msg}


class Scheduler:
    def __init__(self, capture_workers: int = 4, flow_workers: int = 2, tick: float = 3.0):
        self.captures = _Pool("capture", capture_workers)
        self.flows = _Pool("flow", flow_workers)
        self.tick = tick
        self._stop = threading.Event()
        self._eq_busy: dict[int, Future] = {}
        self._flow_busy: dict[int, Future] = {}
        self._ingesting: dict[int, int] = {}
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, name="prism-scheduler", daemon=True)

    def start(self):
        self.captures.warm()
        self.flows.warm()
        self._thread.start()

    def stop(self):
        self._stop.set()
        self.captures.shutdown()
        self.flows.shutdown()

    # ---------- 수집 ----------

    def is_capturing(self, eq_id: int) -> bool:
        with self._lock:
            return eq_id in self._eq_busy or self._ingesting.get(eq_id, 0) > 0 or is_running(eq_id)

    def submit_capture(self, eq_id: int, trigger: str = "manual") -> Future | None:
        """이미 대기/실행 중이면 None."""
        with self._lock:
            if eq_id in self._eq_busy:
                return None
            fut = self.captures.submit(run_capture, eq_id, trigger)
            self._eq_busy[eq_id] = fut

        def done(_):
            with self._lock:
                if self._eq_busy.get(eq_id) is fut:
                    self._eq_busy.pop(eq_id)

        fut.add_done_callback(done)
        return fut

    def run_capture_wait(self, eq_id: int, trigger: str = "manual") -> dict:
        fut = self.submit_capture(eq_id, trigger)
        if fut is None:
            return {"status": "busy", "message": "Already capturing."}
        return _result(self.captures, fut, "capture")

    def ingest(self, eq_id: int, local_path: str, source_path: str, size: int, mtime: float) -> dict:
        """Agent 업로드 파일 처리 (작업 프로세스에서 파싱)."""
        with self._lock:
            self._ingesting[eq_id] = self._ingesting.get(eq_id, 0) + 1
        try:
            return _result(self.captures, self.captures.submit(ingest_uploaded, eq_id, local_path, source_path, size, mtime), "capture")
        finally:
            with self._lock:
                self._ingesting[eq_id] -= 1

    # ---------- Flow ----------

    def flow_running(self, flow_id: int) -> bool:
        with self._lock:
            return flow_id in self._flow_busy

    def submit_flow(self, flow_id: int, trigger: str = "manual") -> Future | None:
        with self._lock:
            if flow_id in self._flow_busy:
                return None
            fut = self.flows.submit(run_flow, flow_id, trigger)
            self._flow_busy[flow_id] = fut

        def done(_):
            with self._lock:
                if self._flow_busy.get(flow_id) is fut:
                    self._flow_busy.pop(flow_id)

        fut.add_done_callback(done)
        return fut

    def run_flow_wait(self, flow_id: int, trigger: str = "manual") -> dict:
        fut = self.submit_flow(flow_id, trigger)
        if fut is None:
            return {"status": "error", "error": "This flow is already running. Try again when it finishes.", "nodes": {}}
        return _result(self.flows, fut, "flow")

    def preview(self, graph: dict, target: str, limit: int) -> dict:
        res = _result(self.flows, self.flows.submit(preview_job, graph, target, limit), "preview")
        if res.get("status") == "error" and "nodes" not in res:
            return {"nodes": {target: {"status": "error", "error": res.get("message")}}}
        return res

    # ---------- 주기 실행 ----------

    def _loop(self):
        while not self._stop.wait(self.tick):
            try:
                self._dispatch()
            except Exception:
                log.exception("scheduler tick failed")

    def _dispatch(self):
        now = datetime.now()
        with SessionLocal() as db:
            due = db.scalars(
                select(Equipment).where(
                    Equipment.enabled.is_(True),
                    Equipment.access_method != "agent",
                    Equipment.parser_id.is_not(None),
                    or_(Equipment.next_capture_at.is_(None), Equipment.next_capture_at <= now),
                )
            ).all()
            for eq in due:
                eq.next_capture_at = now + timedelta(seconds=max(eq.capture_interval_sec or 60, 10))
                self.submit_capture(eq.id, "schedule")
            flows = db.scalars(
                select(Flow).where(
                    Flow.schedule_minutes > 0,
                    or_(Flow.next_run_at.is_(None), Flow.next_run_at <= now),
                )
            ).all()
            for f in flows:
                f.next_run_at = now + timedelta(minutes=f.schedule_minutes)
                self.submit_flow(f.id, "schedule")
            db.commit()


scheduler = Scheduler(capture_workers=CAPTURE_WORKERS, flow_workers=FLOW_WORKERS)
