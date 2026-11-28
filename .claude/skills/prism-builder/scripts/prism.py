"""PRISM API helper for the prism-builder skill (Python standard library only — works on closed networks).

    python .claude/skills/prism-builder/scripts/prism.py <command> [args]

Read
  summary                                   equipment, datasets, flows, dashboards, node library (compact)
  fields <equipment_id> [--grep RE]         field (column) names captured from one piece of equipment
  sample <equipment_id> [--columns a,b] [--grep RE] [--rows N]
                                            latest records, only the chosen columns
  dataset <name> [--columns a,b] [--grep RE] [--rows N]
                                            dataset columns (with types) and sample rows
  get <api-path>                            any GET, e.g. get /api/flows/3

Check before saving
  preview <graph.json> <node_id> [--rows N] run an unsaved flow graph up to one node (match rate, columns)
  check-dashboard <dashboard.json>          every widget's dataset/columns exist

Write (create only — this helper never deletes)
  create-flow <flow.json>                   POST /api/flows   (refuses if an output dataset name belongs to another flow)
  update-flow <id> <flow.json>              PUT  /api/flows/<id>
  run-flow <id>                             run a saved flow and show its outputs
  create-dashboard <dashboard.json>         POST /api/dashboards (runs check-dashboard first)
  update-dashboard <id> <dashboard.json>    PUT  /api/dashboards/<id>

Server: $PRISM_API (default http://127.0.0.1:8000). Output is trimmed so it stays readable.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("PRISM_API", "http://127.0.0.1:8000").rstrip("/")
MAX_OUT = 16000

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass


class ApiError(Exception):
    pass


def call(method: str, path: str, body=None, timeout: float = 600):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            text = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("detail", detail)
        except Exception:
            pass
        raise ApiError(f"{method} {path} -> HTTP {e.code}: {detail}") from None
    except urllib.error.URLError as e:
        raise ApiError(f"Cannot reach PRISM at {API}: {e.reason}") from None
    return json.loads(text) if text else None


def q(s: str) -> str:
    return urllib.parse.quote(s, safe="")


def out(obj):
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, indent=1, default=str)
    if len(text) > MAX_OUT:
        text = text[:MAX_OUT] + f"\n… (trimmed, {len(text):,} chars total — narrow it with --columns/--grep)"
    print(text)


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pick(names: list[str], columns: str | None, grep: str | None, default_max: int = 40) -> list[str]:
    if columns:
        want = [c.strip() for c in columns.split(",") if c.strip()]
        return [c for c in want if c in names]
    if grep:
        rx = re.compile(grep, re.I)
        return [c for c in names if rx.search(c)]
    return names[:default_max]


def table(payload: dict, cols: list[str], rows: int) -> dict:
    idx = {c["name"]: i for i, c in enumerate(payload["columns"])}
    return {
        "row_count": payload.get("row_count"),
        "columns": [{"name": c, "dtype": payload["columns"][idx[c]]["dtype"]} for c in cols if c in idx],
        "rows": [[r[idx[c]] for c in cols if c in idx] for r in payload["rows"][:rows]],
    }


# ---------- commands ----------


def cmd_summary(a):
    eqs = call("GET", "/api/equipment")
    ds = call("GET", "/api/datasets")
    flows = call("GET", "/api/flows")
    dashes = call("GET", "/api/dashboards")
    nodes = call("GET", "/api/node-types")
    out({
        "equipment": [
            {"id": e["id"], "name": e["name"], "process": e["process"], "product": e["product"], "records": e.get("record_count"), "enabled": e["enabled"], "parser": e.get("parser_name")}
            for e in eqs
        ],
        "datasets": [{"name": d["name"], "rows": d["row_count"], "columns": len(d["columns"]), "made_by_flow": d.get("flow_name")} for d in ds],
        "flows": [{"id": f["id"], "kind": f["kind"], "name": f["name"], "outputs": f.get("outputs"), "last_status": f.get("last_status")} for f in flows],
        "dashboards": [{"id": d["id"], "name": d["name"], "widgets": d.get("widget_count")} for d in dashes],
        "node_library": [{"key": n["key"], "name": n["name"], "inputs": n["inputs"], "params": [p["name"] for p in n["params"]]} for n in nodes],
    })


def cmd_fields(a):
    names = call("GET", f"/api/equipment/{a.equipment_id}/fields")
    sel = pick(names, None, a.grep, default_max=10**9)
    out({"equipment_id": a.equipment_id, "field_count": len(names), "shown": len(sel), "fields": sel[:600]})


def cmd_sample(a):
    payload = call("GET", f"/api/equipment/{a.equipment_id}/records?limit={max(1, a.rows)}")
    names = [c["name"] for c in payload["columns"]]
    out(table(payload, pick(names, a.columns, a.grep), a.rows))


def cmd_dataset(a):
    meta = next((d for d in call("GET", "/api/datasets") if d["name"] == a.name), None)
    if not meta:
        raise ApiError(f"No dataset named '{a.name}'.")
    names = [c["name"] for c in meta["columns"]]
    cols = pick(names, a.columns, a.grep)
    payload = call("GET", f"/api/datasets/{q(a.name)}/data?limit={max(1, a.rows)}&columns={q(','.join(cols))}")
    res = table(payload, cols, a.rows)
    res.update({"dataset": a.name, "total_columns": len(names), "made_by_flow": meta.get("flow_name")})
    out(res)


def api_path(p: str) -> str:
    """'api/flows/3', '/api/flows/3', 'flows/3' 모두 허용. Git Bash 가 '/api/...' 를 'C:/Program Files/Git/api/...' 로
    바꿔 넘기는 경우도 되돌린다."""
    p = p.replace("\\", "/")
    i = p.find("api/")
    p = p[i:] if i >= 0 else "api/" + p.lstrip("/")
    return "/" + p


def cmd_get(a):
    out(call("GET", api_path(a.path)))


def cmd_preview(a):
    flow = load_json(a.file)
    graph = flow.get("graph", flow)
    res = call("POST", "/api/flows/preview", {"graph": graph, "target": a.node_id, "limit": max(1, a.rows)})
    # 노드별 행 수 — 매칭 전후 행 수를 비교하면 매칭률을 알 수 있다
    nodes = {nid: {k: v for k, v in s.items() if k in ("status", "rows", "error")} for nid, s in (res.get("nodes") or {}).items()}
    data = res.get("preview")
    if not data:
        out({"target": a.node_id, "nodes": nodes, "note": "no preview — see the failing node above"})
        return
    cols = [c["name"] for c in data.get("columns", [])]
    summary = table(data, pick(cols, a.columns, a.grep), a.rows)
    summary.update({"target": a.node_id, "total_columns": len(cols), "nodes": nodes})
    out(summary)


def _flow_output_conflicts(flow: dict, flow_id: int | None) -> list[str]:
    owners = {d["name"]: (d.get("flow_id"), d.get("flow_name")) for d in call("GET", "/api/datasets")}
    bad = []
    for n in flow.get("graph", {}).get("nodes", []):
        d = n.get("data") or {}
        if d.get("kind") == "output":
            name = ((d.get("params") or {}).get("name") or "").strip()
            if not name:
                bad.append(f"output node '{n.get('id')}' has no dataset name")
            elif name in owners and owners[name][0] not in (None, flow_id):
                bad.append(f"dataset '{name}' already belongs to flow '{owners[name][1]}' — pick another name")
    return bad


def cmd_create_flow(a):
    flow = load_json(a.file)
    if flow.get("kind") not in ("match", "analysis"):
        raise ApiError("flow.kind must be 'match' or 'analysis'.")
    names = {(f["name"], f["kind"]) for f in call("GET", "/api/flows")}
    if (flow.get("name"), flow.get("kind")) in names:
        raise ApiError(f"A {flow['kind']} flow named '{flow['name']}' already exists — pick another name (this helper does not overwrite).")
    bad = _flow_output_conflicts(flow, None)
    if bad:
        raise ApiError("; ".join(bad))
    flow.setdefault("schedule_minutes", 0)
    f = call("POST", "/api/flows", flow)
    out({"created_flow": {"id": f["id"], "kind": f["kind"], "name": f["name"], "url": f"/{f['kind']}/{f['id']}"}})


def cmd_update_flow(a):
    flow = load_json(a.file)
    bad = _flow_output_conflicts(flow, a.id)
    if bad:
        raise ApiError("; ".join(bad))
    f = call("PUT", f"/api/flows/{a.id}", flow)
    out({"updated_flow": {"id": f["id"], "name": f["name"]}})


def cmd_run_flow(a):
    r = call("POST", f"/api/flows/{a.id}/run", timeout=1800)
    f = call("GET", f"/api/flows/{a.id}")
    outputs = [((n.get("data") or {}).get("params") or {}).get("name") for n in f["graph"]["nodes"] if (n.get("data") or {}).get("kind") == "output"]
    ds = {d["name"]: d for d in call("GET", "/api/datasets")}
    out({
        "status": r.get("status") if isinstance(r, dict) else r,
        "error": (r.get("error") if isinstance(r, dict) else None) or f.get("last_error") or None,
        "nodes": {nid: {k: v for k, v in s.items() if k in ("status", "rows", "error")} for nid, s in ((r or {}).get("nodes") or {}).items()},
        "outputs": [{"dataset": n, "rows": ds[n]["row_count"], "columns": len(ds[n]["columns"])} if n in ds else {"dataset": n, "missing": True} for n in outputs],
    })


WIDGET_COLUMN_FIELDS = (("chart", ("x", "series", "tip", "z")), ("stat", ("column",)), ("select", ("column",)))


def check_dashboard(dash: dict) -> list[str]:
    ds = {d["name"]: {c["name"] for c in d["columns"]} for d in call("GET", "/api/datasets")}
    params = {(w.get("control") or {}).get("paramId") for w in dash.get("layout", {}).get("widgets", []) if w.get("type") == "control"}
    problems = []
    ids = set()
    for w in dash.get("layout", {}).get("widgets", []):
        wid = w.get("i")
        if not wid or wid in ids:
            problems.append(f"widget '{w.get('title')}' needs a unique 'i'")
        ids.add(wid)
        for k in ("x", "y", "w", "h"):
            if not isinstance(w.get(k), int):
                problems.append(f"widget {wid}: '{k}' must be an integer")
        if w.get("type") in ("text", "control"):
            continue
        name = w.get("dataset")
        if name not in ds:
            problems.append(f"widget {wid}: dataset '{name}' does not exist (run the flow that makes it first)")
            continue
        cols = set(ds[name])
        used = []
        for part, fields in WIDGET_COLUMN_FIELDS:
            used += [(w.get(part) or {}).get(f) for f in fields]
        used += (w.get("chart") or {}).get("y") or []
        used += (w.get("table") or {}).get("columns") or []
        for c in used:
            if not c:
                continue
            if c.startswith("$"):
                if c[1:] not in params:
                    problems.append(f"widget {wid}: parameter '{c}' has no control widget")
            elif c not in cols:
                problems.append(f"widget {wid}: column '{c}' is not in dataset '{name}'")
    return problems


def cmd_check_dashboard(a):
    problems = check_dashboard(load_json(a.file))
    out({"ok": not problems, "problems": problems})


def cmd_create_dashboard(a):
    dash = load_json(a.file)
    problems = check_dashboard(dash)
    if problems:
        raise ApiError("dashboard check failed:\n  - " + "\n  - ".join(problems))
    if any(d["name"] == dash.get("name") for d in call("GET", "/api/dashboards")):
        raise ApiError(f"A dashboard named '{dash.get('name')}' already exists — pick another name.")
    d = call("POST", "/api/dashboards", dash)
    out({"created_dashboard": {"id": d["id"], "name": d["name"], "url": f"/dashboards/{d['id']}"}})


def cmd_update_dashboard(a):
    dash = load_json(a.file)
    problems = check_dashboard(dash)
    if problems:
        raise ApiError("dashboard check failed:\n  - " + "\n  - ".join(problems))
    d = call("PUT", f"/api/dashboards/{a.id}", dash)
    out({"updated_dashboard": {"id": d["id"], "name": d["name"]}})


def main(argv=None):
    p = argparse.ArgumentParser(prog="prism.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("summary").set_defaults(fn=cmd_summary)
    x = s.add_parser("fields"); x.add_argument("equipment_id", type=int); x.add_argument("--grep"); x.set_defaults(fn=cmd_fields)  # noqa: E702
    for name, fn, arg, typ in (("sample", cmd_sample, "equipment_id", int), ("dataset", cmd_dataset, "name", str)):
        x = s.add_parser(name)
        x.add_argument(arg, type=typ)
        x.add_argument("--columns")
        x.add_argument("--grep")
        x.add_argument("--rows", type=int, default=5)
        x.set_defaults(fn=fn)
    x = s.add_parser("get"); x.add_argument("path"); x.set_defaults(fn=cmd_get)  # noqa: E702
    x = s.add_parser("preview"); x.add_argument("file"); x.add_argument("node_id"); x.add_argument("--rows", type=int, default=5)  # noqa: E702
    x.add_argument("--columns"); x.add_argument("--grep"); x.set_defaults(fn=cmd_preview)  # noqa: E702
    x = s.add_parser("check-dashboard"); x.add_argument("file"); x.set_defaults(fn=cmd_check_dashboard)  # noqa: E702
    x = s.add_parser("create-flow"); x.add_argument("file"); x.set_defaults(fn=cmd_create_flow)  # noqa: E702
    x = s.add_parser("update-flow"); x.add_argument("id", type=int); x.add_argument("file"); x.set_defaults(fn=cmd_update_flow)  # noqa: E702
    x = s.add_parser("run-flow"); x.add_argument("id", type=int); x.set_defaults(fn=cmd_run_flow)  # noqa: E702
    x = s.add_parser("create-dashboard"); x.add_argument("file"); x.set_defaults(fn=cmd_create_dashboard)  # noqa: E702
    x = s.add_parser("update-dashboard"); x.add_argument("id", type=int); x.add_argument("file"); x.set_defaults(fn=cmd_update_dashboard)  # noqa: E702
    a = p.parse_args(argv)
    try:
        a.fn(a)
    except ApiError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
