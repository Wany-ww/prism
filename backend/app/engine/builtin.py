"""시스템 내장 노드: source / match / union / dataset / output / python."""

from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from ..capture.store import load_records
from . import native
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


MATCH_STRATEGIES = ("exact", "nearest_after", "nearest_before", "nearest")


def _pairs(left: pd.DataFrame, right: pd.DataFrame, keys: list[dict], params: dict) -> tuple[np.ndarray, np.ndarray]:
    """키(+시각)만으로 짝을 찾아 (왼쪽 행 번호, 오른쪽 행 번호) 배열을 돌려줌. 짝이 없는 쪽은 -1.
    짝 찾기(키 정규화, exact 조인, 가장 가까운 시각 매칭)는 Rust 엔진이 하고, 수천 개 컬럼의 실제 데이터는
    마지막에 한 번만 조립한다. 행 순서는 예전 pandas merge / merge_asof 와 같다."""
    strategy = params.get("strategy", "exact")
    if strategy not in MATCH_STRATEGIES:
        raise NodeError(f"Unknown match strategy: {strategy}")
    lt = rt = tol = None
    if strategy != "exact":
        lt = native.time_payload(left[_ts_column(left, params.get("left_time"))])
        rt = native.time_payload(right[_ts_column(right, params.get("right_time"))])
        tol_h = float(params.get("tolerance_hours") or 0)
        tol = int(round(tol_h * 3600 * 1_000_000)) if tol_h > 0 else None
    try:
        return native.match_pairs(
            [native.key_payload(left[k["left"]]) for k in keys],
            [native.key_payload(right[k["right"]]) for k in keys],
            normalize=bool(params.get("normalize", True)),
            upper=bool(params.get("ignore_case", False)),
            how=params.get("how", "inner"),
            strategy=strategy,
            duplicates=params.get("duplicates", "all"),
            left_time=lt,
            right_time=rt,
            tolerance_us=tol,
        )
    except ValueError as e:
        raise NodeError(str(e)) from e


def _pick(df: pd.DataFrame, pos: np.ndarray) -> pd.DataFrame:
    """행 번호 목록대로 행을 꺼냄. -1(짝 없음)은 빈 행."""
    df = df.reset_index(drop=True)
    if len(pos) and pos.min() >= 0:
        return df.take(pos).reset_index(drop=True)
    return df.reindex(pos).reset_index(drop=True)


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
    li, ri = _pairs(left, right, keys, params)
    out_l = _pick(left, li)
    out_r = _pick(right, ri)
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
