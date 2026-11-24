"""Neo4j 제품 계보 그래프 (선택 기능, PRISM_NEO4J_URI 설정 시 활성화).

관계형 DB 가 원본이고, Match 결과를 아래 모델로 복사해 다단계 연결 질의에 쓴다.

  (:Product {graph, id, keyed, label})-[:PASSED {order}]->(:Step {graph, product, stage, order, ts, equipment, ...필드})
  (:Step)-[:NEXT]->(:Step)                 공정 순서
  (:Step)-[:ON]->(:Equipment {graph, name})
  (:Step)-[:USES]->(:Resource {graph, kind, value})   트레이 등 여러 제품이 공유하는 자원
  (:PrismGraph {graph, product_key, resources, updated_at})  그래프 메타
"""

import math
import re
import threading
from datetime import datetime

import numpy as np
import pandas as pd

from .config import NEO4J_DATABASE, NEO4J_PASSWORD, NEO4J_URI, NEO4J_USER

BATCH = 500
OUTCOME_RE = re.compile(r"(judge|result|판정|status)$", re.I)
BAD_VALUES = {"NG", "FAIL", "FAILED", "불량", "REJECT"}

_driver = None
_lock = threading.Lock()


class GraphError(Exception):
    pass


def enabled() -> bool:
    return bool(NEO4J_URI)


def driver():
    global _driver
    if not enabled():
        raise GraphError("Neo4j 가 설정되지 않았습니다. 환경변수 PRISM_NEO4J_URI 를 지정하세요.")
    with _lock:
        if _driver is None:
            from neo4j import GraphDatabase

            _driver = GraphDatabase.driver(
                NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD) if NEO4J_PASSWORD else None, connection_timeout=5
            )
    return _driver


def close():
    global _driver
    with _lock:
        if _driver is not None:
            _driver.close()
            _driver = None


def _native(v):
    """Neo4j 시간 타입 등을 파이썬 기본 타입으로."""
    if hasattr(v, "to_native"):
        return v.to_native()
    if isinstance(v, dict):
        return {k: _native(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_native(x) for x in v]
    return v


def run_read(query: str, params: dict | None = None) -> list[dict]:
    from neo4j import READ_ACCESS
    from neo4j.exceptions import Neo4jError, ServiceUnavailable

    try:
        with driver().session(database=NEO4J_DATABASE, default_access_mode=READ_ACCESS) as s:
            return s.execute_read(lambda tx: [_native(r.data()) for r in tx.run(query, params or {})])
    except ServiceUnavailable as e:
        raise GraphError(f"Neo4j 에 연결할 수 없습니다 ({NEO4J_URI}): {e}") from e
    except Neo4jError as e:
        raise GraphError(f"Cypher 오류: {e.message}") from e


def status() -> dict:
    if not enabled():
        return {"enabled": False, "connected": False}
    try:
        info = driver().get_server_info()
        graphs = run_read(
            "MATCH (m:PrismGraph) OPTIONAL MATCH (p:Product {graph: m.graph}) "
            "RETURN m.graph AS graph, m.product_key AS product_key, m.resources AS resources, "
            "toString(m.updated_at) AS updated_at, count(p) AS products ORDER BY graph"
        )
        return {"enabled": True, "connected": True, "address": NEO4J_URI, "version": info.agent, "graphs": graphs}
    except Exception as e:
        return {"enabled": True, "connected": False, "address": NEO4J_URI, "error": str(e)}


# ---------------- export ----------------


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) else f
    if isinstance(v, pd.Timestamp):
        return None if pd.isna(v) else v.tz_localize(None).to_pydatetime() if v.tzinfo else v.to_pydatetime()
    if isinstance(v, (datetime, str, int)):
        return v
    if v is pd.NaT:
        return None
    return str(v)


def _key_text(v) -> str | None:
    v = _clean(v)
    if v is None:
        return None
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    t = str(v).strip()
    return t or None


def parse_resources(spec: str | list) -> list[tuple[str, str]]:
    """'blade.Tray No=Tray' 형식(줄 단위)을 [(컬럼, 자원종류)] 로. '=종류' 가 없으면 컬럼의 필드명을 종류로 쓴다."""
    lines = spec if isinstance(spec, list) else (spec or "").splitlines()
    out = []
    for line in lines:
        line = str(line).strip()
        if not line:
            continue
        col, _, kind = line.partition("=")
        col = col.strip()
        out.append((col, kind.strip() or col.split(".", 1)[-1]))
    return out


