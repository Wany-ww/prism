"""System 모니터: 서버 자원(CPU·메모리·네트워크·디스크)과 DB 상태를 5초마다 모아 최근 1시간을 메모리에 보관.

외부 패키지(psutil 등) 없이 Windows API(ctypes)와 DB 통계 뷰만 쓴다 — 폐쇄망 번들에서도 그대로 동작.
Windows 가 아니면 자원 값은 비어 있고 DB 값만 채워진다.
"""

import ctypes
import logging
import os
import platform
import shutil
import socket
import sys
import threading
import time
from collections import deque
from ctypes import wintypes

from sqlalchemy import text

from .config import DATA_DIR, DATABASE_URL, ROOT_DIR
from .db import engine

log = logging.getLogger("prism.sysmon")

INTERVAL = 5  # 초
KEEP = 720  # 1시간
DIR_EVERY = 60  # 폴더 용량은 1분마다 (파일이 많으면 느림)
IS_WIN = sys.platform == "win32"
IS_PG = not DATABASE_URL.startswith("sqlite")


# ---------- Windows API ----------

if IS_WIN:
    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _iphlp = ctypes.WinDLL("iphlpapi")

    class _FT(ctypes.Structure):
        _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]

        def v(self) -> int:
            return (self.hi << 32) | self.lo

    class _MEM(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    class _PE(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    class _PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (n, ctypes.c_size_t)
            for n in (
                "PeakWorkingSetSize",
                "WorkingSetSize",
                "QuotaPeakPagedPoolUsage",
                "QuotaPagedPoolUsage",
                "QuotaPeakNonPagedPoolUsage",
                "QuotaNonPagedPoolUsage",
                "PagefileUsage",
                "PeakPagefileUsage",
            )
        ]

    class _IFROW(ctypes.Structure):
        _fields_ = (
            [("wszName", ctypes.c_wchar * 256)]
            + [(n, wintypes.DWORD) for n in ("dwIndex", "dwType", "dwMtu", "dwSpeed", "dwPhysAddrLen")]
            + [("bPhysAddr", ctypes.c_ubyte * 8)]
            + [
                (n, wintypes.DWORD)
                for n in (
                    "dwAdminStatus", "dwOperStatus", "dwLastChange", "dwInOctets", "dwInUcastPkts", "dwInNUcastPkts",
                    "dwInDiscards", "dwInErrors", "dwInUnknownProtos", "dwOutOctets", "dwOutUcastPkts", "dwOutNUcastPkts",
                    "dwOutDiscards", "dwOutErrors", "dwOutQLen", "dwDescrLen",
                )
            ]
            + [("bDescr", ctypes.c_ubyte * 256)]
        )

    _k32.OpenProcess.restype = wintypes.HANDLE
    _k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    _k32.GetTickCount64.restype = ctypes.c_ulonglong
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]
    _k32.Process32FirstW.argtypes = _k32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    _k32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.c_void_p] * 4
    _k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]


def _sys_times():
    idle, kern, user = _FT(), _FT(), _FT()
    _k32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    return idle.v(), kern.v() + user.v()  # 커널 시간에 idle 이 포함됨


def _memory():
    m = _MEM()
    m.dwLength = ctypes.sizeof(_MEM)
    _k32.GlobalMemoryStatusEx(ctypes.byref(m))
    return m.ullTotalPhys, m.ullTotalPhys - m.ullAvailPhys


def _processes() -> list[tuple[int, int, str]]:
    """(pid, 부모 pid, 실행 파일 이름)"""
    snap = _k32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == wintypes.HANDLE(-1).value:
        return []
    out = []
    try:
        e = _PE()
        e.dwSize = ctypes.sizeof(_PE)
        ok = _k32.Process32FirstW(snap, ctypes.byref(e))
        while ok:
            out.append((e.th32ProcessID, e.th32ParentProcessID, e.szExeFile.lower()))
            ok = _k32.Process32NextW(snap, ctypes.byref(e))
    finally:
        _k32.CloseHandle(snap)
    return out


