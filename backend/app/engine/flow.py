"""n8n 형태 그래프(React Flow JSON) 실행기.

graph = {"nodes": [{id, position, data: {kind, label, params, nodeType}}], "edges": [{source, target, targetHandle}]}
kind: source | match | union | dataset | output | python | custom
"""

import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import pandas as pd
from sqlalchemy import select

from ..db import SessionLocal
from ..models import Flow, NodeType
from .builtin import BUILTINS, NodeError
from .frames import columns_meta, frame_payload
from .usercode import UserCodeError, call_user, load_function, to_frame


@dataclass
class RunContext:
    db: object
    save: bool = False
    flow_id: int | None = None
    current_node: str = ""
    node_types: dict = field(default_factory=dict)


def _node_type(ctx: RunContext, key: str) -> NodeType:
    if key not in ctx.node_types:
        nt = ctx.db.scalar(select(NodeType).where(NodeType.key == key))
        if nt is None:
            raise NodeError(f"노드 타입 '{key}' 이 라이브러리에 없습니다.")
        ctx.node_types[key] = nt
    return ctx.node_types[key]


def _run_custom(ctx: RunContext, data: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    nt = _node_type(ctx, data.get("nodeType") or "")
    params = {p["name"]: p.get("default") for p in (nt.params or []) if p.get("name")}
    params.update({k: v for k, v in (data.get("params") or {}).items() if v is not None})
    label = f"node:{nt.key}"
    fn = load_function(nt.code, "run", label)
    return to_frame(call_user(fn, label, [i.copy() for i in inputs], params), label)


def run_node(ctx: RunContext, data: dict, inputs: list[pd.DataFrame]) -> pd.DataFrame:
    kind = data.get("kind")
    if kind == "custom":
        return _run_custom(ctx, data, inputs)
    fn = BUILTINS.get(kind)
    if fn is None:
        raise NodeError(f"알 수 없는 노드 종류: {kind}")
    return fn(ctx, data.get("params") or {}, inputs)


def _ancestors(target: str, incoming: dict) -> set[str]:
    seen, stack = {target}, [target]
    while stack:
        for e in incoming.get(stack.pop(), []):
            if e["source"] not in seen:
                seen.add(e["source"])
                stack.append(e["source"])
    return seen


def _topo(node_ids: set[str], edges: list[dict]) -> list[str]:
    indeg = {n: 0 for n in node_ids}
    out = defaultdict(list)
    for e in edges:
        if e["source"] in node_ids and e["target"] in node_ids:
            indeg[e["target"]] += 1
            out[e["source"]].append(e["target"])
    q = deque(sorted(n for n, d in indeg.items() if d == 0))
    order = []
    while q:
        n = q.popleft()
        order.append(n)
        for t in out[n]:
            indeg[t] -= 1
            if indeg[t] == 0:
                q.append(t)
    if len(order) != len(node_ids):
        raise NodeError("그래프에 순환 연결이 있습니다.")
    return order


def execute_graph(db, graph: dict, target: str | None = None, save: bool = False, flow_id: int | None = None):
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = [e for e in graph.get("edges", []) if e.get("source") in nodes and e.get("target") in nodes]
    incoming = defaultdict(list)
    for e in edges:
        incoming[e["target"]].append(e)
    needed = _ancestors(target, incoming) if target else set(nodes)
    ctx = RunContext(db=db, save=save, flow_id=flow_id)
    results: dict[str, pd.DataFrame] = {}
    status: dict[str, dict] = {}

    for nid in _topo(needed, edges):
        node = nodes[nid]
        data = node.get("data") or {}
        ins = sorted(
            incoming[nid],
            key=lambda e: (e.get("targetHandle") or "", nodes[e["source"]].get("position", {}).get("y", 0)),
        )
        if any(e["source"] not in results for e in ins):
            status[nid] = {"status": "skipped", "error": "상위 노드가 실패하여 실행하지 않았습니다."}
            continue
        if data.get("disabled"):
            results[nid] = results[ins[0]["source"]] if ins else pd.DataFrame()
            status[nid] = {"status": "disabled", "rows": len(results[nid]), "columns": columns_meta(results[nid])}
            continue
        ctx.current_node = nid
        t0 = time.perf_counter()
        try:
            df = run_node(ctx, data, [results[e["source"]] for e in ins])
            results[nid] = df
            status[nid] = {
                "status": "ok",
                "rows": int(len(df)),
                "columns": columns_meta(df),
                "ms": round((time.perf_counter() - t0) * 1000),
            }
        except UserCodeError as e:
            status[nid] = {"status": "error", "error": str(e), "detail": e.detail, "ms": round((time.perf_counter() - t0) * 1000)}
        except Exception as e:
            db.rollback()
            status[nid] = {"status": "error", "error": f"{type(e).__name__}: {e}" if not isinstance(e, NodeError) else str(e)}
    return results, status


def preview(db, graph: dict, target: str, limit: int = 200) -> dict:
    results, status = execute_graph(db, graph, target=target, save=False)
    out = {"nodes": status}
    if target in results:
        out["preview"] = frame_payload(results[target], limit)
    return out


def run_flow(flow_id: int, trigger: str = "manual") -> dict:
    with SessionLocal() as db:
        flow = db.get(Flow, flow_id)
        if flow is None:
            return {"status": "error", "error": "Flow 없음"}
        try:
            _, status = execute_graph(db, flow.graph or {}, save=True, flow_id=flow.id)
            errors = [f"{nid}: {s.get('error')}" for nid, s in status.items() if s["status"] == "error"]
            flow.last_status = "error" if errors else "ok"
            flow.last_error = "\n".join(errors)[:4000]
        except Exception as e:
            db.rollback()
            status = {}
            flow.last_status, flow.last_error = "error", str(e)
        flow.last_run_at = datetime.now()
        if flow.schedule_minutes:
            flow.next_run_at = flow.last_run_at + timedelta(minutes=flow.schedule_minutes)
        db.commit()
        return {"status": flow.last_status, "error": flow.last_error, "nodes": status}
