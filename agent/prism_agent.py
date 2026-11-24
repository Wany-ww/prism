"""PRISM 수집 에이전트 (별도 LAN 설비용, Python 3.8+ 표준 라이브러리만 사용).

서버가 직접 접근할 수 없는 설비(대표 설비 PC / 작업 PC 뒤 별도 LAN)의 로그를
게이트웨이 PC에서 찾아 서버로 업로드한다. 경로/패턴/주기는 서버 GUI 설정을 그대로 받아 쓴다.

사용 예)
  python prism_agent.py --server http://10.0.0.5:8000 --equipment "Blade 조립기 #2" --equipment "Blade 조립기 #3"
  python prism_agent.py --server http://10.0.0.5:8000 --equipment "EOL 설비 #1" --once
옵션: --token (서버 PRISM_AGENT_TOKEN 설정 시)
"""

import argparse
import glob
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import uuid


def http_json(url, token, data=None, headers=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={**(headers or {}), **({"X-Agent-Token": token} if token else {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def upload(server, token, equipment, path, st):
    boundary = uuid.uuid4().hex
    fields = {"equipment": equipment, "path": path, "size": str(st.st_size), "mtime": repr(st.st_mtime)}
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode("utf-8"))
    with open(path, "rb") as f:
        content = f.read()
    fname = os.path.basename(path).replace('"', "_")
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n".encode("utf-8") + content + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return http_json(
        f"{server}/api/agent/upload", token, b"".join(parts), {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=300
    )


def date_folder_locations(spec):
    """서버와 같은 규칙: 상위 폴더 아래 경로 숫자를 이어 붙인 값이 날짜(YYYYMMDD/YYMMDD)인 폴더."""
    keys, out = spec["keys"], []

    def walk(path, digits, level):
        if level >= spec.get("depth", 3):
            return
        try:
            names = sorted(e.name for e in os.scandir(path) if e.is_dir())
        except OSError:
            return
        for name in names:
            d = digits + re.sub(r"\D", "", name)
            if d == digits:
                continue
            child = os.path.join(path, name)
            if d in keys:
                out.append({"dir": child, "pattern": keys[d]})
            elif any(k.startswith(d) for k in keys):
                walk(child, d, level + 1)

    walk(spec["base"], "", 0)
    return out


def sync(server, token, equipment, log):
    cfg = http_json(f"{server}/api/agent/config?" + urllib.parse.urlencode({"equipment": equipment}), token)
    if not cfg.get("enabled", True):
        return cfg.get("interval_sec", 300)
    known = cfg.get("known", {})
    files = {}
    locations = cfg["locations"] + (date_folder_locations(cfg["date_folders"]) if cfg.get("date_folders") else [])
    for loc in locations:
        for p in glob.glob(os.path.join(loc["dir"], loc["pattern"]), recursive=True):
            if os.path.isfile(p):
                files[os.path.normpath(p)] = os.stat(p)
    sent = 0
    for path, st in sorted(files.items(), key=lambda kv: kv[1].st_mtime):
        k = known.get(path)
        if k and k[0] == st.st_size and abs(k[1] - st.st_mtime) < 1e-3 and k[2] == cfg.get("parser_hash"):
            continue
        try:
            r = upload(server, token, equipment, path, st)
            sent += 1
            log(f"[{equipment}] {path} -> {r.get('status')} {r.get('rows', r.get('message', ''))}")
        except Exception as e:  # 다음 주기에 재시도
            log(f"[{equipment}] {path} 업로드 실패: {e}")
    log(f"[{equipment}] 파일 {len(files)}개 확인, {sent}개 전송")
    return cfg.get("interval_sec", 300)


def main():
    ap = argparse.ArgumentParser(description="PRISM log agent")
    ap.add_argument("--server", required=True, help="예) http://10.0.0.5:8000")
    ap.add_argument("--equipment", action="append", required=True, help="서버에 등록된 설비명 (여러 번 지정 가능)")
    ap.add_argument("--token", default=os.environ.get("PRISM_AGENT_TOKEN", ""))
    ap.add_argument("--once", action="store_true", help="한 번만 동기화하고 종료")
    a = ap.parse_args()
    server = a.server.rstrip("/")

    def log(msg):
        print(time.strftime("%Y-%m-%d %H:%M:%S"), msg, flush=True)

    while True:
        wait = 300
        for eq in a.equipment:
            try:
                wait = min(wait, sync(server, a.token, eq, log))
            except Exception as e:
                log(f"[{eq}] 서버 통신 실패: {e}")
                wait = min(wait, 60)
        if a.once:
            return 0
        time.sleep(max(wait, 10))


if __name__ == "__main__":
    sys.exit(main())
