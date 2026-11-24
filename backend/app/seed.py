import logging
import threading

from sqlalchemy import select

from .capture.service import equipment_lock, run_capture
from .config import ROOT_DIR
from .db import SessionLocal
from .engine.flow import run_flow
from .models import Dashboard, Equipment, Flow, NodeType, Parser
from .seed_nodes import NODE_LIBRARY

log = logging.getLogger("prism.seed")
DEMO_LOG_DIR = ROOT_DIR / "demo" / "logs"


def ensure_node_library(db):
    existing = set(db.scalars(select(NodeType.key)))
    for spec in NODE_LIBRARY:
        if spec["key"] not in existing:
            db.add(NodeType(**{"inputs": 1, **spec}))
    db.commit()


BLADE_PARSER = '''def parse(path, ctx):
    df = pd.read_csv(path, encoding=ctx["encoding"])
    df.columns = [str(c).strip() for c in df.columns]
    df["_ts"] = pd.to_datetime(df["DateTime"])
    return df
'''

DRIVE_PARSER = '''import io


def parse(path, ctx):
    """'#Key=Value' 메타 헤더 + CSV 본문. 날짜/시간이 분리된 컬럼을 합쳐 _ts 생성."""
    meta, body = {}, []
    with open(path, encoding=ctx["encoding"]) as f:
        for line in f:
            if line.startswith("#"):
                k, _, v = line[1:].strip().partition("=")
                meta[k.strip()] = v.strip()
            else:
                body.append(line)
    df = pd.read_csv(io.StringIO("".join(body)))
    df.columns = [str(c).strip() for c in df.columns]
    df["_ts"] = pd.to_datetime(df["Date"] + " " + df["Time"], format="%Y/%m/%d %H:%M:%S")
    df["Machine"] = meta.get("Machine")
    df["Recipe"] = meta.get("Recipe")
    return df
'''

EOL_PARSER = '''def parse(path, ctx):
    """EOL 로그는 cp949 인코딩 (설비 설정의 인코딩 값 사용)."""
    df = pd.read_csv(path, encoding=ctx["encoding"])
    df["_ts"] = pd.to_datetime(df["검사시간"])
    return df
'''


def _node(nid, kind, label, x, y, params=None, node_type=None):
    data = {"kind": kind, "label": label, "params": params or {}}
    if node_type:
        data["nodeType"] = node_type
    return {"id": nid, "type": "op", "position": {"x": x, "y": y}, "data": data}


def _edge(src, dst, handle="in"):
    return {"id": f"e_{src}_{dst}_{handle}", "source": src, "target": dst, "sourceHandle": "out", "targetHandle": handle}


