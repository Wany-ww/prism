import json
import os
import threading
from datetime import datetime

import pandas as pd
import pyarrow as pa
from sqlalchemy import select

from ..config import DATASET_DIR
from ..models import Dataset

# 데이터셋(parquet) 메모리 캐시: dataset_id -> (파일 수정시각, DataFrame).
# 매 위젯/Flow 노드 요청마다 디스크에서 다시 읽고 역직렬화하는 비용을 없앤다.
# 파일 수정시각이 바뀌면(= Flow 가 다시 저장함) 자동으로 새로 읽는다. 호출한 쪽이 결과를 자유롭게
# 수정해도 캐시가 상하지 않도록, 캐시에서 꺼내거나 막 읽은 프레임은 항상 복사본을 돌려준다.
_CACHE_MAX = 64
_cache: dict[int, tuple[float, pd.DataFrame]] = {}
_cache_lock = threading.Lock()


def dtype_kind(s: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(s):
        return "bool"
    if pd.api.types.is_numeric_dtype(s):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(s):
        return "datetime"
    return "string"


def columns_meta(df: pd.DataFrame) -> list[dict]:
    return [{"name": str(c), "dtype": dtype_kind(df[c])} for c in df.columns]


def frame_payload(df: pd.DataFrame, limit: int | None = 200, offset: int = 0) -> dict:
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
    return {"columns": columns_meta(df), "rows": rows, "row_count": int(len(df))}


def _parquet_safe(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.columns = [str(c) for c in df.columns]
    for c in df.columns:
        if df[c].dtype == object:
            try:
                pa.array(df[c], from_pandas=True)
            except (pa.ArrowInvalid, pa.ArrowTypeError):
                df[c] = df[c].map(lambda v: None if v is None or (isinstance(v, float) and v != v) else str(v))
    return df


def dataset_file(ds_id: int) -> str:
    return str(DATASET_DIR / f"{ds_id}.parquet")


def save_dataset(db, name: str, df: pd.DataFrame, flow_id: int | None, node_id: str) -> Dataset:
    name = name.strip()
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    if ds is None:
        ds = Dataset(name=name)
        db.add(ds)
        db.flush()
    safe = _parquet_safe(df.reset_index(drop=True))
    tmp = dataset_file(ds.id) + ".tmp"
    safe.to_parquet(tmp, index=False)
    os.replace(tmp, dataset_file(ds.id))
    ds.flow_id, ds.node_id = flow_id, node_id
    ds.columns, ds.row_count, ds.updated_at = columns_meta(safe), int(len(safe)), datetime.now()
    db.commit()
    # 방금 쓴 내용으로 캐시도 바로 갱신 (파일시스템의 mtime 해상도가 낮아 다시 읽을 때 옛 캐시와
    # 헷갈리는 일을 막고, 바로 이어지는 조회가 다시 디스크를 읽지 않게 함)
    with _cache_lock:
        _cache[ds.id] = (os.path.getmtime(dataset_file(ds.id)), safe)
    return ds


def load_dataset(db, name: str) -> pd.DataFrame:
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    path = dataset_file(ds.id) if ds else ""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        raise KeyError(f"Dataset [{name}] does not exist. Run its flow first.") from None
    with _cache_lock:
        cached = _cache.get(ds.id)
        if cached and cached[0] == mtime:
            return cached[1].copy()
    df = pd.read_parquet(path)
    with _cache_lock:
        _cache[ds.id] = (mtime, df)
        while len(_cache) > _CACHE_MAX:
            _cache.pop(next(iter(_cache)))  # 가장 먼저 들어온 것부터 정리 (간단한 크기 제한)
    return df.copy()


def delete_dataset_file(ds_id: int):
    with _cache_lock:
        _cache.pop(ds_id, None)
    try:
        os.remove(dataset_file(ds_id))
    except FileNotFoundError:
        pass