def build_products(df: pd.DataFrame, product_key: str, resources: list[tuple[str, str]]) -> list[dict]:
    cols = [str(c) for c in df.columns]
    stages: list[str] = []
    for c in cols:
        if "." in c:
            st = c.split(".", 1)[0]
            if st not in stages:
                stages.append(st)
    if not stages:
        raise GraphError("단계 접두어(alias.컬럼)가 있는 Match 결과가 필요합니다.")
    stage_cols = {st: [c for c in cols if c.startswith(st + ".")] for st in stages}
    records = df.to_dict("records")
    products = []
    for i, row in enumerate(records):
        steps = []
        for order, st in enumerate(stages):
            props = {}
            for c in stage_cols[st]:
                field = c.split(".", 1)[1]
                if field in ("_ts", "_equipment"):
                    continue
                v = _clean(row.get(c))
                if v is not None:
                    props[field] = v
            ts = _clean(row.get(f"{st}._ts"))
            eq = _key_text(row.get(f"{st}._equipment"))
            if ts is None and eq is None and not props:
                continue  # 이 공정에 도달하지 않은 제품
            res = []
            for col, kind in resources:
                if col.startswith(st + "."):
                    val = _key_text(row.get(col))
                    if val is not None:
                        res.append({"kind": kind, "value": val})
            steps.append({"stage": st, "order": order, "ts": ts, "equipment": eq, "props": props, "resources": res})
        if not steps:
            continue
        pid = _key_text(row.get(product_key)) if product_key else None
        label = pid or f"키 미부여 · {steps[0]['stage']} {steps[0]['ts'] or ''}".strip()
        products.append({"id": pid or f"row-{i + 1}", "keyed": pid is not None, "label": label, "steps": steps})
    return products


_SCHEMA = [
    "CREATE INDEX prism_product IF NOT EXISTS FOR (n:Product) ON (n.graph, n.id)",
    "CREATE INDEX prism_step IF NOT EXISTS FOR (n:Step) ON (n.graph)",
    "CREATE INDEX prism_equipment IF NOT EXISTS FOR (n:Equipment) ON (n.graph, n.name)",
    "CREATE INDEX prism_resource IF NOT EXISTS FOR (n:Resource) ON (n.graph, n.kind, n.value)",
    "CREATE INDEX prism_meta IF NOT EXISTS FOR (n:PrismGraph) ON (n.graph)",
]

_INSERT = """
UNWIND $rows AS r
CREATE (p:Product {graph: $g, id: r.id, keyed: r.keyed, label: r.label})
WITH p, r
UNWIND r.steps AS st
CREATE (s:Step)
SET s += st.props
SET s.graph = $g, s.product = r.id, s.stage = st.stage, s.order = st.order, s.ts = st.ts, s.equipment = st.equipment
CREATE (p)-[:PASSED {order: st.order}]->(s)
FOREACH (_ IN CASE WHEN st.equipment IS NULL THEN [] ELSE [1] END |
  MERGE (e:Equipment {graph: $g, name: st.equipment})
  CREATE (s)-[:ON]->(e))
FOREACH (rs IN st.resources |
  MERGE (x:Resource {graph: $g, kind: rs.kind, value: rs.value})
  CREATE (s)-[:USES]->(x))
"""

_LINK_NEXT = """
MATCH (p:Product {graph: $g})-[:PASSED]->(s:Step)
WITH p, s ORDER BY s.order
WITH p, collect(s) AS ss
FOREACH (i IN range(0, size(ss) - 2) |
  FOREACH (a IN [ss[i]] | FOREACH (b IN [ss[i + 1]] | CREATE (a)-[:NEXT]->(b))))
"""


_export_locks: dict[str, threading.Lock] = {}


def export_graph(name: str, df: pd.DataFrame, product_key: str, resources: list[tuple[str, str]]) -> dict:
    products = build_products(df, product_key, resources)
    # 스케줄 실행과 수동 실행이 겹치면 삭제/쓰기가 섞이므로 그래프별로 직렬화
    with _lock:
        lock = _export_locks.setdefault(name, threading.Lock())
    with lock:
        return _write_graph(name, products, product_key, resources)


