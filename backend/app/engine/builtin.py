"""시스템 내장 노드: source / match / union / dataset / output / python."""

import math
from datetime import datetime, timedelta

import pandas as pd

from ..capture.service import load_records
from .frames import load_dataset, save_dataset
from .usercode import call_user, load_function, to_frame


class NodeError(Exception):
    pass


def _ts_column(df: pd.DataFrame, explicit: str | None) -> str:
    if explicit:
        if explicit not in df.columns:
            raise NodeError(f"시간 컬럼 '{explicit}' 이 없습니다.")
        return explicit
    for c in df.columns:
        if str(c) == "_ts" or str(c).endswith("._ts"):
            return c
    raise NodeError("시간 컬럼(_ts)을 찾을 수 없습니다. 시간 컬럼을 직접 지정하세요.")


def _norm_value(v, upper: bool):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    t = str(v).strip()
    if t == "":
        return None
    return t.upper() if upper else t


def _key_series(s: pd.Series, normalize: bool, upper: bool, side: str) -> pd.Series:
    vals = s.map(lambda v: _norm_value(v, upper)) if normalize else s.astype(object)
    # null 키는 서로 매칭되지 않도록 고유 값으로 치환
    null = vals.isna()
    if null.any():
        vals = vals.astype(object)
        vals[null] = [f"\x00null{side}{i}" for i in range(int(null.sum()))]
    return vals.astype(str)


