"""AI Agent: 자연어 요청 → Match/Analysis Flow·대시보드 생성.

지금은 이 서버 PC 에 로그인된 Claude Code CLI 를 임시 에이전트로 쓴다. 요청마다 작업 폴더를 만들고 거기에
prism-builder 스킬(.claude/skills/prism-builder)을 복사한 뒤 `claude -p` 를 실행한다. 에이전트는 스킬의
helper(scripts/prism.py)로 PRISM API 만 호출할 수 있고 (Bash 는 그 명령만 허용), 파일 쓰기는 작업 폴더 안으로 제한된다.

나중에는 서버에서 내려받는 전용 에이전트(PRISM AI Agent)로 바꾼다 — AGENTS 목록과 화면은 그 흐름(다운로드 → 실행 →
실행 확인 → 프롬프트 전달)에 맞춰져 있고, 전용 에이전트 쪽은 아직 배포 서버가 없어 '준비 중'으로 표시된다.
"""

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

from .config import AGENT_DIR, AI_API_URL, AI_CLAUDE_BIN, AI_MODEL, AI_TIMEOUT_MIN, ROOT_DIR
from .db import SessionLocal
from .models import AgentJob, Dashboard, Flow

log = logging.getLogger("prism.ai")

SKILL = "prism-builder"
SKILL_SRC = ROOT_DIR / ".claude" / "skills" / SKILL
HELPER = f".claude/skills/{SKILL}/scripts/prism.py"
MAX_EVENTS = 400

AGENTS = [
    {
        "id": "claude-code",
        "name": "Claude Code",
        "vendor": "Anthropic",
        "kind": "local-cli",
        "temporary": True,
        "description": "이 서버 PC 에 로그인된 Claude Code CLI 를 사용합니다 (임시).",
    },
    {
        "id": "prism-agent",
        "name": "PRISM AI Agent",
        "vendor": "PRISM",
        "kind": "download",
        "temporary": False,
        "description": "서버에서 내려받아 실행하는 전용 에이전트입니다. 배포 서버 준비 중.",
    },
]

# 에이전트 프로세스에 넘기지 않는 환경변수 (DB·Neo4j 비밀번호 등)
_SECRET_ENV = ("PRISM_DATABASE_URL", "PRISM_PG_ADMIN_PASSWORD", "PRISM_NEO4J_PASSWORD", "PRISM_AGENT_TOKEN", "PRISM_ALERT_WEBHOOK")


class AgentUnavailable(Exception):
    pass


def claude_bin() -> str | None:
    return AI_CLAUDE_BIN or shutil.which("claude")


_version_cache: dict = {"t": 0.0, "v": None, "err": ""}


def claude_version(force: bool = False) -> tuple[str | None, str]:
    """(버전, 오류). 60초 캐시."""
    if not force and time.time() - _version_cache["t"] < 60:
        return _version_cache["v"], _version_cache["err"]
    path, ver, err = claude_bin(), None, ""
    if not path:
        err = "Claude Code CLI (claude) was not found on this server's PATH."
    else:
        try:
            r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=30, **_no_window())
            ver = (r.stdout or "").strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else None
            if not ver:
                err = (r.stderr or r.stdout or f"exit code {r.returncode}").strip()[:300]
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {e}"
    _version_cache.update(t=time.time(), v=ver, err=err)
    return ver, err