def _write_graph(name: str, products: list[dict], product_key: str, resources: list[tuple[str, str]]) -> dict:
    from neo4j.exceptions import Neo4jError, ServiceUnavailable

    try:
        with driver().session(database=NEO4J_DATABASE) as s:
            for q in _SCHEMA:
                s.run(q).consume()
            for label in ("Step", "Product", "Equipment", "Resource", "PrismGraph"):
                s.run(
                    f"MATCH (n:{label} {{graph: $g}}) CALL {{ WITH n DETACH DELETE n }} IN TRANSACTIONS OF 5000 ROWS",
                    g=name,
                ).consume()
            for i in range(0, len(products), BATCH):
                s.execute_write(lambda tx, rows=products[i : i + BATCH]: tx.run(_INSERT, rows=rows, g=name).consume())
            s.execute_write(lambda tx: tx.run(_LINK_NEXT, g=name).consume())
            s.execute_write(
                lambda tx: tx.run(
                    "CREATE (:PrismGraph {graph: $g, product_key: $k, resources: $r, updated_at: localdatetime()})",
                    g=name,
                    k=product_key,
                    r=[f"{c}={k}" for c, k in resources],
                ).consume()
            )
    except ServiceUnavailable as e:
        raise GraphError(f"Neo4j 에 연결할 수 없습니다 ({NEO4J_URI}): {e}") from e
    except Neo4jError as e:
        raise GraphError(f"Neo4j 저장 오류: {e.message}") from e
    return {"products": len(products), "steps": sum(len(p["steps"]) for p in products)}


# ---------------- queries ----------------

_REL_RESOURCE = """
MATCH (p:Product {graph: $g, id: $id})-[:PASSED]->(s:Step)-[:USES]->(r:Resource)<-[:USES]-(s2:Step)<-[:PASSED]-(p2:Product)
WHERE p2 <> p AND s.ts IS NOT NULL AND s2.ts IS NOT NULL
WITH p2, r, s2, duration.inSeconds(s.ts, s2.ts).seconds AS dt
WHERE abs(dt) <= $win
RETURN p2.id AS product, p2.label AS label, p2.keyed AS keyed, 'resource' AS via,
       r.kind AS kind, r.value AS value, s2.stage AS stage, s2.equipment AS equipment, dt
"""

_REL_EQUIPMENT = """
MATCH (p:Product {graph: $g, id: $id})-[:PASSED]->(s:Step)-[:ON]->(e:Equipment)<-[:ON]-(s2:Step)<-[:PASSED]-(p2:Product)
WHERE p2 <> p AND s.ts IS NOT NULL AND s2.ts IS NOT NULL
WITH p2, e, s2, duration.inSeconds(s.ts, s2.ts).seconds AS dt
WHERE abs(dt) <= $win
RETURN p2.id AS product, p2.label AS label, p2.keyed AS keyed, 'equipment' AS via,
       'Equipment' AS kind, e.name AS value, s2.stage AS stage, s2.equipment AS equipment, dt
"""

_OUTCOMES = """
MATCH (p:Product {graph: $g})-[:PASSED]->(s:Step) WHERE p.id IN $ids
RETURN p.id AS id, s.stage AS stage, properties(s) AS props
ORDER BY s.order
"""


