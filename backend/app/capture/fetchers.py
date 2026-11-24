"""설비 로그 파일 탐색/가져오기.

경로 템플릿 예)
  log_path     = \\\\{ip}\\Log\\{date:%Y%m%d}          (날짜 폴더)
  file_pattern = Result_{date:%Y-%m-%d}*.csv          (날짜 포함 파일명)
사용 가능한 치환자: {ip} {name} {factory} {customer} {product} {project} {process} {date:<strftime>}
FS 방식은 디렉터리/파일명 모두 glob(*, ?, **) 사용 가능.

folder_mode = "date" 이면 log_path 를 상위 폴더로 보고 그 아래(최대 3단계) 날짜 폴더를 자동으로 찾는다.
  \\\\ip\\Log\\20261124, \\\\ip\\Log\\2026-11-24, \\\\ip\\Log\\261124, \\\\ip\\Log\\2026\\11\\24, \\\\ip\\Log\\2026-11\\24 …
"""

import fnmatch
import ftplib
import glob
import os
import posixpath
import re
import stat
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone


class CaptureError(Exception):
    pass


@dataclass
class RemoteFile:
    path: str
    size: int
    mtime: float


def template_vars(eq) -> dict:
    return {
        "ip": eq.ip or "",
        "name": eq.name or "",
        "factory": eq.factory or "",
        "customer": getattr(eq, "customer", "") or "",
        "product": eq.product or "",
        "project": eq.project or "",
        "process": eq.process or "",
    }


def render(tpl: str, eq, day: datetime) -> str:
    try:
        return tpl.format(date=day, **template_vars(eq))
    except (KeyError, IndexError, ValueError) as e:
        raise CaptureError(f"Path template error [{tpl}]: {e}") from e


def candidate_locations(eq, today: datetime | None = None) -> list[tuple[str, str]]:
    today = today or datetime.now()
    days = max(int(eq.lookback_days or 0), 0)
    seen, out = set(), []
    for i in range(days, -1, -1):
        d = today - timedelta(days=i)
        loc = (render(eq.log_path or "", eq, d), render(eq.file_pattern or "*", eq, d))
        if loc not in seen:
            seen.add(loc)
            out.append(loc)
    return out


DATE_FOLDER_DEPTH = 3


def day_keys(eq, today: datetime | None = None) -> dict[str, datetime]:
    """조회 일수 안의 날짜를 폴더명 숫자열(YYYYMMDD, YYMMDD) → 날짜 로 매핑."""
    today = today or datetime.now()
    keys: dict[str, datetime] = {}
    for i in range(max(int(eq.lookback_days or 0), 0) + 1):
        d = today - timedelta(days=i)
        keys.setdefault(d.strftime("%Y%m%d"), d)
        keys.setdefault(d.strftime("%y%m%d"), d)
    return keys


def find_date_folders(list_dirs, join, base: str, keys: dict[str, datetime], depth: int = DATE_FOLDER_DEPTH) -> list[tuple[str, datetime]]:
    """base 아래에서 경로상의 숫자를 이어 붙인 값이 날짜가 되는 폴더를 찾는다 (예: 2026/11/24 → 20261124).
    날짜가 될 수 없는 폴더는 내려가지 않으므로 큰 공유 폴더에서도 탐색량이 작다."""
    found: list[tuple[str, datetime]] = []

    def walk(path: str, digits: str, level: int):
        if level >= depth:
            return
        for name in sorted(list_dirs(path)):
            d = digits + re.sub(r"\D", "", name)
            if d == digits:
                continue
            child = join(path, name)
            if d in keys:
                found.append((child, keys[d]))
            elif any(k.startswith(d) for k in keys):
                walk(child, d, level + 1)

    walk(base, "", 0)
    return found


def resolve_locations(fetcher, eq) -> list[tuple[str, str]]:
    """설비 설정으로 실제 조회할 (폴더, 파일패턴) 목록."""
    if (getattr(eq, "folder_mode", "flat") or "flat") != "date":
        return candidate_locations(eq)
    today = datetime.now()
    base = render(eq.log_path or "", eq, today)
    folders = find_date_folders(fetcher.list_dirs, fetcher.join, base, day_keys(eq, today))
    return [(path, render(eq.file_pattern or "*", eq, day)) for path, day in sorted(folders, key=lambda x: x[1])]


class FsFetcher:
    join = staticmethod(os.path.join)

    def __init__(self, eq):
        self.eq = eq

    def list_dirs(self, directory: str) -> list[str]:
        try:
            with os.scandir(directory) as it:
                return [e.name for e in it if e.is_dir()]
        except OSError:
            return []

    def list(self, directory: str, pattern: str) -> list[RemoteFile]:
        out = []
        for p in glob.glob(os.path.join(directory, pattern), recursive=True):
            try:
                st = os.stat(p)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                out.append(RemoteFile(os.path.normpath(p), st.st_size, st.st_mtime))
        return out

    @contextmanager
    def local(self, rf: RemoteFile):
        yield rf.path

    def close(self):
        pass