def node_source(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    ids = [int(i) for i in (params.get("equipment_ids") or [])]
    if not ids:
        raise NodeError("설비를 1개 이상 선택하세요.")
    since = until = None
    if params.get("days"):
        since = datetime.now() - timedelta(days=float(params["days"]))
    if params.get("since"):
        since = pd.to_datetime(params["since"]).to_pydatetime()
    if params.get("until"):
        until = pd.to_datetime(params["until"]).to_pydatetime()
    df = load_records(ctx.db, ids, since, until)
    cols = [c for c in (params.get("columns") or []) if c]
    if cols:
        keep = [c for c in cols if c in df.columns] + ["_ts", "_equipment"]
        df = df[list(dict.fromkeys(keep))]
    alias = str(params.get("alias") or "").strip()
    if alias:
        df.columns = [f"{alias}.{c}" for c in df.columns]
    return df


def node_match(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if len(inputs) < 2:
        raise NodeError("Match 노드는 왼쪽/오른쪽 입력이 모두 연결되어야 합니다.")
    left, right = inputs[0].copy(), inputs[1].copy()
    keys = [k for k in (params.get("keys") or []) if k.get("left") and k.get("right")]
    if not keys:
        raise NodeError("매칭 키를 1개 이상 지정하세요.")
    for k in keys:
        if k["left"] not in left.columns:
            raise NodeError(f"왼쪽 입력에 '{k['left']}' 컬럼이 없습니다.")
        if k["right"] not in right.columns:
            raise NodeError(f"오른쪽 입력에 '{k['right']}' 컬럼이 없습니다.")
    normalize = params.get("normalize", True)
    upper = params.get("ignore_case", False)
    how = params.get("how", "inner")
    strategy = params.get("strategy", "exact")

    kcols = [f"__k{i}" for i in range(len(keys))]
    for kc, k in zip(kcols, keys):
        left[kc] = _key_series(left[k["left"]], normalize, upper, "L")
        right[kc] = _key_series(right[k["right"]], normalize, upper, "R")
    right["__ridx"] = range(len(right))

    if strategy == "exact":
        dup = params.get("duplicates", "all")
        if dup in ("first", "last"):
            right = right.drop_duplicates(subset=kcols, keep=dup)
        res = left.merge(right, on=kcols, how=how, suffixes=("", "_r"))
    else:
        direction = {"nearest_after": "forward", "nearest_before": "backward", "nearest": "nearest"}.get(strategy)
        if direction is None:
            raise NodeError(f"알 수 없는 매칭 방식: {strategy}")
        lt = _ts_column(left, params.get("left_time"))
        rt = _ts_column(right, params.get("right_time"))
        left["__lt"] = pd.to_datetime(left[lt], errors="coerce")
        right["__rt"] = pd.to_datetime(right[rt], errors="coerce")
        right = right[right["__rt"].notna()]
        l_ok = left[left["__lt"].notna()].sort_values("__lt")
        l_na = left[left["__lt"].isna()]
        tol_h = float(params.get("tolerance_hours") or 0)
        res = pd.merge_asof(
            l_ok,
            right.sort_values("__rt"),
            left_on="__lt",
            right_on="__rt",
            by=kcols,
            direction=direction,
            tolerance=pd.Timedelta(hours=tol_h) if tol_h > 0 else None,
            suffixes=("", "_r"),
        )
        if how == "inner":
            res = res[res["__ridx"].notna()]
        else:
            res = pd.concat([res, l_na], ignore_index=True, sort=False)
            if how == "outer":
                used = set(res["__ridx"].dropna().astype(int))
                res = pd.concat([res, right[~right["__ridx"].isin(used)]], ignore_index=True, sort=False)
        res = res.drop(columns=[c for c in ("__lt", "__rt") if c in res.columns])
    return res.drop(columns=[c for c in kcols + ["__ridx"] if c in res.columns]).reset_index(drop=True)


def node_union(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if not inputs:
        raise NodeError("입력이 없습니다.")
    return pd.concat(inputs, ignore_index=True, sort=False)


def node_dataset(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    name = (params.get("name") or "").strip()
    if not name:
        raise NodeError("데이터셋을 선택하세요.")
    try:
        return load_dataset(ctx.db, name)
    except KeyError as e:
        raise NodeError(str(e)) from e


def node_output(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if not inputs:
        raise NodeError("입력이 연결되지 않았습니다.")
    df = inputs[0]
    name = (params.get("name") or "").strip()
    if not name:
        raise NodeError("출력 데이터셋 이름을 지정하세요.")
    if ctx.save:
        save_dataset(ctx.db, name, df, ctx.flow_id, ctx.current_node)
    return df


def node_python(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    code = params.get("code") or ""
    label = f"node:{ctx.current_node}"
    fn = load_function(code, "run", label)
    return to_frame(call_user(fn, label, [i.copy() for i in inputs], params.get("vars") or {}), label)


def node_graph(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    """Match 결과를 Neo4j 제품 계보 그래프로 저장 (Flow 실행·저장 시에만 기록)."""
    from .. import graph

    if not inputs:
        raise NodeError("입력이 연결되지 않았습니다.")
    df = inputs[0]
    name = (params.get("name") or "").strip()
    key = (params.get("product_key") or "").strip()
    resources = graph.parse_resources(params.get("resources") or "")
    if not name:
        raise NodeError("그래프 이름을 지정하세요.")
    missing = [c for c in [key] + [c for c, _ in resources] if c and c not in df.columns]
    if missing:
        raise NodeError(f"입력에 없는 컬럼: {', '.join(missing)}")
    if ctx.save and graph.enabled():
        try:
            graph.export_graph(name, df, key, resources)
        except graph.GraphError as e:
            raise NodeError(str(e)) from e
    return df


def node_cypher(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    """Neo4j 읽기 전용 Cypher 조회. 입력이 연결되면 $rows 로 전달."""
    from .. import graph

    query = (params.get("query") or "").strip()
    if not query:
        raise NodeError("Cypher 쿼리를 입력하세요.")
    qp = dict(params.get("params") or {})
    if inputs:
        qp["rows"] = [{k: graph._clean(v) for k, v in r.items()} for r in inputs[0].head(10000).to_dict("records")]
    try:
        rows = graph.run_read(query, qp)
    except graph.GraphError as e:
        raise NodeError(str(e)) from e
    limit = int(params.get("limit") or 0)
    return pd.json_normalize(rows[:limit] if limit else rows, max_level=1)


BUILTINS = {
    "graph": node_graph,
    "cypher": node_cypher,
    "source": node_source,
    "match": node_match,
    "union": node_union,
    "dataset": node_dataset,
    "output": node_output,
    "python": node_python,
}
