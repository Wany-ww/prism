import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

from sqlalchemy import or_, select

from .capture.service import is_running, run_capture
from .config import SCHEDULER_WORKERS
from .db import SessionLocal
from .engine.flow import run_flow
from .models import Equipment, Flow

log = logging.getLogger("prism.scheduler")


class Scheduler:
    def __init__(self, workers: int = 4, tick: float = 3.0):
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="prism")
        self.tick = tick
        self._stop = threading.Event()
        self._flows_running: set[int] = set()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._loop, name="prism-scheduler", daemon=True)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self.pool.shutdown(wait=False, cancel_futures=True)

    def submit_capture(self, eq_id: int, trigger: str = "manual"):
        return self.pool.submit(run_capture, eq_id, trigger)

    def submit_flow(self, flow_id: int, trigger: str = "manual"):
        with self._lock:
            if flow_id in self._flows_running:
                return None
            self._flows_running.add(flow_id)

        def job():
            try:
                return run_flow(flow_id, trigger)
            finally:
                with self._lock:
                    self._flows_running.discard(flow_id)

        return self.pool.submit(job)

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
                if not is_running(eq.id):
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


scheduler = Scheduler(workers=SCHEDULER_WORKERS)
