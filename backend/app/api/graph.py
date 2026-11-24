from fastapi import APIRouter, HTTPException

from .. import graph

router = APIRouter(prefix="/api/graph", tags=["graph"])


def _call(fn, *args):
    try:
        return fn(*args)
    except graph.GraphError as e:
        raise HTTPException(400, str(e)) from e


@router.get("/status")
def status():
    return graph.status()


@router.get("/impact")
def impact(graph_name: str, product: str, hours: float = 4, via: str = "resource,equipment", limit: int = 500):
    return _call(graph.impact, graph_name, product, hours, {v for v in via.split(",") if v}, limit)


@router.get("/product")
def product(graph_name: str, product: str, hours: float = 4):
    return _call(graph.product_graph, graph_name, product, hours)
