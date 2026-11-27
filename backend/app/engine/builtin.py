"""시스템 내장 노드: source / match / union / dataset / output / python."""

import math
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from ..capture.store import load_records
from .frames import load_dataset, save_dataset
from .usercode import call_user, load_function, to_frame


class NodeError(Exception):
    pass


def _ts_column(df: pd.DataFrame, explicit: str | None) -> str:
    if explicit:
        if explicit not in df.columns:
            raise NodeError(f"Time column '{explicit}' does not exist.")
        return explicit
    for c in df.columns:
        if str(c) == "_ts" or str(c).endswith("._ts"):
            return c
    raise NodeError("No time column (_ts) found. Set the time column explicitly.")


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
        raise NodeError("Select at least one piece of equipment.")
    since = until = None
    if params.get("days"):
        since = datetime.now() - timedelta(days=float(params["days"]))
    if params.get("since"):
        since = pd.to_datetime(params["since"]).to_pydatetime()
    if params.get("until"):
        until = pd.to_datetime(params["until"]).to_pydatetime()
    cols = [c for c in (params.get("columns") or []) if c and c not in ("_ts", "_equipment")]
    df = load_records(ctx.db, ids, since, until, columns=cols or None)
    if cols:
        keep = [c for c in cols if c in df.columns] + ["_ts", "_equipment"]
        df = df[list(dict.fromkeys(keep))]
    alias = str(params.get("alias") or "").strip()
    if alias:
        df.columns = [f"{alias}.{c}" for c in df.columns]
    return df


def _pairs(left: pd.DataFrame, right: pd.DataFrame, keys: list[dict], params: dict) -> pd.DataFrame:
    """키(+시각)만으로 짝을 찾아 (__li, __ri) 행 번호 쌍을 돌려줌. 짝이 없는 쪽은 NaN.
    수천 개 컬럼을 가진 입력을 merge 과정에서 여러 번 복사하지 않기 위해, 실제 데이터는 마지막에 한 번만 조립한다."""
    normalize = params.get("normalize", True)
    upper = params.get("ignore_case", False)
    how = params.get("how", "inner")
    strategy = params.get("strategy", "exact")
    kcols = [f"__k{i}" for i in range(len(keys))]
    lk = pd.DataFrame({kc: _key_series(left[k["left"]], normalize, upper, "L").to_numpy() for kc, k in zip(kcols, keys)})
    rk = pd.DataFrame({kc: _key_series(right[k["right"]], normalize, upper, "R").to_numpy() for kc, k in zip(kcols, keys)})
    lk["__li"] = np.arange(len(left))
    rk["__ri"] = np.arange(len(right))

    if strategy == "exact":
        dup = params.get("duplicates", "all")
        if dup in ("first", "last"):
            rk = rk.drop_duplicates(subset=kcols, keep=dup)
        return lk.merge(rk, on=kcols, how=how)[["__li", "__ri"]]

    direction = {"nearest_after": "forward", "nearest_before": "backward", "nearest": "nearest"}.get(strategy)
    if direction is None:
        raise NodeError(f"Unknown match strategy: {strategy}")
    lt = _ts_column(left, params.get("left_time"))
    rt = _ts_column(right, params.get("right_time"))
    lk["__lt"] = pd.to_datetime(left[lt], errors="coerce").to_numpy()
    rk["__rt"] = pd.to_datetime(right[rt], errors="coerce").to_numpy()
    rk = rk[rk["__rt"].notna()]
    l_ok = lk[lk["__lt"].notna()].sort_values("__lt")
    l_na = lk[lk["__lt"].isna()]
    tol_h = float(params.get("tolerance_hours") or 0)
    res = pd.merge_asof(
        l_ok,
        rk.sort_values("__rt"),
        left_on="__lt",
        right_on="__rt",
        by=kcols,
        direction=direction,
        tolerance=pd.Timedelta(hours=tol_h) if tol_h > 0 else None,
    )[["__li", "__ri"]]
    if how == "inner":
        return res[res["__ri"].notna()]
    res = pd.concat([res, l_na[["__li"]]], ignore_index=True, sort=False)
    if how == "outer":
        used = set(res["__ri"].dropna().astype(int))
        res = pd.concat([res, rk.loc[~rk["__ri"].isin(used), ["__ri"]]], ignore_index=True, sort=False)
    return res


