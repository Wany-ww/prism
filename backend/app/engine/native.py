"""Rust 네이티브 엔진(prism_core) 연결.

저장(parquet)·수집 CSV 파싱·Match 짝 찾기는 Rust 로 구현된 prism_core 가 맡는다 (pyarrow 를 쓰지 않음).
여기서는 pandas 컬럼을 종류별 numpy 배열로 넘기고, 결과 표를 다시 pandas DataFrame 으로 만든다.
사용자 Parser·노드 코드는 지금처럼 pandas 로 실행된다.
"""

from types import SimpleNamespace

import numpy as np
import pandas as pd
from pandas.api import types as pdt
from pandas.api.internals import create_dataframe_from_blocks

try:
    from .. import prism_core as core
except ImportError as e:  # pragma: no cover - 배포 묶음에는 항상 들어 있음
    raise ImportError(
        "PRISM native engine (backend/app/prism_core.pyd) is missing or does not match this Python. "
        "Build it with scripts\\build-native.ps1 (needs Rust) or use the release bundle."
    ) from e

Table = core.Table

_I64_MAX = np.iinfo(np.int64).max


def _contig(a: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(a)


def column_payload(s: pd.Series):
    """pandas 컬럼 → (종류, 값 배열, null 마스크|None). 종류는 prism_core.Table.from_columns 참고."""
    dt = s.dtype
    if isinstance(dt, pd.CategoricalDtype):
        s = s.astype(object)
        dt = s.dtype
    if pdt.is_bool_dtype(dt):
        if isinstance(dt, np.dtype):
            return ("bool", _contig(s.to_numpy()), None)
        na = s.isna().to_numpy()
        return ("bool", s.to_numpy(dtype=bool, na_value=False), na if na.any() else None)
    if pdt.is_integer_dtype(dt):
        if isinstance(dt, np.dtype):
            if dt == np.uint64 and len(s) and int(s.max()) > _I64_MAX:
                return ("f64", s.to_numpy(np.float64), None)
            return ("i64", _contig(s.to_numpy(np.int64)), None)
        na = s.isna().to_numpy()
        return ("i64", s.to_numpy(dtype=np.int64, na_value=0), na if na.any() else None)
    if pdt.is_float_dtype(dt):
        return ("f64", _contig(s.to_numpy(dtype=np.float64, na_value=np.nan)), None)
    if pdt.is_datetime64_any_dtype(dt):
        if getattr(dt, "tz", None) is not None:
            s = s.dt.tz_convert(None)
        return ("ts", _contig(s.to_numpy("datetime64[us]").view(np.int64)), None)
    vals = s.to_numpy(dtype=object, na_value=None)
    kind = pdt.infer_dtype(vals, skipna=True)
    if kind in ("string", "empty"):
        return ("str", vals, None)
    if kind == "boolean":
        return ("obj_bool", vals, None)
    if kind == "integer":
        return ("obj_int", vals, None)
    if kind in ("floating", "mixed-integer-float", "decimal", "integer-na"):
        return ("obj_float", vals, None)
    if kind in ("datetime", "datetime64", "date"):
        try:
            return column_payload(pd.Series(pd.to_datetime(pd.Series(vals), errors="raise")))
        except (ValueError, TypeError):
            pass
    # 섞인 타입(숫자+문자 등)·dict·list 는 문자열로 저장 (예전 parquet_safe 와 같음)
    return ("str", vals, None)


def to_table(df: pd.DataFrame) -> "core.Table":
    names, payloads = [], []
    for name, s in df.items():
        names.append(str(name))
        payloads.append(column_payload(s))
    return core.Table.from_columns(names, payloads, len(df))


def to_pandas(t: "core.Table") -> pd.DataFrame:
    """같은 종류 컬럼을 Rust 가 2D 블록으로 모아 주므로 pandas 가 다시 합치며 복사하지 않는다."""
    names = t.column_names
    if not names:
        return pd.DataFrame(index=pd.RangeIndex(t.num_rows))
    blocks = []
    for kind, arr, place in t.to_blocks():
        if kind == "ts":
            arr = arr.view("datetime64[us]")
        elif kind == "str":
            arr = pd.array(arr, dtype="str")  # pandas 기본 문자열 타입 (1D, 컬럼마다)
        blocks.append((arr, np.asarray(place, dtype=np.intp)))
    return create_dataframe_from_blocks(blocks, index=pd.RangeIndex(t.num_rows), columns=pd.Index(names))


def empty_frame(schema: list) -> pd.DataFrame:
    return to_pandas(core.Table.empty(schema))


def to_us(value) -> int:
    """datetime/문자열 → 마이크로초 정수 (since/until 비교용)."""
    ts = pd.Timestamp(value)
    if ts.tzinfo is not None:
        ts = ts.tz_convert(None)
    return int(ts.as_unit("us").value)


# ---------------- Match 키 ----------------


def key_payload(s: pd.Series):
    """Match 키 컬럼 → (종류, 값, 마스크). 숫자/참거짓/시각은 타입 그대로, 나머지는 Python 값 그대로(raw)."""
    dt = s.dtype
    if isinstance(dt, np.dtype):
        if dt.kind == "b":
            return ("bool", _contig(s.to_numpy()), None)
        if dt.kind in "iu":
            return ("i64", _contig(s.to_numpy(np.int64)), None) if dt != np.uint64 else ("raw", s.to_numpy(dtype=object), None)
        if dt.kind == "f":
            return ("f64", _contig(s.to_numpy(np.float64)), None)
        if dt.kind == "M":
            return ("ts", _contig(s.to_numpy("datetime64[us]").view(np.int64)), None)
    return ("raw", s.to_numpy(dtype=object), None)


def time_payload(s: pd.Series) -> np.ndarray:
    t = pd.to_datetime(s, errors="coerce")
    if getattr(t.dt, "tz", None) is not None:
        t = t.dt.tz_convert(None)
    return _contig(t.to_numpy("datetime64[us]").view(np.int64))


def match_pairs(left_keys: list, right_keys: list, **kw) -> tuple[np.ndarray, np.ndarray]:
    return core.match_pairs(left_keys, right_keys, **kw)


# ---------------- Parser 용 CSV ----------------


def read_csv(path=None, *, text=None, encoding="utf-8", sep=",", skiprows=0, header=0, meta_prefix=None, comment=None, errors="strict"):
    """빠른 CSV 읽기 (Rust). pandas.read_csv 와 같은 타입 추론(정수→실수→참/거짓→문자열)과 결측 표기를 따른다.

    meta_prefix='#' 이면 '#' 로 시작하는 줄은 표에서 빼고 'Key=Value' 로 해석해 df.attrs['meta'] 에 담는다.
    path 대신 text= 로 문자열을 줄 수도 있다. 시각 컬럼은 문자열로 읽히므로 pd.to_datetime 으로 바꿔 쓴다.
    """
    if path is not None and hasattr(path, "read"):
        text, path = path.read(), None
    if isinstance(text, bytes):
        text = text.decode(encoding)
    t, meta = core.read_csv(
        path=None if path is None else str(path),
        text=text,
        encoding=encoding or "utf-8",
        sep=sep,
        skip_rows=int(skiprows or 0),
        header=header is not None and header is not False,
        meta_prefix=meta_prefix,
        comment=comment,
        errors=errors,
    )
    df = to_pandas(t)
    if meta_prefix is not None:
        df.attrs["meta"] = dict(meta)
    return df


# 사용자 Parser·노드 코드에서 `prism.read_csv(...)` 로 사용
user_helpers = SimpleNamespace(read_csv=read_csv)