def _proc_stat(pid: int) -> tuple[int, int] | None:
    """(누적 CPU 시간 100ns, 메모리 working set 바이트)"""
    h = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        c, x, k, u = _FT(), _FT(), _FT(), _FT()
        if not _k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(x), ctypes.byref(k), ctypes.byref(u)):
            return None
        pmc = _PMC()
        pmc.cb = ctypes.sizeof(_PMC)
        _k32.K32GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
        return k.v() + u.v(), pmc.WorkingSetSize
    finally:
        _k32.CloseHandle(h)


def _net_octets() -> tuple[int, int]:
    """실제 네트워크 카드(이더넷·Wi-Fi)의 누적 수신/송신 바이트. 같은 카드가 필터 계층마다 여러 번 보이므로 MAC 으로 합침."""
    size = wintypes.ULONG(0)
    _iphlp.GetIfTable(None, ctypes.byref(size), False)
    buf = ctypes.create_string_buffer(size.value)
    if _iphlp.GetIfTable(buf, ctypes.byref(size), False) != 0:
        return 0, 0
    n = ctypes.c_uint32.from_buffer(buf).value
    rows = (_IFROW * n).from_buffer(buf, 4)
    best: dict[bytes, tuple[int, int]] = {}
    for r in rows:
        if r.dwType not in (6, 71) or r.dwOperStatus < 4 or not r.dwPhysAddrLen:  # 6 이더넷, 71 Wi-Fi / 연결됨
            continue
        mac = bytes(r.bPhysAddr[: r.dwPhysAddrLen])
        cur = best.get(mac, (0, 0))
        best[mac] = (max(cur[0], r.dwInOctets), max(cur[1], r.dwOutOctets))
    return sum(v[0] for v in best.values()), sum(v[1] for v in best.values())


# ---------- 폴더 용량 ----------


def _dir_size(path) -> tuple[int, int]:
    total = files = 0
    stack = [str(path)]
    while stack:
        p = stack.pop()
        try:
            with os.scandir(p) as it:
                for e in it:
                    try:
                        if e.is_dir(follow_symlinks=False):
                            stack.append(e.path)
                        else:
                            total += e.stat(follow_symlinks=False).st_size
                            files += 1
                    except OSError:
                        pass
        except OSError:
            pass
    return total, files


DIRS = [
    ("Records", "records", "수집한 설비 기록"),
    ("Datasets", "datasets", "Flow 결과 데이터셋"),
    ("PostgreSQL", "postgres", "DB 데이터 파일"),
    ("Staging", "staging", "업로드 대기 파일"),
    ("AI Agent", "agent", "에이전트 작업 폴더"),
]


# ---------- 수집기 ----------