def seed_demo(db) -> bool:
    if db.scalar(select(Equipment.id).limit(1)) is not None:
        return False
    from .demo import generate

    generate(DEMO_LOG_DIR)
    base = DEMO_LOG_DIR.as_posix()

    p_blade = Parser(name="Blade 조립기 Parser", description="DateTime 컬럼 기반 CSV", code=BLADE_PARSER)
    p_drive = Parser(name="구동 검사기 Parser", description="#메타 헤더 + Date/Time 분리 컬럼", code=DRIVE_PARSER)
    p_eol = Parser(name="EOL Parser", description="cp949 한글 헤더", code=EOL_PARSER)
    db.add_all([p_blade, p_drive, p_eol])
    db.flush()

    common = dict(factory="평택 1공장", product="CM-A12", project="A12 양산", access_method="fs", lookback_days=3, capture_interval_sec=60)
    desc = "데모: 로컬 폴더 사용. 실제 운영 시 \\\\{ip}\\Log\\{date:%Y%m%d} 같은 UNC 경로나 FTP/SFTP/Agent 방식 사용"
    eqs = []
    for i in (1, 2):
        eqs.append(Equipment(name=f"Blade 조립기 #{i}", process="Blade 조립", ip=f"10.10.1.{10 + i}", parser_id=p_blade.id,
                             log_path=f"{base}/blade_{i:02d}/{{date:%Y%m%d}}", file_pattern="Blade_*.csv", description=desc, **common))
    for i in (1, 2, 3):
        eqs.append(Equipment(name=f"구동 검사기 #{i}", process="구동 검사", ip=f"10.10.2.{10 + i}", parser_id=p_drive.id,
                             log_path=f"{base}/drive_{i:02d}", file_pattern="DriveTest_{date:%Y%m%d}.csv", description=desc, **common))
    eqs.append(Equipment(name="EOL 설비 #1", process="EOL", ip="10.10.3.11", parser_id=p_eol.id, encoding="cp949",
                         log_path=f"{base}/eol_01", file_pattern="EOL_{date:%Y-%m-%d}.csv", description=desc, **common))
    db.add_all(eqs)
    db.flush()
    ids = {e.name: e.id for e in eqs}

    match_graph = {
        "nodes": [
            _node("blade", "source", "Blade 조립기", 40, 40, {"equipment_ids": [ids["Blade 조립기 #1"], ids["Blade 조립기 #2"]], "alias": "blade"}),
            _node("drive", "source", "구동 검사기", 40, 260, {"equipment_ids": [ids[f"구동 검사기 #{i}"] for i in (1, 2, 3)], "alias": "drive"}),
            _node("eol", "source", "EOL", 40, 480, {"equipment_ids": [ids["EOL 설비 #1"]], "alias": "eol"}),
            _node("m1", "match", "Tray ↔ QR 매칭", 380, 140, {
                "keys": [{"left": "blade.Tray No", "right": "drive.QRCODE"}, {"left": "blade.Tray Position", "right": "drive.Position No"}],
                "how": "left", "strategy": "nearest_after", "tolerance_hours": 12, "normalize": True}),
            _node("m2", "match", "VAID 매칭", 700, 300, {
                "keys": [{"left": "drive.VAID", "right": "eol.VAID"}], "how": "left", "strategy": "exact", "duplicates": "last", "normalize": True}),
            _node("out", "output", "제품 Trace 저장", 1000, 300, {"name": "product_trace"}),
        ],
        "edges": [_edge("blade", "m1", "left"), _edge("drive", "m1", "right"), _edge("m1", "m2", "left"), _edge("eol", "m2", "right"), _edge("m2", "out")],
    }
    f_match = Flow(name="제품 공정 Trace (Blade→구동→EOL)", kind="match", graph=match_graph, schedule_minutes=5,
                   description="트레이 재사용을 고려해 Tray No/Position 은 '이후 가장 가까운 시각'으로, VAID 는 정확히 매칭")

    keep = ["drive.VAID", "drive._ts", "blade._equipment", "drive._equipment", "blade.base_pin_x", "blade.base_pin_y",
            "blade.rotate_pin_x", "blade.rotate_pin_y", "drive.F14 Area", "eol.F1440 Area"]
    rename = "\n".join([
        "drive.VAID=VAID", "drive._ts=drive_time", "blade._equipment=blade_machine", "drive._equipment=drive_machine",
        "blade.base_pin_x=base_pin_x", "blade.base_pin_y=base_pin_y", "blade.rotate_pin_x=rotate_pin_x",
        "blade.rotate_pin_y=rotate_pin_y", "drive.F14 Area=F14 Area", "eol.F1440 Area=F1440 Area",
    ])
    pins = ["base_pin_x", "base_pin_y", "rotate_pin_x", "rotate_pin_y"]
    areas = ["F14 Area", "F1440 Area"]
    analysis_graph = {
        "nodes": [
            _node("ds", "dataset", "제품 Trace", 40, 200, {"name": "product_trace"}),
            _node("na", "custom", "EOL 완료 제품만", 300, 200, {"columns": ["eol.F1440 Area", "drive.F14 Area"], "how": "any"}, "dropna"),
            _node("sel", "custom", "분석 컬럼 정리", 560, 200, {"columns": keep, "rename": rename}, "select_columns"),
            _node("corr", "custom", "상관 행렬", 840, 20, {"columns": pins + areas, "method": "pearson", "format": "matrix"}, "correlation"),
            _node("reg", "custom", "선형 회귀", 840, 160, {"x_columns": pins, "y_columns": areas}, "regression"),
            _node("tb", "custom", "시간 구간(1h)", 840, 320, {"column": "drive_time", "freq": "h", "target": "hour"}, "time_bucket"),
            _node("agg", "custom", "시간별 평균", 1100, 320, {"group_by": ["hour"], "columns": areas, "func": "mean", "add_count": True}, "group_aggregate"),
            _node("o1", "output", "상관 행렬", 1140, 20, {"name": "pin_area_corr"}),
            _node("o2", "output", "회귀 요약", 1140, 160, {"name": "pin_area_regression"}),
            _node("o3", "output", "분석 데이터", 840, 480, {"name": "pin_area_data"}),
            _node("o4", "output", "시간별 추이", 1380, 320, {"name": "area_hourly_trend"}),
        ],
        "edges": [
            _edge("ds", "na", "in0"), _edge("na", "sel", "in0"), _edge("sel", "corr", "in0"), _edge("sel", "reg", "in0"),
            _edge("sel", "tb", "in0"), _edge("tb", "agg", "in0"), _edge("corr", "o1"), _edge("reg", "o2"),
            _edge("sel", "o3"), _edge("agg", "o4"),
        ],
    }
    f_an = Flow(name="핀 위치 ↔ Area 상관성 분석", kind="analysis", graph=analysis_graph, schedule_minutes=5,
                description="Blade base/rotate pin 위치와 구동검사 F14 Area, EOL F1440 Area 의 상관성")
    db.add_all([f_match, f_an])

    widgets = [
        {"i": "w1", "x": 0, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "추적 제품 수", "dataset": "product_trace", "stat": {"column": "drive.VAID", "agg": "count", "suffix": " ea"}},
        {"i": "w2", "x": 3, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "EOL 연결 제품", "dataset": "product_trace", "stat": {"column": "eol.VAID", "agg": "count", "suffix": " ea"}},
        {"i": "w3", "x": 6, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "평균 F14 Area", "dataset": "pin_area_data", "stat": {"column": "F14 Area", "agg": "mean", "decimals": 2}},
        {"i": "w4", "x": 9, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "평균 F1440 Area", "dataset": "pin_area_data", "stat": {"column": "F1440 Area", "agg": "mean", "decimals": 2}},
        {"i": "w5", "x": 0, "y": 3, "w": 5, "h": 9, "type": "chart", "title": "상관 행렬 (Pearson)", "dataset": "pin_area_corr", "chart": {"kind": "heatmap", "x": "variable", "y": []}},
        {"i": "w6", "x": 5, "y": 3, "w": 7, "h": 9, "type": "chart", "title": "base_pin_x vs F14 Area", "dataset": "pin_area_data", "chart": {"kind": "scatter", "x": "base_pin_x", "y": ["F14 Area"], "series": "blade_machine", "trendline": True}},
        {"i": "w7", "x": 0, "y": 12, "w": 6, "h": 8, "type": "chart", "title": "rotate_pin_x vs F1440 Area", "dataset": "pin_area_data", "chart": {"kind": "scatter", "x": "rotate_pin_x", "y": ["F1440 Area"], "trendline": True}},
        {"i": "w8", "x": 6, "y": 12, "w": 6, "h": 8, "type": "chart", "title": "시간별 평균 Area 추이", "dataset": "area_hourly_trend", "chart": {"kind": "line", "x": "hour", "y": ["F14 Area", "F1440 Area"]}},
        {"i": "w9", "x": 0, "y": 20, "w": 6, "h": 8, "type": "table", "title": "회귀 요약", "dataset": "pin_area_regression", "table": {"columns": [], "pageSize": 10}},
        {"i": "w10", "x": 6, "y": 20, "w": 6, "h": 8, "type": "chart", "title": "F14 Area 분포 (Blade 설비별)", "dataset": "pin_area_data", "chart": {"kind": "histogram", "x": "F14 Area", "y": [], "series": "blade_machine", "bins": 30}},
    ]
    db.add(Dashboard(name="핀 위치 ↔ Area 상관성", description="데모 대시보드", refresh_sec=60, layout={"widgets": widgets}))
    db.commit()
    return True


def _warm_up(eq_ids: list[int], flow_ids: list[int]):
    for i in eq_ids:
        if run_capture(i, "seed").get("status") == "busy":
            with equipment_lock(i):  # 스케줄러가 먼저 수집 중이면 끝날 때까지 대기
                pass
    for f in flow_ids:
        run_flow(f, "seed")
    log.info("demo warm-up finished")


def seed_all(demo: bool):
    with SessionLocal() as db:
        ensure_node_library(db)
        if demo and seed_demo(db):
            eq_ids = list(db.scalars(select(Equipment.id)))
            flow_ids = [f.id for f in db.scalars(select(Flow).order_by(Flow.kind.desc()))]  # match 먼저
            threading.Thread(target=_warm_up, args=(eq_ids, flow_ids), daemon=True).start()
