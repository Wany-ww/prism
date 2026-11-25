import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..engine.flow import preview, run_flow
from ..models import Flow, NodeType
from .common import get_or_404, json_download, row_dict

router = APIRouter(prefix="/api", tags=["flows"])


# ---------- Node library (사용자 정의 Python 노드) ----------

NODE_TEMPLATE = '''def run(inputs, params):
    """
    inputs : 연결된 입력 DataFrame 리스트 (inputs[0], inputs[1], ...)
    params : 노드 설정값 dict (아래 '파라미터' 정의에 따라 GUI 폼이 자동 생성됨)
    return : DataFrame (또는 list[dict] / dict)
    """
    df = inputs[0]
    return df
'''


class NodeTypeIn(BaseModel):
    key: str
    name: str
    category: str = "Transform"
    description: str = ""
    color: str = "#722ed1"
    inputs: int = 1
    params: list = Field(default_factory=list)
    code: str = ""


def _check_key(key: str):
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_\-]{1,60}", key):
        raise HTTPException(400, "key must start with a letter and contain only letters, digits, _ or -.")


@router.get("/node-types/template")
def node_template():
    return {"code": NODE_TEMPLATE}


@router.get("/node-types")
def list_node_types(db: Session = Depends(get_db)):
    return [row_dict(n) for n in db.scalars(select(NodeType).order_by(NodeType.category, NodeType.name))]


@router.post("/node-types")
def create_node_type(body: NodeTypeIn, db: Session = Depends(get_db)):
    _check_key(body.key)
    if db.scalar(select(NodeType).where(NodeType.key == body.key)):
        raise HTTPException(409, "A node with the same key already exists.")
    n = NodeType(**body.model_dump())
    n.code = n.code or NODE_TEMPLATE
    db.add(n)
    db.commit()
    return row_dict(n)


@router.put("/node-types/{nid}")
def update_node_type(nid: int, body: NodeTypeIn, db: Session = Depends(get_db)):
    n = get_or_404(db, NodeType, nid)
    _check_key(body.key)
    if db.scalar(select(NodeType).where(NodeType.key == body.key, NodeType.id != nid)):
        raise HTTPException(409, "A node with the same key already exists.")
    for k, v in body.model_dump().items():
        setattr(n, k, v)
    db.commit()
    return row_dict(n)


@router.delete("/node-types/{nid}")
def delete_node_type(nid: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, NodeType, nid))
    db.commit()
    return {"ok": True}


# ---------- Flows (Match / Analysis) ----------


class FlowIn(BaseModel):
    name: str
    kind: str = "analysis"
    description: str = ""
    graph: dict = Field(default_factory=lambda: {"nodes": [], "edges": []})
    schedule_minutes: int = 0


class PreviewIn(BaseModel):
    graph: dict
    target: str
    limit: int = 200


def _output_names(graph: dict) -> list[str]:
    return [
        (n.get("data", {}).get("params") or {}).get("name")
        for n in graph.get("nodes", [])
        if n.get("data", {}).get("kind") == "output"
    ]


def flow_summary(f: Flow) -> dict:
    d = row_dict(f, exclude=("graph",))
    nodes = (f.graph or {}).get("nodes", [])
    d["node_count"] = len(nodes)
    d["outputs"] = [n for n in _output_names(f.graph or {}) if n]
    return d


@router.get("/flows")
def list_flows(kind: str | None = None, db: Session = Depends(get_db)):
    q = select(Flow).order_by(Flow.kind, Flow.name)
    if kind:
        q = q.where(Flow.kind == kind)
    return [flow_summary(f) for f in db.scalars(q)]


@router.get("/flows/{fid}")
def get_flow(fid: int, db: Session = Depends(get_db)):
    return row_dict(get_or_404(db, Flow, fid))


@router.post("/flows")
def create_flow(body: FlowIn, db: Session = Depends(get_db)):
    f = Flow(**body.model_dump())
    db.add(f)
    db.commit()
    return row_dict(f)


@router.put("/flows/{fid}")
def update_flow(fid: int, body: FlowIn, db: Session = Depends(get_db)):
    f = get_or_404(db, Flow, fid)
    for k, v in body.model_dump().items():
        setattr(f, k, v)
    f.next_run_at = None
    db.commit()
    return row_dict(f)


@router.post("/flows/{fid}/duplicate")
def duplicate_flow(fid: int, db: Session = Depends(get_db)):
    src = get_or_404(db, Flow, fid)
    f = Flow(name=src.name + " (copy)", kind=src.kind, description=src.description, graph=src.graph, schedule_minutes=0)
    db.add(f)
    db.commit()
    return row_dict(f)


@router.delete("/flows/{fid}")
def delete_flow(fid: int, db: Session = Depends(get_db)):
    db.delete(get_or_404(db, Flow, fid))
    db.commit()
    return {"ok": True}


@router.get("/flows/{fid}/export")
def export_flow(fid: int, db: Session = Depends(get_db)):
    """다른 PRISM 서버로 옮길 수 있게 Flow 정의를 .json 파일로 내려받음 (설비/데이터셋 id 가 아니라 이름으로 참조하므로,
    그대로 옮겨서는 못 쓸 수 있고 옮긴 뒤 설비 데이터 노드 등을 다시 확인해야 할 수 있음)."""
    f = get_or_404(db, Flow, fid)
    payload = {
        "_type": "prism-flow",
        "version": 1,
        "name": f.name,
        "kind": f.kind,
        "description": f.description,
        "schedule_minutes": f.schedule_minutes,
        "graph": f.graph,
    }
    return json_download(payload, f.name)


@router.post("/flows/import")
def import_flow(body: dict, db: Session = Depends(get_db)):
    if body.get("_type") != "prism-flow":
        raise HTTPException(400, "This file is not a PRISM flow export.")
    name = str(body.get("name") or "Imported flow").strip() or "Imported flow"
    kind = body.get("kind") if body.get("kind") in ("match", "analysis") else "analysis"
    graph = body.get("graph") if isinstance(body.get("graph"), dict) else {"nodes": [], "edges": []}
    # 자동 실행은 끈 채로 들여오기 — 옮긴 환경에 설비/데이터셋이 그대로 있는지 확인한 뒤 켜도록
    f = Flow(name=f"{name} (imported)", kind=kind, description=str(body.get("description") or ""), graph=graph, schedule_minutes=0)
    db.add(f)
    db.commit()
    return row_dict(f)


@router.post("/flows/preview")
def preview_flow(body: PreviewIn, db: Session = Depends(get_db)):
    """저장하지 않은 그래프를 target 노드까지 실행해 결과 미리보기."""
    return preview(db, body.graph, body.target, min(body.limit, 5000))


@router.post("/flows/{fid}/run")
def execute_flow(fid: int, db: Session = Depends(get_db)):
    get_or_404(db, Flow, fid)
    return run_flow(fid, "manual")