def _outcomes(graph: str, ids: list[str]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {i: [] for i in ids}
    for i in range(0, len(ids), 2000):
        for r in run_read(_OUTCOMES, {"g": graph, "ids": ids[i : i + 2000]}):
            for k, v in r["props"].items():
                if OUTCOME_RE.search(k) and v is not None:
                    out[r["id"]].append({"stage": r["stage"], "field": k, "value": str(v), "bad": str(v).upper() in BAD_VALUES})
    return out


def _find_product(graph: str, pid: str) -> dict:
    rows = run_read("MATCH (p:Product {graph: $g, id: $id}) RETURN p.id AS id, p.label AS label", {"g": graph, "id": pid})
    if not rows:
        raise GraphError(f"그래프 '{graph}' 에 제품 '{pid}' 이 없습니다. Match Flow 를 실행해 그래프를 갱신하세요.")
    return rows[0]


def impact(graph: str, pid: str, hours: float, via: set[str], limit: int = 500) -> dict:
    """기준 제품과 같은 자원/설비를 ±hours 안에 공유한 제품 (영향 범위)."""
    origin = _find_product(graph, pid)
    params = {"g": graph, "id": pid, "win": int(hours * 3600)}
    rows = []
    if "resource" in via:
        rows += run_read(_REL_RESOURCE, params)
    if "equipment" in via:
        rows += run_read(_REL_EQUIPMENT, params)
    by: dict[str, dict] = {}
    for r in rows:
        p = by.setdefault(r["product"], {"product": r["product"], "label": r["label"], "keyed": r["keyed"], "reasons": {}, "min_dt": None})
        # 기준 제품의 여러 공정이 같은 자원을 쓰면 같은 사유가 반복되므로 (근거, 공정) 단위로 가장 가까운 시각만 남김
        key = (r["via"], r["kind"], r["value"], r["stage"])
        prev = p["reasons"].get(key)
        if prev is None or abs(r["dt"]) < abs(prev["dt"]):
            p["reasons"][key] = {k: r[k] for k in ("via", "kind", "value", "stage", "equipment", "dt")}
        adt = abs(r["dt"])
        p["min_dt"] = adt if p["min_dt"] is None else min(p["min_dt"], adt)
    items = list(by.values())
    for p in items:
        p["reasons"] = sorted(p["reasons"].values(), key=lambda x: (x["via"] != "resource", abs(x["dt"])))
    for p in items:
        p["shared_resource"] = any(x["via"] == "resource" for x in p["reasons"])
    items.sort(key=lambda p: (not p["shared_resource"], -len(p["reasons"]), p["min_dt"] or 0))
    by_resource = sum(1 for p in items if p["shared_resource"])
    by_equipment = sum(1 for p in items if any(x["via"] == "equipment" for x in p["reasons"]))
    items = items[:limit]
    outs = _outcomes(graph, [origin["id"]] + [p["product"] for p in items])
    for p in items:
        p["outcomes"] = outs.get(p["product"], [])
        p["bad"] = any(o["bad"] for o in p["outcomes"])
    return {
        "origin": {**origin, "outcomes": outs.get(origin["id"], [])},
        "hours": hours,
        "total": len(by),
        "shown": len(items),
        "by_resource": by_resource,
        "by_equipment": by_equipment,
        "bad": sum(1 for p in items if p["bad"]),
        "items": items,
    }


def product_graph(graph: str, pid: str, hours: float, max_related: int = 14) -> dict:
    """기준 제품의 공정 경로 + 공유 자원으로 이어진 연관 제품 (시각화용 노드/엣지)."""
    origin = _find_product(graph, pid)
    steps = run_read(
        """
        MATCH (p:Product {graph: $g, id: $id})-[:PASSED]->(s:Step)
        OPTIONAL MATCH (s)-[:USES]->(r:Resource)
        RETURN s.stage AS stage, s.order AS ord, toString(s.ts) AS ts, s.equipment AS equipment,
               collect(DISTINCT {kind: r.kind, value: r.value}) AS resources
        ORDER BY ord
        """,
        {"g": graph, "id": pid},
    )
    nodes: dict[str, dict] = {}
    edges: list[dict] = []

    def node(nid, name, cat, **extra):
        nodes.setdefault(nid, {"id": nid, "name": name, "category": cat, **extra})

    node(f"p:{pid}", origin["label"], "product", product=pid)
    prev = None
    for st in steps:
        sid = f"s:{st['stage']}"
        node(sid, st["stage"], "step", ts=st["ts"], equipment=st["equipment"])
        edges.append({"source": prev or f"p:{pid}", "target": sid, "label": "NEXT" if prev else "PASSED"})
        prev = sid
        if st["equipment"]:
            eid = f"e:{st['equipment']}"
            node(eid, st["equipment"], "equipment")
            edges.append({"source": sid, "target": eid, "label": "ON"})
        for r in st["resources"]:
            if r.get("value") is None:
                continue
            rid = f"r:{r['kind']}:{r['value']}"
            node(rid, f"{r['kind']} {r['value']}", "resource")
            edges.append({"source": sid, "target": rid, "label": "USES"})

    rel = impact(graph, pid, hours, {"resource", "equipment"}, limit=max_related)
    for p in rel["items"]:
        node(f"p:{p['product']}", p["label"], "bad" if p["bad"] else "related", product=p["product"] if p["keyed"] else None)
        for x in p["reasons"]:
            target = f"r:{x['kind']}:{x['value']}" if x["via"] == "resource" else f"e:{x['value']}"
            if target in nodes:
                edges.append({"source": f"p:{p['product']}", "target": target, "label": "공유"})
    seen, uniq = set(), []
    for e in edges:
        k = (e["source"], e["target"])
        if k not in seen:
            seen.add(k)
            uniq.append(e)
    return {"nodes": list(nodes.values()), "edges": uniq, "related_total": rel["total"]}
