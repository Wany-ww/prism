"""사용자 작성 Python 코드(Parser, 노드) 로딩/실행.

사내 엔지니어가 작성하는 코드를 그대로 실행하는 신뢰 모델이다.
pd / np / re / json / math / datetime 은 import 없이 사용할 수 있다.
"""

import datetime
import hashlib
import json
import math
import re
import threading
import traceback

import numpy as np
import pandas as pd

_cache: dict[tuple[str, str], object] = {}
_lock = threading.Lock()


class UserCodeError(Exception):
    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        self.detail = detail


def _base_globals(label: str) -> dict:
    return {
        "__name__": f"prism_user.{label}",
        "pd": pd,
        "np": np,
        "re": re,
        "json": json,
        "math": math,
        "datetime": datetime,
    }


def load_function(code: str, func_name: str, label: str):
    key = (func_name, hashlib.sha1(code.encode("utf-8")).hexdigest())
    with _lock:
        fn = _cache.get(key)
    if fn is not None:
        return fn
    ns = _base_globals(label)
    try:
        exec(compile(code, f"<{label}>", "exec"), ns)
    except SyntaxError as e:
        raise UserCodeError(f"[{label}] Syntax error at line {e.lineno}: {e.msg}", traceback.format_exc(limit=0)) from e
    except Exception as e:
        raise UserCodeError(f"[{label}] Failed to load code: {e}", user_traceback(e, label)) from e
    fn = ns.get(func_name)
    if not callable(fn):
        raise UserCodeError(f"[{label}] Function '{func_name}' is not defined.")
    with _lock:
        _cache[key] = fn
    return fn


def user_traceback(exc: BaseException, label: str | None = None) -> str:
    frames = traceback.extract_tb(exc.__traceback__)
    if label:
        mine = [f for f in frames if f.filename == f"<{label}>"]
        frames = mine or frames
    lines = [f"  {f.filename} line {f.lineno}, in {f.name}" for f in frames[-5:]]
    return "Traceback:\n" + "\n".join(lines) + f"\n{type(exc).__name__}: {exc}"


def call_user(fn, label: str, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except UserCodeError:
        raise
    except Exception as e:
        raise UserCodeError(f"[{label}] Runtime error: {type(e).__name__}: {e}", user_traceback(e, label)) from e


def to_frame(result, label: str) -> pd.DataFrame:
    if result is None:
        return pd.DataFrame()
    if isinstance(result, pd.DataFrame):
        return result
    if isinstance(result, pd.Series):
        return result.to_frame()
    if isinstance(result, dict):
        try:
            return pd.DataFrame(result)
        except ValueError:
            return pd.DataFrame([result])
    if isinstance(result, (list, tuple)):
        return pd.DataFrame(list(result))
    raise UserCodeError(f"[{label}] Must return a DataFrame / list[dict] / dict (got {type(result).__name__})")