def _temp_path(name: str) -> str:
    fd, tmp = tempfile.mkstemp(prefix="prism_", suffix="_" + os.path.basename(name))
    os.close(fd)
    return tmp


class FtpFetcher:
    def __init__(self, eq):
        self.eq = eq
        opts = eq.options or {}
        self.ftp = ftplib.FTP(encoding=opts.get("ftp_encoding", "utf-8"))
        try:
            self.ftp.connect(eq.ip, eq.port or 21, timeout=20)
            self.ftp.login(eq.username or "anonymous", eq.password or "")
            if opts.get("ftp_passive", True) is False:
                self.ftp.set_pasv(False)
        except (OSError, ftplib.Error) as e:
            raise CaptureError(f"FTP connection failed {eq.ip}: {e}") from e

    join = staticmethod(posixpath.join)

    def list_dirs(self, directory: str) -> list[str]:
        try:
            return [n for n, f in self.ftp.mlsd(directory, facts=["type"]) if f.get("type") == "dir"]
        except ftplib.error_perm:
            pass
        # MLSD 미지원 서버: 각 항목에 CWD 가 되는지로 폴더 판별
        try:
            names = [posixpath.basename(n) for n in self.ftp.nlst(directory)]
        except ftplib.error_perm:
            return []
        cur, out = self.ftp.pwd(), []
        for n in names:
            try:
                self.ftp.cwd(posixpath.join(directory, n))
                out.append(n)
            except ftplib.error_perm:
                pass
            finally:
                self.ftp.cwd(cur)
        return out

    def list(self, directory: str, pattern: str) -> list[RemoteFile]:
        out = []
        try:
            for name, facts in self.ftp.mlsd(directory, facts=["type", "size", "modify"]):
                if facts.get("type") == "file" and fnmatch.fnmatch(name, pattern):
                    mt = datetime.strptime(facts["modify"][:14], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()
                    out.append(RemoteFile(posixpath.join(directory, name), int(facts.get("size", 0)), mt))
            return out
        except ftplib.error_perm:
            pass
        try:
            names = self.ftp.nlst(directory)
        except ftplib.error_perm:
            return []
        for full in names:
            name = posixpath.basename(full)
            if not fnmatch.fnmatch(name, pattern):
                continue
            path = full if "/" in full else posixpath.join(directory, name)
            try:
                size = self.ftp.size(path) or 0
                resp = self.ftp.sendcmd(f"MDTM {path}")
                mt = datetime.strptime(resp[4:18], "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()
            except ftplib.Error:
                continue
            out.append(RemoteFile(path, size, mt))
        return out

    @contextmanager
    def local(self, rf: RemoteFile):
        tmp = _temp_path(rf.path)
        try:
            with open(tmp, "wb") as f:
                self.ftp.retrbinary(f"RETR {rf.path}", f.write)
            yield tmp
        finally:
            os.remove(tmp)

    def close(self):
        try:
            self.ftp.quit()
        except Exception:
            pass


class SftpFetcher:
    def __init__(self, eq):
        import paramiko

        self.client = paramiko.SSHClient()
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            self.client.connect(
                eq.ip, port=eq.port or 22, username=eq.username or None, password=eq.password or None, timeout=20
            )
            self.sftp = self.client.open_sftp()
        except Exception as e:
            raise CaptureError(f"SFTP connection failed {eq.ip}: {e}") from e

    join = staticmethod(posixpath.join)

    def list_dirs(self, directory: str) -> list[str]:
        try:
            return [a.filename for a in self.sftp.listdir_attr(directory) if stat.S_ISDIR(a.st_mode or 0)]
        except OSError:
            return []

    def list(self, directory: str, pattern: str) -> list[RemoteFile]:
        try:
            entries = self.sftp.listdir_attr(directory)
        except OSError:
            return []
        return [
            RemoteFile(posixpath.join(directory, a.filename), a.st_size or 0, float(a.st_mtime or 0))
            for a in entries
            if stat.S_ISREG(a.st_mode or 0) and fnmatch.fnmatch(a.filename, pattern)
        ]

    @contextmanager
    def local(self, rf: RemoteFile):
        tmp = _temp_path(rf.path)
        try:
            self.sftp.get(rf.path, tmp)
            yield tmp
        finally:
            os.remove(tmp)

    def close(self):
        self.client.close()


FETCHERS = {"fs": FsFetcher, "ftp": FtpFetcher, "sftp": SftpFetcher}


@contextmanager
def open_fetcher(eq):
    cls = FETCHERS.get(eq.access_method)
    if cls is None:
        raise CaptureError(f"The server can't fetch '{eq.access_method}' itself (with the agent method the agent pushes files).")
    f = cls(eq)
    try:
        yield f
    finally:
        f.close()


def discover(fetcher, eq) -> list[RemoteFile]:
    files: dict[str, RemoteFile] = {}
    for directory, pattern in resolve_locations(fetcher, eq):
        for rf in fetcher.list(directory, pattern):
            files[rf.path] = rf
    return sorted(files.values(), key=lambda r: (r.mtime, r.path))