class Monitor:
    def __init__(self):
        self.samples: deque[dict] = deque(maxlen=KEEP)
        self.dirs: list[dict] = []
        self.dirs_at = 0.0
        self.procs: list[dict] = []
        self.started_at = time.time()
        self._prev: dict = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._loop, name="sysmon", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            t0 = time.time()
            try:
                self._sample()
            except Exception:  # noqa: BLE001 — 모니터 오류가 서버를 멈추면 안 됨
                log.exception("system sample failed")
            if t0 - self.dirs_at >= DIR_EVERY:
                try:
                    self._scan_dirs()
                except Exception:  # noqa: BLE001
                    log.exception("dir scan failed")
                self.dirs_at = t0
            self._stop.wait(max(0.5, INTERVAL - (time.time() - t0)))

    def _rate(self, key: str, value: float, now: float, wrap: int = 0) -> float | None:
        """누적값 → 초당 값 (첫 표본은 None)"""
        prev = self._prev.get(key)
        self._prev[key] = (value, now)
        if not prev or now <= prev[1]:
            return None
        d = value - prev[0]
        if d < 0:
            if not wrap:
                return None
            d += wrap
        return d / (now - prev[1])

    def _sample(self):
        now = time.time()
        s: dict = {"t": round(now, 1)}
        if IS_WIN:
            idle, total = _sys_times()
            pi, pt = self._prev.get("sys", (None, None))
            self._prev["sys"] = (idle, total)
            if pi is not None and total > pt:
                s["cpu"] = round(max(0.0, 100.0 * (1 - (idle - pi) / (total - pt))), 1)
            mt, mu = _memory()
            s["mem_total"], s["mem_used"] = mt, mu
            ncpu = os.cpu_count() or 1
            procs = _processes()
            children: dict[int, list[int]] = {}
            for pid, ppid, _ in procs:
                children.setdefault(ppid, []).append(pid)
            mine, stack = set(), [os.getpid()]
            while stack:  # 이 서버와 그 자식(수집·Flow 작업, AI 에이전트)
                p = stack.pop()
                if p in mine:
                    continue
                mine.add(p)
                stack.extend(children.get(p, []))
            groups = {"prism": [p for p in mine], "pg": [pid for pid, _, exe in procs if exe == "postgres.exe" and pid not in mine]}
            plist = []
            for g, pids in groups.items():
                cpu_t = rss = 0
                for pid in pids:
                    st = _proc_stat(pid)
                    if st:
                        cpu_t += st[0]
                        rss += st[1]
                # 프로세스가 끝나면 누적값이 줄어드므로 0 아래는 버림 (_rate 가 None)
                r = self._rate(f"cpu_{g}", cpu_t / 1e7, now)
                if r is not None:
                    s[f"{g}_cpu"] = round(min(100.0, 100.0 * r / ncpu), 1)
                s[f"{g}_rss"] = rss
                plist.append({"group": g, "count": len(pids), "rss": rss, "cpu": s.get(f"{g}_cpu")})
            self.procs = plist
            rx, tx = _net_octets()
            for k, v in (("net_rx", rx), ("net_tx", tx)):
                r = self._rate(k, v, now, wrap=2**32)
                if r is not None:
                    s[k] = round(r)
            du = shutil.disk_usage(DATA_DIR if DATA_DIR.exists() else ROOT_DIR)
            s["disk_total"], s["disk_used"] = du.total, du.used
        self._db_sample(s, now)
        with self._lock:
            self.samples.append(s)

    def _db_sample(self, s: dict, now: float):
        try:
            with engine.connect() as c:
                t0 = time.perf_counter()
                c.execute(text("SELECT 1")).scalar()
                s["db_ping_ms"] = round((time.perf_counter() - t0) * 1000, 2)
                if IS_PG:
                    r = c.execute(
                        text(
                            "SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_inserted, tup_updated, tup_deleted, tup_fetched,"
                            " pg_database_size(current_database()) FROM pg_stat_database WHERE datname = current_database()"
                        )
                    ).one()
                    st = dict(
                        c.execute(
                            text("SELECT coalesce(state, 'other'), count(*) FROM pg_stat_activity WHERE datname = current_database() GROUP BY 1")
                        ).all()
                    )
                    s["db_conns"] = sum(st.values())
                    s["db_active"] = st.get("active", 0)
                    s["db_idle_tx"] = st.get("idle in transaction", 0)
                    s["db_size"] = r[8]
                    for k, v in (("db_commit", r[0]), ("db_rollback", r[1]), ("db_ins", r[4]), ("db_upd", r[5]), ("db_del", r[6]), ("db_fetch", r[7])):
                        x = self._rate(k, v, now)
                        if x is not None:
                            s[k] = round(x, 1)
                    br, bh = self._rate("blks_read", r[2], now), self._rate("blks_hit", r[3], now)
                    if br is not None and bh is not None and br + bh > 0:
                        s["db_hit"] = round(100.0 * bh / (br + bh), 2)
                else:
                    path = DATABASE_URL.split("///", 1)[-1]
                    s["db_size"] = os.path.getsize(path) if os.path.exists(path) else 0
        except Exception as e:  # noqa: BLE001
            s["db_error"] = str(e)[:200]

    def _scan_dirs(self):
        out = []
        for label, sub, desc in DIRS:
            p = DATA_DIR / sub
            if not p.exists():
                continue
            size, files = _dir_size(p)
            out.append({"name": label, "path": str(p.relative_to(ROOT_DIR)) if p.is_relative_to(ROOT_DIR) else str(p), "desc": desc, "bytes": size, "files": files})
        self.dirs = out

    # ---------- 조회 ----------

    def metrics(self, since: float = 0) -> dict:
        with self._lock:
            samples = [x for x in self.samples if x["t"] > since]
        return {
            "interval": INTERVAL,
            "samples": samples,
            "procs": self.procs,
            "dirs": self.dirs,
            "info": self.info(),
        }

    def info(self) -> dict:
        d = {
            "host": socket.gethostname(),
            "os": _os_name(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(),
            "server_started": self.started_at,
            "db_kind": "PostgreSQL" if IS_PG else "SQLite",
            "data_dir": str(DATA_DIR),
        }
        if IS_WIN:
            d["boot_time"] = time.time() - _k32.GetTickCount64() / 1000
        return d


def _os_name() -> str:
    if IS_WIN:
        ver = platform.version()  # 10.0.<build>; Windows 11 도 release 가 '10' 으로 나옴
        build = int(ver.rsplit(".", 1)[-1]) if ver.rsplit(".", 1)[-1].isdigit() else 0
        return f"Windows {'11' if build >= 22000 else platform.release()} (build {build})"
    return f"{platform.system()} {platform.release()}"


monitor = Monitor()


def db_detail() -> dict:
    """DB 화면용 상세 (요청할 때만): 버전, 시작 시각, 설정, 테이블 크기, 현재 연결."""
    out: dict = {"kind": "PostgreSQL" if IS_PG else "SQLite"}
    with engine.connect() as c:
        if IS_PG:
            out["version"] = c.execute(text("SHOW server_version")).scalar()
            out["started"] = c.execute(text("SELECT extract(epoch FROM pg_postmaster_start_time())")).scalar()
            out["database"] = c.execute(text("SELECT current_database()")).scalar()
            out["size"] = c.execute(text("SELECT pg_database_size(current_database())")).scalar()
            out["settings"] = [
                {"name": n, "value": v, "unit": u or ""}
                for n, v, u in c.execute(
                    text(
                        "SELECT name, setting, unit FROM pg_settings WHERE name IN ('max_connections','shared_buffers','work_mem',"
                        "'effective_cache_size','port','listen_addresses','max_wal_size','autovacuum') ORDER BY name"
                    )
                ).all()
            ]
            r = c.execute(
                text(
                    "SELECT xact_commit, xact_rollback, blks_read, blks_hit, deadlocks, temp_bytes, conflicts"
                    " FROM pg_stat_database WHERE datname = current_database()"
                )
            ).one()
            out["totals"] = {
                "commits": r[0],
                "rollbacks": r[1],
                "cache_hit": round(100.0 * r[3] / (r[2] + r[3]), 2) if (r[2] + r[3]) else None,
                "deadlocks": r[4],
                "temp_bytes": r[5],
            }
            out["tables"] = [
                {"name": n, "rows": int(rows or 0), "total": int(t or 0), "data": int(d or 0), "index": int(i or 0), "seq_scan": int(sq or 0), "idx_scan": int(ix or 0),
                 "last_vacuum": float(lv) if lv is not None else None, "dead_rows": int(dead or 0)}
                for n, rows, t, d, i, sq, ix, lv, dead in c.execute(
                    text(
                        "SELECT relname, n_live_tup, pg_total_relation_size(relid), pg_relation_size(relid), pg_indexes_size(relid),"
                        " seq_scan, idx_scan, extract(epoch FROM greatest(last_vacuum, last_autovacuum)), n_dead_tup"
                        " FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC"
                    )
                ).all()
            ]
            for t in out["tables"]:
                if t["total"] < 64 * 1024 * 1024:  # 작은 테이블은 통계 추정값 대신 정확한 행 수 (통계는 ANALYZE 전까지 0)
                    t["rows"] = int(c.execute(text(f'SELECT count(*) FROM "{t["name"]}"')).scalar() or 0)
            out["connections"] = [
                {"pid": p, "app": a or "", "client": cl or "local", "state": st or "", "since": float(since) if since is not None else None, "wait": w or "", "query": (q or "")[:300]}
                for p, a, cl, st, since, w, q in c.execute(
                    text(
                        "SELECT pid, application_name, host(client_addr), state, extract(epoch FROM coalesce(query_start, backend_start)),"
                        " wait_event_type, query FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
                        " ORDER BY state, query_start"
                    )
                ).all()
            ]
        else:
            path = DATABASE_URL.split("///", 1)[-1]
            out["version"] = c.execute(text("SELECT sqlite_version()")).scalar()
            out["size"] = os.path.getsize(path) if os.path.exists(path) else 0
            names = [r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).all()]
            out["tables"] = [{"name": n, "rows": c.execute(text(f'SELECT count(*) FROM "{n}"')).scalar()} for n in names]
            out["settings"], out["connections"] = [], []
    return out
