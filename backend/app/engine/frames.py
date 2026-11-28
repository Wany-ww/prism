"""데이터셋 저장소.

데이터셋 하나 = 폴더 하나 (datasets/<id>/). 그 안에 최대 PART_ROWS 행짜리 parquet 파트들과, 현재 유효한 파트 목록을
적은 manifest.json 이 있다. 조회는 필요한 컬럼/행 범위만 읽고, upsert 저장은 키가 겹치는 파트만 다시 쓴다.
manifest 를 바꿔치기하는 것으로 저장이 끝나므로, 저장 중에 다른 프로세스가 읽어도 이전 버전이 그대로 보인다.

parquet 읽기/쓰기·스키마 맞추기·upsert 키 비교는 Rust 엔진(prism_core)이 한다 (native.py).
"""

import json
import os
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from sqlalchemy import select

from ..config import CACHE_MB, DATASET_DIR
from ..models import Dataset
from . import native
from .native import core

PART_ROWS = 100_000
ROW_GROUP = 10_000
SMALL_PART = PART_ROWS // 4
MAX_SMALL_PARTS = 8

# 스키마 = [(컬럼명, 타입)] — 타입: bool / int64 / float64 / string / timestamp / null
Schema = list[tuple[str, str]]

# (dataset_id, 컬럼 목록|None) -> (manifest 버전, DataFrame, 바이트 수). 크기 한도 안에서 오래 안 쓴 것부터 정리.
_cache: "OrderedDict[tuple, tuple[int, pd.DataFrame, int]]" = OrderedDict()
_cache_bytes = 0
_schemas: dict[int, tuple[int, Schema]] = {}
_lock = threading.Lock()


# ---------------- 공통 ----------------


def dtype_kind(s: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(s):
        return "bool"
    if pd.api.types.is_numeric_dtype(s):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    return "string"


_TYPE_KIND = {"bool": "bool", "int64": "number", "float64": "number", "timestamp": "datetime"}


def columns_meta(df: pd.DataFrame) -> list[dict]:
    return [{"name": str(c), "dtype": dtype_kind(df[c])} for c in df.columns]


def schema_meta(schema: Schema) -> list[dict]:
    return [{"name": n, "dtype": _TYPE_KIND.get(t, "string")} for n, t in schema]


def frame_payload(df: pd.DataFrame, limit: int | None = 200, offset: int = 0, row_count: int | None = None) -> dict:
    part = df.iloc[offset : offset + limit] if limit else df.iloc[offset:]
    part = part.copy()
    part.columns = [str(c) for c in part.columns]
    for c in part.columns:
        if pd.api.types.is_datetime64_any_dtype(part[c]):
            part[c] = part[c].dt.strftime("%Y-%m-%d %H:%M:%S.%f").str[:-3]
    if len(part):
        split = json.loads(part.to_json(orient="split", index=False, force_ascii=False, default_handler=str))
        rows = split["data"]
    else:
        rows = []
    return {"columns": columns_meta(df), "rows": rows, "row_count": int(len(df) if row_count is None else row_count)}


def to_table(df: pd.DataFrame) -> "core.Table":
    return native.to_table(df)


def write_parquet(table: "core.Table", path, row_group_size: int = ROW_GROUP):
    table.write_parquet(str(path), row_group_size)


def unify(schemas: list[Schema]) -> Schema:
    return [tuple(f) for f in core.unify_schemas(schemas)]


def read_tables(paths: list[str], schema: Schema | None, columns: list[str] | None) -> "core.Table":
    """여러 parquet 를 하나의 스키마로 읽음. 없는 컬럼은 null, 타입은 schema 로 맞춤."""
    return core.read_tables([str(p) for p in paths], schema, columns)


def _sub_schema(schema: Schema, cols: list[str]) -> Schema:
    types = dict(schema)
    return [(c, types[c]) for c in cols]


# ---------------- manifest ----------------


def dataset_dir(ds_id: int) -> Path:
    return DATASET_DIR / str(ds_id)


def _manifest_path(ds_id: int) -> Path:
    return dataset_dir(ds_id) / "manifest.json"


def _retry(fn, tries: int = 20):
    # Windows 에서는 다른 프로세스가 잠깐 열고 있는 파일을 바꿔치기/삭제하지 못하므로 잠시 후 다시 시도
    for i in range(tries):
        try:
            return fn()
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.05 * (i + 1))


