import json
import os
from datetime import datetime

import pandas as pd
import pyarrow as pa
from sqlalchemy import select

from ..config import DATASET_DIR
from ..models import Dataset


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
    return ds


def load_dataset(db, name: str) -> pd.DataFrame:
    ds = db.scalar(select(Dataset).where(Dataset.name == name))
    if ds is None or not os.path.exists(dataset_file(ds.id)):
        raise KeyError(f"데이터셋 '{name}' 이 없습니다. 해당 Flow를 먼저 실행하세요.")
    return pd.read_parquet(dataset_file(ds.id))


def delete_dataset_file(ds_id: int):
    try:
        os.remove(dataset_file(ds_id))
    except FileNotFoundError:
        pass
