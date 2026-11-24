"""기본 노드 라이브러리. DB에 없을 때만 생성되며 이후에는 GUI에서 자유롭게 수정/삭제 가능."""

NODE_LIBRARY = [
    {
        "key": "filter_rows",
        "name": "행 필터",
        "category": "변환",
        "color": "#3182f6",
        "description": "pandas query 식으로 행을 거릅니다. 공백/점이 있는 컬럼명은 `백틱`으로 감싸세요.",
        "params": [
            {"name": "expr", "label": "조건식", "type": "text", "default": "", "help": "예) `drive.Judge` == 'PASS' and `drive.F14 Area` > 85"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    expr = (params.get("expr") or "").strip()
    if not expr:
        return df
    return df.query(expr, engine="python")
''',
    },
    {
        "key": "select_columns",
        "name": "컬럼 선택/이름변경",
        "category": "변환",
        "color": "#3182f6",
        "description": "필요한 컬럼만 남기고 이름을 바꿉니다.",
        "params": [
            {"name": "columns", "label": "남길 컬럼 (비우면 전체)", "type": "columns", "default": []},
            {"name": "rename", "label": "이름 변경 (줄마다 원래이름=새이름)", "type": "text", "default": ""},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    cols = params.get("columns") or []
    if cols:
        df = df[[c for c in cols if c in df.columns]]
    mapping = {}
    for line in (params.get("rename") or "").splitlines():
        if "=" in line:
            src, dst = line.split("=", 1)
            mapping[src.strip()] = dst.strip()
    return df.rename(columns=mapping)
''',
    },
    {
        "key": "formula",
        "name": "계산 컬럼",
        "category": "변환",
        "color": "#3182f6",
        "description": "Python 식으로 새 컬럼을 만듭니다. df, pd, np 사용 가능.",
        "params": [
            {"name": "column", "label": "새 컬럼명", "type": "string", "default": "new_col"},
            {"name": "expr", "label": "식", "type": "text", "default": "", "help": 'df["eol.F1440 Area"] / df["drive.F14 Area"]'},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    df[params["column"]] = eval(params["expr"], {"df": df, "pd": pd, "np": np})
    return df
''',
    },
    {
        "key": "dropna",
        "name": "결측 제거",
        "category": "변환",
        "color": "#3182f6",
        "description": "지정 컬럼에 빈 값이 있는 행을 제거합니다.",
        "params": [
            {"name": "columns", "label": "검사 컬럼 (비우면 전체)", "type": "columns", "default": []},
            {"name": "how", "label": "조건", "type": "select", "options": ["any", "all"], "default": "any"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    cols = params.get("columns") or None
    return df.dropna(subset=cols, how=params.get("how") or "any")
''',
    },
    {
        "key": "to_numeric",
        "name": "숫자 변환",
        "category": "변환",
        "color": "#3182f6",
        "description": "문자열 컬럼을 숫자로 변환합니다 (변환 불가 값은 빈 값).",
        "params": [{"name": "columns", "label": "컬럼", "type": "columns", "default": []}],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    for c in params.get("columns") or []:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df
''',
    },
    {
        "key": "normalize_keys",
        "name": "키 정규화",
        "category": "매칭 보조",
        "color": "#18a5a5",
        "description": "매칭 전 키 값을 다듬습니다 (공백 제거, 대문자, 정규식 제거, 자릿수 맞춤).",
        "params": [
            {"name": "columns", "label": "컬럼", "type": "columns", "default": []},
            {"name": "upper", "label": "대문자 변환", "type": "boolean", "default": True},
            {"name": "remove", "label": "제거할 정규식", "type": "string", "default": ""},
            {"name": "zfill", "label": "앞자리 0 채우기 길이", "type": "number", "default": 0},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    for c in params.get("columns") or []:
        s = df[c].astype("string").str.strip()
        if params.get("upper"):
            s = s.str.upper()
        if params.get("remove"):
            s = s.str.replace(params["remove"], "", regex=True)
        if params.get("zfill"):
            s = s.str.zfill(int(params["zfill"]))
        df[c] = s
    return df
''',
    },
    {
        "key": "sort_limit",
        "name": "정렬/상위 N",
        "category": "변환",
        "color": "#3182f6",
        "description": "컬럼 기준 정렬 후 상위 N행만 남깁니다 (N=0이면 전체).",
        "params": [
            {"name": "column", "label": "정렬 컬럼", "type": "column", "default": ""},
            {"name": "ascending", "label": "오름차순", "type": "boolean", "default": False},
            {"name": "limit", "label": "N", "type": "number", "default": 0},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    if params.get("column"):
        df = df.sort_values(params["column"], ascending=bool(params.get("ascending")))
    n = int(params.get("limit") or 0)
    return df.head(n) if n > 0 else df
''',
    },
    {
        "key": "time_bucket",
        "name": "시간 구간",
        "category": "변환",
        "color": "#3182f6",
        "description": "시간 컬럼을 구간(10분/시간/일)으로 내림해 새 컬럼을 만듭니다.",
        "params": [
            {"name": "column", "label": "시간 컬럼", "type": "column", "default": ""},
            {"name": "freq", "label": "구간", "type": "select", "options": ["10min", "30min", "h", "4h", "D"], "default": "h"},
            {"name": "target", "label": "새 컬럼명", "type": "string", "default": "bucket"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    df[params.get("target") or "bucket"] = pd.to_datetime(df[params["column"]], errors="coerce").dt.floor(params.get("freq") or "h")
    return df
''',
    },
    {
        "key": "group_aggregate",
        "name": "그룹 집계",
        "category": "분석",
        "color": "#fe9800",
        "description": "그룹별 통계(평균/합/개수 등). 그룹 없으면 전체 집계.",
        "params": [
            {"name": "group_by", "label": "그룹 컬럼", "type": "columns", "default": []},
            {"name": "columns", "label": "집계 컬럼 (비우면 숫자 전체)", "type": "columns", "default": []},
            {"name": "func", "label": "함수", "type": "select", "options": ["mean", "median", "sum", "min", "max", "std", "count"], "default": "mean"},
            {"name": "add_count", "label": "건수 컬럼 추가", "type": "boolean", "default": True},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    by = params.get("group_by") or []
    cols = params.get("columns") or [c for c in df.select_dtypes("number").columns if c not in by]
    func = params.get("func") or "mean"
    if not by:
        out = df[cols].agg(func).to_frame().T
        if params.get("add_count"):
            out["count"] = len(df)
        return out
    g = df.groupby(by, dropna=False)
    out = g[cols].agg(func)
    if params.get("add_count"):
        out["count"] = g.size()
    return out.reset_index()
''',
    },
    {
        "key": "correlation",
        "name": "상관 분석",
        "category": "분석",
        "color": "#fe9800",
        "description": "숫자 컬럼 간 상관계수 행렬 (heatmap 용 matrix 또는 long 형식).",
        "params": [
            {"name": "columns", "label": "컬럼 (비우면 숫자 전체)", "type": "columns", "default": []},
            {"name": "method", "label": "방법", "type": "select", "options": ["pearson", "spearman"], "default": "pearson"},
            {"name": "format", "label": "출력 형식", "type": "select", "options": ["matrix", "long"], "default": "matrix"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    cols = params.get("columns") or list(df.select_dtypes("number").columns)
    corr = df[cols].apply(pd.to_numeric, errors="coerce").corr(method=params.get("method") or "pearson")
    if params.get("format") == "long":
        long = corr.stack().reset_index()
        long.columns = ["x", "y", "r"]
        return long
    corr.index.name = "variable"
    return corr.reset_index()
''',
    },
    {
        "key": "regression",
        "name": "선형 회귀",
        "category": "분석",
        "color": "#fe9800",
        "description": "X 컬럼들 × Y 컬럼들 조합별 단순 선형회귀 (n, r, r², 기울기, 절편).",
        "params": [
            {"name": "x_columns", "label": "X (원인)", "type": "columns", "default": []},
            {"name": "y_columns", "label": "Y (결과)", "type": "columns", "default": []},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    rows = []
    for y in params.get("y_columns") or []:
        for x in params.get("x_columns") or []:
            if x == y:
                continue
            d = df[[x, y]].apply(pd.to_numeric, errors="coerce").dropna()
            row = {"x": x, "y": y, "n": len(d)}
            if len(d) >= 3 and d[x].std() > 0:
                slope, intercept = np.polyfit(d[x], d[y], 1)
                r = d[x].corr(d[y])
                row.update(r=round(r, 4), r2=round(r * r, 4), slope=slope, intercept=intercept)
            rows.append(row)
    return pd.DataFrame(rows)
''',
    },
    {
        "key": "describe",
        "name": "기술 통계",
        "category": "분석",
        "color": "#fe9800",
        "description": "컬럼별 개수/평균/표준편차/분위수.",
        "params": [{"name": "columns", "label": "컬럼 (비우면 숫자 전체)", "type": "columns", "default": []}],
        "code": '''def run(inputs, params):
    df = inputs[0]
    cols = params.get("columns") or list(df.select_dtypes("number").columns)
    d = df[cols].apply(pd.to_numeric, errors="coerce").describe(percentiles=[0.05, 0.25, 0.5, 0.75, 0.95]).T
    d.index.name = "column"
    return d.reset_index()
''',
    },
    {
        "key": "outlier_filter",
        "name": "이상치 제거",
        "category": "분석",
        "color": "#fe9800",
        "description": "σ 또는 IQR 기준으로 이상치 행을 제거합니다.",
        "params": [
            {"name": "columns", "label": "컬럼", "type": "columns", "default": []},
            {"name": "method", "label": "방법", "type": "select", "options": ["sigma", "iqr"], "default": "sigma"},
            {"name": "k", "label": "배수 (σ: 3, IQR: 1.5 권장)", "type": "number", "default": 3},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    k = float(params.get("k") or 3)
    mask = pd.Series(True, index=df.index)
    for c in params.get("columns") or []:
        s = pd.to_numeric(df[c], errors="coerce")
        if params.get("method") == "iqr":
            q1, q3 = s.quantile(0.25), s.quantile(0.75)
            ok = s.between(q1 - k * (q3 - q1), q3 + k * (q3 - q1))
        else:
            ok = (s - s.mean()).abs() <= k * s.std()
        mask &= ok | s.isna()
    return df[mask]
''',
    },
    {
        "key": "concat_columns",
        "name": "좌우 붙이기",
        "category": "변환",
        "color": "#3182f6",
        "inputs": 2,
        "description": "두 입력을 행 순서대로 좌우로 붙입니다.",
        "params": [],
        "code": '''def run(inputs, params):
    return pd.concat([i.reset_index(drop=True) for i in inputs], axis=1)
''',
    },
]