def _read_manifest(ds_id: int) -> dict | None:
    path = _manifest_path(ds_id)
    legacy = DATASET_DIR / f"{ds_id}.parquet"
    if not path.exists() and legacy.exists():
        # 이전 형식(데이터셋 = parquet 파일 1개)을 파트 1개짜리 폴더로 옮김
        dataset_dir(ds_id).mkdir(parents=True, exist_ok=True)
        name = f"p-{uuid.uuid4().hex[:12]}.parquet"
        os.replace(legacy, dataset_dir(ds_id) / name)
        rows = core.parquet_info(str(dataset_dir(ds_id) / name))[0]
        _write_manifest(ds_id, {"version": 1, "parts": [{"file": name, "rows": rows}]})
    if not path.exists():
        return None
    return _retry(lambda: json.loads(path.read_text(encoding="utf-8")))


def _write_manifest(ds_id: int, man: dict):
    path = _manifest_path(ds_id)
    tmp = path.with_name(f"manifest.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(man), encoding="utf-8")
    _retry(lambda: os.replace(tmp, path))


def _cleanup(ds_id: int, man: dict):
    """manifest 에 없는 파트 파일 정리 (다른 프로세스가 읽는 중이면 다음 저장 때 정리)."""
    keep = {p["file"] for p in man["parts"]} | {"manifest.json"}
    for f in dataset_dir(ds_id).iterdir():
        if f.name not in keep and not f.name.endswith(".tmp"):
            try:
                f.unlink()
            except OSError:
                pass


def _paths(ds_id: int, man: dict) -> list[str]:
    return [str(dataset_dir(ds_id) / p["file"]) for p in man["parts"]]


def _schema(ds_id: int, man: dict) -> Schema:
    with _lock:
        hit = _schemas.get(ds_id)
        if hit and hit[0] == man["version"]:
            return hit[1]
    paths = _paths(ds_id, man)
    schema = unify([core.read_schema(p) for p in paths]) if paths else []
    with _lock:
        _schemas[ds_id] = (man["version"], schema)
    return schema


def _write_parts(ds_id: int, table: "core.Table") -> list[dict]:
    out = []
    for start in range(0, table.num_rows, PART_ROWS):
        name = f"p-{uuid.uuid4().hex[:12]}.parquet"
        piece = table.slice(start, PART_ROWS)
        write_parquet(piece, dataset_dir(ds_id) / name)
        out.append({"file": name, "rows": piece.num_rows})
    return out


# ---------------- 키 비교 ----------------


def norm_keys(s: pd.Series) -> pd.Series:
    """키 비교용 정규화: 공백 제거, 1.0 → 1, 시각은 화면 표기와 같게. (upsert 키는 Rust 엔진이 같은 규칙으로 만든다)"""
    if pd.api.types.is_datetime64_any_dtype(s):
        s = s.dt.strftime("%Y-%m-%d %H:%M:%S.%f").str[:-3]
    s = s.astype(str).str.strip()
    return s.str.replace(r"^(-?\d+)\.0+$", r"\1", regex=True)


# ---------------- 저장 ----------------


def _get(db, name: str) -> Dataset:
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    if ds is None:
        raise KeyError(f"Dataset [{name}] does not exist. Run its flow first.")
    return ds


def save_dataset(db, name: str, df: pd.DataFrame, flow_id: int | None, node_id: str, mode: str = "replace", keys: list[str] | None = None) -> Dataset:
    """mode=replace: 전체 교체. mode=upsert: keys 가 같은 기존 행을 새 행으로 바꾸고 나머지는 유지 (증분 저장)."""
    name = name.strip()
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    if ds is None:
        ds = Dataset(name=name)
        db.add(ds)
        db.flush()
    dataset_dir(ds.id).mkdir(parents=True, exist_ok=True)
    table = to_table(df.reset_index(drop=True))
    man = _read_manifest(ds.id)
    keys = [k for k in (keys or []) if k]
    if mode == "upsert" and keys:
        missing = [k for k in keys if k not in table.column_names]
        if missing:
            raise ValueError(f"Upsert key columns missing from input: {', '.join(missing)}")
    if mode == "upsert" and keys and man and man["parts"]:
        parts = _upsert(ds.id, man, table, keys)
    else:
        parts = _write_parts(ds.id, table)
    if not parts:  # 빈 결과도 컬럼 정보는 남김
        name0 = f"p-{uuid.uuid4().hex[:12]}.parquet"
        write_parquet(table, dataset_dir(ds.id) / name0)
        parts = [{"file": name0, "rows": 0}]
    man = {"version": (man["version"] + 1) if man else 1, "parts": parts}
    _write_manifest(ds.id, man)
    _cleanup(ds.id, man)
    schema = _schema(ds.id, man)
    ds.flow_id, ds.node_id = flow_id, node_id
    ds.columns, ds.row_count, ds.updated_at = schema_meta(schema), int(sum(p["rows"] for p in parts)), datetime.now()
    db.commit()
    return ds


def _upsert(ds_id: int, man: dict, table: "core.Table", keys: list[str]) -> list[dict]:
    # 파트마다 타입이 달라도 읽을 때 스키마를 합쳐 맞추므로 여기서는 맞추지 않는다 (int 1 과 float 1.0 은 같은 키)
    new_keys = table.key_set(keys)
    kept: list[dict] = []
    for part in man["parts"]:
        path = str(dataset_dir(ds_id) / part["file"])
        names = {n for n, _ in core.read_schema(path)}
        if any(k not in names for k in keys):
            kept.append(part)
            continue
        hit = core.read_parquet(path, keys).key_hits(keys, new_keys)
        if not hit.any():
            kept.append(part)
        elif not hit.all():
            kept += _write_parts(ds_id, core.read_parquet(path).filter(~hit))
    kept += _write_parts(ds_id, table)
    # 작은 파트가 많이 쌓이면 합침
    small = [p for p in kept if p["rows"] < SMALL_PART]
    if len(small) > MAX_SMALL_PARTS:
        merged = read_tables([str(dataset_dir(ds_id) / p["file"]) for p in small], None, None)
        kept = [p for p in kept if p["rows"] >= SMALL_PART] + _write_parts(ds_id, merged)
    return kept


# ---------------- 조회 ----------------


def _cache_get(key: tuple, version: int) -> pd.DataFrame | None:
    with _lock:
        hit = _cache.get(key)
        if hit and hit[0] == version:
            _cache.move_to_end(key)
            return hit[1]
    return None


def _cache_put(key: tuple, version: int, df: pd.DataFrame):
    global _cache_bytes
    size = int(df.memory_usage(deep=False).sum())
    budget = CACHE_MB * 1024 * 1024
    if size > budget // 2:
        return
    with _lock:
        old = _cache.pop(key, None)
        if old:
            _cache_bytes -= old[2]
        _cache[key] = (version, df, size)
        _cache_bytes += size
        while _cache_bytes > budget and _cache:
            _, (_, _, s) = _cache.popitem(last=False)
            _cache_bytes -= s


def _open(db, name: str) -> tuple[Dataset, dict]:
    ds = _get(db, name)
    man = _read_manifest(ds.id)
    if man is None:
        raise KeyError(f"Dataset [{name}] does not exist. Run its flow first.")
    return ds, man


def dataset_columns(db, name: str) -> list[str]:
    ds, man = _open(db, name)
    return [n for n, _ in _schema(ds.id, man)]


def load_dataset(db, name: str, columns: list[str] | None = None) -> pd.DataFrame:
    """columns 를 주면 그 컬럼만 읽음 (없는 컬럼은 무시)."""
    ds, man = _open(db, name)
    key = (ds.id, tuple(columns) if columns is not None else None)
    hit = _cache_get(key, man["version"])
    if hit is not None:
        return hit.copy(deep=False)
    df = native.to_pandas(read_tables(_paths(ds.id, man), _schema(ds.id, man), columns))
    _cache_put(key, man["version"], df)
    return df.copy(deep=False)


def read_range(db, name: str, offset: int, limit: int | None, columns: list[str] | None = None) -> tuple[pd.DataFrame, int]:
    """앞에서부터 offset..offset+limit 행만 읽음 (필요한 파트/row group 만). (프레임, 전체 행 수)."""
    ds, man = _open(db, name)
    schema = _schema(ds.id, man)
    names = {n for n, _ in schema}
    cols = [n for n, _ in schema] if columns is None else [c for c in dict.fromkeys(columns) if c in names]
    sub = _sub_schema(schema, cols)
    total = sum(p["rows"] for p in man["parts"])
    end = total if limit is None else min(total, offset + limit)
    tables, pos = [], 0
    for part in man["parts"]:
        lo, hi = pos, pos + part["rows"]
        pos = hi
        if hi <= offset or lo >= end:
            continue
        idx = np.arange(max(offset, lo) - lo, min(end, hi) - lo, dtype=np.int64)
        tables.append(_take_rows(dataset_dir(ds.id) / part["file"], idx, sub))
    if not tables:
        return native.empty_frame(sub), total
    return native.to_pandas(core.concat(tables)), total


def _take_rows(path: Path, idx: np.ndarray, schema: Schema) -> "core.Table":
    """parquet 파일에서 idx(파일 안 행 번호, 오름차순) 행만, 해당 row group 만 읽어서 schema 에 맞춤."""
    cols = [n for n, _ in schema]
    return core.read_rows(str(path), np.asarray(idx, dtype=np.int64), cols).conform(schema)


def search_dataset(db, name: str, columns: list[str], predicate, limit: int) -> tuple[pd.DataFrame, int]:
    """columns 만 읽어 predicate(DataFrame) -> bool 배열로 행을 찾고, 찾은 행만 전체 컬럼으로 꺼냄."""
    ds, man = _open(db, name)
    schema = _schema(ds.id, man)
    total, tables, left = 0, [], limit
    for part in man["parts"]:
        path = str(dataset_dir(ds.id) / part["file"])
        file_names = {n for n, _ in core.read_schema(path)}
        have = [c for c in columns if c in file_names]
        if not have:
            continue
        mask = np.asarray(predicate(native.to_pandas(core.read_parquet(path, have))), dtype=bool)
        idx = np.flatnonzero(mask)
        total += len(idx)
        if left > 0 and len(idx):
            tables.append(_take_rows(Path(path), idx[:left], schema))
            left -= min(left, len(idx))
    df = native.to_pandas(core.concat(tables)) if tables else native.empty_frame(schema)
    return df, total


def iter_csv(db, name: str):
    """CSV 를 row group(1만 행) 단위로 만들어 흘려보냄 (전체를 메모리에 올리지 않음)."""
    ds, man = _open(db, name)
    schema = _schema(ds.id, man)
    names = [n for n, _ in schema]
    yield ("﻿" + pd.DataFrame(columns=names).to_csv(index=False)).encode("utf-8")
    for p in _paths(ds.id, man):
        for batch in core.ParquetBatches(p):
            yield batch.conform(schema).to_csv()


def delete_dataset_file(ds_id: int):
    global _cache_bytes
    with _lock:
        for k in [k for k in _cache if k[0] == ds_id]:
            _cache_bytes -= _cache.pop(k)[2]
        _schemas.pop(ds_id, None)
    shutil.rmtree(dataset_dir(ds_id), ignore_errors=True)
    try:
        os.remove(DATASET_DIR / f"{ds_id}.parquet")
    except FileNotFoundError:
        pass