def _no_window() -> dict:
    return {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


def _summarize_tool(name: str, inp: dict) -> str:
    if name == "Bash":
        cmd = str(inp.get("command") or "")
        cmd = cmd.replace(f"python {HELPER}", "prism").replace(HELPER, "prism")
        return f"$ {cmd[:240]}"
    if name == "Skill":
        return f"Using skill {inp.get('skill') or inp.get('name') or ''}".strip()
    if name in ("Write", "Edit", "Read"):
        return f"{name} {os.path.basename(str(inp.get('file_path') or ''))}"
    return name


def _tool_result_text(c: dict) -> str:
    content = c.get("content")
    if isinstance(content, list):
        content = "\n".join(str(x.get("text", "")) for x in content if isinstance(x, dict))
    return str(content or "")


class Runner:
    def __init__(self):
        self._lock = threading.Lock()
        self.job_id: int | None = None
        self.proc: subprocess.Popen | None = None
        self.cancelled = False
        self.started: set[str] = set()  # '실행'된 에이전트

    # ---------- 에이전트 상태 ----------

    def agents(self) -> list[dict]:
        out = []
        for a in AGENTS:
            d = dict(a)
            if a["id"] == "claude-code":
                ver, err = claude_version()
                d.update(installed=bool(ver), version=ver, path=claude_bin(), downloadable=False, available=True, error=err)
            else:
                d.update(installed=False, version=None, path=None, downloadable=True, available=False, error="")
            d["started"] = d["installed"] and a["id"] in self.started
            d["busy"] = self.job_id is not None and d["started"]
            out.append(d)
        return out

    def agent(self, agent_id: str) -> dict:
        for a in self.agents():
            if a["id"] == agent_id:
                return a
        raise KeyError(agent_id)

    def start_agent(self, agent_id: str) -> dict:
        a = self.agent(agent_id)
        if not a["installed"]:
            raise AgentUnavailable(f"{a['name']} is not installed on this server.")
        ver, err = claude_version(force=True)
        if not ver:
            raise AgentUnavailable(err)
        self.started.add(agent_id)
        return self.agent(agent_id)

    def stop_agent(self, agent_id: str) -> dict:
        self.started.discard(agent_id)
        return self.agent(agent_id)

    def check(self, agent_id: str) -> dict:
        a = self.agent(agent_id)
        if agent_id == "claude-code":
            ver, err = claude_version(force=True)
            a = self.agent(agent_id)
            return {"ok": bool(ver) and a["started"], "installed": bool(ver), "started": a["started"], "version": ver, "message": err or ("Ready" if a["started"] else "Installed — start it to use")}
        return {"ok": False, "installed": a["installed"], "started": False, "version": None, "message": "Not installed"}

    # ---------- 작업 ----------

    def submit(self, prompt: str, agent_id: str = "claude-code") -> int:
        prompt = prompt.strip()
        if not prompt:
            raise ValueError("Enter a request.")
        a = self.agent(agent_id)
        if not a["started"]:
            raise AgentUnavailable(f"Start {a['name']} first.")
        with self._lock:
            if self.job_id is not None:
                raise RuntimeError("The agent is already working on another request. Wait for it or cancel it.")
            with SessionLocal() as db:
                job = AgentJob(agent=agent_id, prompt=prompt, status="running", events=[], result={})
                db.add(job)
                db.commit()
                self.job_id = job.id
            self.cancelled = False
        threading.Thread(target=self._run, args=(self.job_id, prompt), daemon=True, name=f"ai-job-{self.job_id}").start()
        return self.job_id

    def cancel(self, job_id: int) -> bool:
        if self.job_id != job_id or self.proc is None:
            return False
        self.cancelled = True
        _kill_tree(self.proc)
        return True

    def is_live(self, job_id: int) -> bool:
        return self.job_id == job_id

    def _run(self, job_id: int, prompt: str):
        events: list[dict] = []
        result: dict = {}
        stderr_tail: list[str] = []
        status, error = "error", ""
        last_flush = 0.0

        def add(kind: str, text: str, **extra):
            events.append({"t": datetime.now().isoformat(timespec="seconds"), "kind": kind, "text": text[:4000], **extra})
            del events[:-MAX_EVENTS]

        def flush(force=False):
            nonlocal last_flush
            if not force and time.time() - last_flush < 1.0:
                return
            last_flush = time.time()
            with SessionLocal() as db:
                j = db.get(AgentJob, job_id)
                j.events = list(events)
                db.commit()

        try:
            path = claude_bin()
            if not path:
                raise AgentUnavailable("Claude Code CLI (claude) was not found.")
            if not SKILL_SRC.exists():
                raise AgentUnavailable(f"Skill folder is missing: {SKILL_SRC}")
            work = AGENT_DIR / "jobs" / str(job_id)
            shutil.rmtree(work, ignore_errors=True)
            shutil.copytree(SKILL_SRC, work / ".claude" / "skills" / SKILL)

            env = {k: v for k, v in os.environ.items() if k not in _SECRET_ENV}
            env.update(
                PATH=os.path.dirname(sys.executable) + os.pathsep + env.get("PATH", ""),  # python = 백엔드의 python
                PRISM_API=AI_API_URL,
                PYTHONIOENCODING="utf-8",
                PYTHONUTF8="1",
                MSYS_NO_PATHCONV="1",
            )
            cmd = [
                path, "-p",
                "--output-format", "stream-json", "--verbose",
                "--no-session-persistence",
                "--permission-mode", "acceptEdits",
                "--strict-mcp-config",
                "--setting-sources", "project",
                "--tools", "Bash,Read,Write,Edit,Glob,Grep,Skill",
                "--allowedTools", f"Bash(python {HELPER}:*)", f"Skill({SKILL})", "Read", "Write", "Edit", "Glob", "Grep",
            ]  # fmt: skip
            if AI_MODEL:
                cmd += ["--model", AI_MODEL]
            full = (
                f"Use the {SKILL} skill to fulfil this request on the PRISM server.\n"
                f"Run its helper exactly as `python {HELPER} <command>` — one command per call, no cd, no env-var prefix, "
                "no && or pipes (the server address is already configured). "
                "Work fully autonomously — nobody can answer questions during the run.\n\n"
                f"Request:\n{prompt}\n\n"
                "Finish with a short report in the language of the request: what you created (with paths), "
                "match rate, key findings, and assumptions."
            )
            add("info", "Starting Claude Code")
            flush(True)
            self.proc = subprocess.Popen(
                cmd, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", bufsize=1, **_no_window(),
            )  # fmt: skip
            self.proc.stdin.write(full)
            self.proc.stdin.close()

            def read_err():
                for line in self.proc.stderr:
                    stderr_tail.append(line)
                    del stderr_tail[:-40]

            threading.Thread(target=read_err, daemon=True).start()
            timer = threading.Timer(AI_TIMEOUT_MIN * 60, lambda: (add("error", f"Timed out after {AI_TIMEOUT_MIN} min"), _kill_tree(self.proc)))
            timer.start()
            tools: dict[str, str] = {}
            try:
                for line in self.proc.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = json.loads(line)
                    except ValueError:
                        continue
                    self._handle(ev, add, tools, result)
                    flush()
            finally:
                timer.cancel()
            rc = self.proc.wait()
            if self.cancelled:
                status, error = "cancelled", "Cancelled"
            elif rc != 0 or result.get("is_error"):
                status = "error"
                error = result.get("summary") or "".join(stderr_tail).strip()[-1500:] or f"Claude Code exited with code {rc}"
            else:
                status = "done"
        except Exception as e:  # noqa: BLE001
            log.exception("AI job %s failed", job_id)
            error = f"{type(e).__name__}: {e}" if not isinstance(e, AgentUnavailable) else str(e)
            add("error", error)
        finally:
            result.update(self._made(result.pop("_made", [])))
            result.pop("is_error", None)
            with SessionLocal() as db:
                j = db.get(AgentJob, job_id)
                j.events, j.result, j.status, j.error, j.finished_at = list(events), result, status, error[:4000], datetime.now()
                db.commit()
            self.proc = None
            self.job_id = None

    @staticmethod
    def _handle(ev: dict, add, tools: dict, result: dict):
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            add("info", f"Model {ev.get('model', '')}".strip())
        elif t == "assistant":
            for c in (ev.get("message") or {}).get("content") or []:
                if c.get("type") == "text" and c.get("text", "").strip():
                    add("text", c["text"].strip())
                elif c.get("type") == "tool_use":
                    tools[c.get("id")] = c.get("name")
                    add("tool", _summarize_tool(c.get("name", ""), c.get("input") or {}))
        elif t == "user":
            stdout = (ev.get("tool_use_result") or {}).get("stdout") if isinstance(ev.get("tool_use_result"), dict) else None
            for c in (ev.get("message") or {}).get("content") or []:
                if not isinstance(c, dict) or c.get("type") != "tool_result":
                    continue
                text = stdout or _tool_result_text(c)
                if c.get("is_error"):
                    add("error", text.strip()[:600])
                    continue
                # helper 가 만들고/바꾼 항목을 출력하는 표시 — 이것만 결과로 인정 (Flow 실행만으로도 updated_at 은 바뀌므로)
                for key in ("created_flow", "created_dashboard", "updated_flow", "updated_dashboard"):
                    if f'"{key}"' in text:
                        try:
                            # 출력 뒤에 'Shell cwd was reset …' 같은 줄이 붙으므로 첫 JSON 값만 읽음
                            item = json.JSONDecoder().raw_decode(text[text.index("{"):])[0][key]
                        except Exception:  # noqa: BLE001
                            continue
                        action, what = key.split("_")
                        result.setdefault("_made", []).append({"what": what, "action": action, "id": item.get("id")})
                        add("created", f"{action.capitalize()} {what}: {item.get('name')}", what=what, id=item.get("id"), action=action)
        elif t == "result":
            result.update(
                summary=str(ev.get("result") or "").strip(),
                cost_usd=ev.get("total_cost_usd"),
                turns=ev.get("num_turns"),
                duration_ms=ev.get("duration_ms"),
                is_error=bool(ev.get("is_error")),
            )
            if ev.get("is_error"):
                add("error", result["summary"][:1000] or "Claude Code reported an error")

    @staticmethod
    def _made(made: list[dict]) -> dict:
        """helper 가 알려준 생성/수정 항목을 현재 DB 이름과 함께 정리 (같은 항목은 '생성'이 우선)."""
        out: dict[str, dict[int, dict]] = {"flow": {}, "dashboard": {}}
        with SessionLocal() as db:
            for m in made:
                model = Flow if m["what"] == "flow" else Dashboard
                row = db.get(model, m["id"]) if m.get("id") else None
                if row is None:
                    continue
                cur = out[m["what"]].get(row.id)
                action = "created" if m["action"] == "created" or (cur and cur["action"] == "created") else "updated"
                item = {"id": row.id, "name": row.name, "action": action}
                item.update({"kind": row.kind} if model is Flow else {"slug": row.slug})
                out[m["what"]][row.id] = item
        return {"flows": list(out["flow"].values()), "dashboards": list(out["dashboard"].values())}


def _kill_tree(proc: subprocess.Popen | None):
    if proc is None or proc.poll() is not None:
        return
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, **_no_window())
        else:
            proc.kill()
    except Exception:  # noqa: BLE001
        pass


runner = Runner()