def _pick(df: pd.DataFrame, idx: pd.Series) -> pd.DataFrame:
    """행 번호 목록대로 행을 꺼냄. NaN(짝 없음)은 빈 행."""
    pos = idx.fillna(-1).astype(np.int64).to_numpy()
    return df.reset_index(drop=True).reindex(pos).reset_index(drop=True)


def node_match(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if len(inputs) < 2:
        raise NodeError("A Match node needs both left and right inputs connected.")
    left, right = inputs[0], inputs[1]
    keys = [k for k in (params.get("keys") or []) if k.get("left") and k.get("right")]
    if not keys:
        raise NodeError("Set at least one match key.")
    for k in keys:
        if k["left"] not in left.columns:
            raise NodeError(f"Left input has no column '{k['left']}'.")
        if k["right"] not in right.columns:
            raise NodeError(f"Right input has no column '{k['right']}'.")
    pairs = _pairs(left, right, keys, params)
    out_l = _pick(left, pairs["__li"])
    out_r = _pick(right, pairs["__ri"])
    # 양쪽에 같은 이름이 있으면 오른쪽에 _r (pandas merge 의 suffixes=("", "_r") 와 같은 규칙)
    out_r.columns = [f"{c}_r" if c in out_l.columns else c for c in out_r.columns]
    return pd.concat([out_l, out_r], axis=1)


def node_union(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if not inputs:
        raise NodeError("No input.")
    return pd.concat(inputs, ignore_index=True, sort=False)


def node_dataset(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    name = (params.get("name") or "").strip()
    if not name:
        raise NodeError("Select a dataset.")
    cols = [c for c in (params.get("columns") or []) if c]
    try:
        return load_dataset(ctx.db, name, cols or None)
    except KeyError as e:
        raise NodeError(str(e)) from e


def node_output(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    if not inputs:
        raise NodeError("No input is connected.")
    df = inputs[0]
    name = (params.get("name") or "").strip()
    if not name:
        raise NodeError("Set the output dataset name.")
    mode = params.get("mode") or "replace"
    keys = [k for k in (params.get("keys") or []) if k]
    if mode == "upsert":
        if not keys:
            raise NodeError("Upsert mode needs at least one key column.")
        missing = [k for k in keys if k not in df.columns]
        if missing:
            raise NodeError(f"Key columns missing from input: {', '.join(missing)}")
    if ctx.save:
        save_dataset(ctx.db, name, df, ctx.flow_id, ctx.current_node, mode=mode, keys=keys)
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
        raise NodeError("No input is connected.")
    df = inputs[0]
    name = (params.get("name") or "").strip()
    key = (params.get("product_key") or "").strip()
    resources = graph.parse_resources(params.get("resources") or "")
    fields = graph.parse_fields(params.get("fields") or "")
    mode = params.get("mode") or "replace"
    if not name:
        raise NodeError("Set the graph name.")
    if mode == "upsert" and not key:
        raise NodeError("Upsert mode needs the product key column.")
    missing = [c for c in [key] + [c for c, _ in resources] if c and c not in df.columns]
    if missing:
        raise NodeError(f"Columns missing from input: {', '.join(missing)}")
    if ctx.save and graph.enabled():
        try:
            graph.export_graph(name, df, key, resources, fields=fields, mode=mode)
        except graph.GraphError as e:
            raise NodeError(str(e)) from e
    return df


def node_cypher(ctx, params: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    """Neo4j 읽기 전용 Cypher 조회. 입력이 연결되면 $rows 로 전달."""
    from .. import graph

    query = (params.get("query") or "").strip()
    if not query:
        raise NodeError("Enter a Cypher query.")
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
