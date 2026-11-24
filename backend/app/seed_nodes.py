"""기본 노드 라이브러리. DB에 없을 때만 생성되며 이후에는 GUI에서 자유롭게 수정/삭제 가능."""

NODE_LIBRARY = [
    {
        "key": "filter_rows",
        "name": "Filter rows",
        "category": "Transform",
        "color": "#3182f6",
        "description": "pandas query 식으로 행을 거릅니다. 공백/점이 있는 컬럼명은 `백틱`으로 감싸세요.",
        "params": [
            {"name": "expr", "label": "Condition", "type": "text", "default": "", "help": "예) `drive.Judge` == 'PASS' and `drive.F14 Area` > 85"},
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
        "name": "Select / rename columns",
        "category": "Transform",
        "color": "#3182f6",
        "description": "필요한 컬럼만 남기고 이름을 바꿉니다.",
        "params": [
            {"name": "columns", "label": "Columns to keep (empty = all)", "type": "columns", "default": []},
            {"name": "rename", "label": "Rename (one old=new per line)", "type": "text", "default": ""},
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
        "name": "Computed column",
        "category": "Transform",
        "color": "#3182f6",
        "description": "Python 식으로 새 컬럼을 만듭니다. df, pd, np 사용 가능.",
        "params": [
            {"name": "column", "label": "New column name", "type": "string", "default": "new_col"},
            {"name": "expr", "label": "Expression", "type": "text", "default": "", "help": 'df["eol.F1440 Area"] / df["drive.F14 Area"]'},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    df[params["column"]] = eval(params["expr"], {"df": df, "pd": pd, "np": np})
    return df
''',
    },
    {
        "key": "dropna",
        "name": "Drop missing",
        "category": "Transform",
        "color": "#3182f6",
        "description": "지정 컬럼에 빈 값이 있는 행을 제거합니다.",
        "params": [
            {"name": "columns", "label": "Columns to check (empty = all)", "type": "columns", "default": []},
            {"name": "how", "label": "Condition", "type": "select", "options": ["any", "all"], "default": "any"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0]
    cols = params.get("columns") or None
    return df.dropna(subset=cols, how=params.get("how") or "any")
''',
    },
    {
        "key": "to_numeric",
        "name": "To numeric",
        "category": "Transform",
        "color": "#3182f6",
        "description": "문자열 컬럼을 숫자로 변환합니다 (변환 불가 값은 빈 값).",
        "params": [{"name": "columns", "label": "Columns", "type": "columns", "default": []}],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    for c in params.get("columns") or []:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df
''',
    },
    {
        "key": "normalize_keys",
        "name": "Normalize keys",
        "category": "Match helpers",
        "color": "#18a5a5",
        "description": "매칭 전 키 값을 다듬습니다 (공백 제거, 대문자, 정규식 제거, 자릿수 맞춤).",
        "params": [
            {"name": "columns", "label": "Columns", "type": "columns", "default": []},
            {"name": "upper", "label": "Uppercase", "type": "boolean", "default": True},
            {"name": "remove", "label": "Regex to remove", "type": "string", "default": ""},
            {"name": "zfill", "label": "Zero-pad width", "type": "number", "default": 0},
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
        "name": "Sort / top N",
        "category": "Transform",
        "color": "#3182f6",
        "description": "컬럼 기준 정렬 후 상위 N행만 남깁니다 (N=0이면 전체).",
        "params": [
            {"name": "column", "label": "Sort column", "type": "column", "default": ""},
            {"name": "ascending", "label": "Ascending", "type": "boolean", "default": False},
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
        "name": "Time bucket",
        "category": "Transform",
        "color": "#3182f6",
        "description": "시간 컬럼을 구간(10분/시간/일)으로 내림해 새 컬럼을 만듭니다.",
        "params": [
            {"name": "column", "label": "Time column", "type": "column", "default": ""},
            {"name": "freq", "label": "Bucket", "type": "select", "options": ["10min", "30min", "h", "4h", "D"], "default": "h"},
            {"name": "target", "label": "New column name", "type": "string", "default": "bucket"},
        ],
        "code": '''def run(inputs, params):
    df = inputs[0].copy()
    df[params.get("target") or "bucket"] = pd.to_datetime(df[params["column"]], errors="coerce").dt.floor(params.get("freq") or "h")
    return df
''',
    },
    {
        "key": "group_aggregate",
        "name": "Group aggregate",
        "category": "Analysis",
        "color": "#fe9800",
        "description": "그룹별 통계(평균/합/개수 등). 그룹 없으면 전체 집계.",
        "params": [
            {"name": "group_by", "label": "Group by", "type": "columns", "default": []},
            {"name": "columns", "label": "Columns to aggregate (empty = all numeric)", "type": "columns", "default": []},
            {"name": "func", "label": "Function", "type": "select", "options": ["mean", "median", "sum", "min", "max", "std", "count"], "default": "mean"},
            {"name": "add_count", "label": "Add count column", "type": "boolean", "default": True},
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
        "name": "Correlation",
        "category": "Analysis",
        "color": "#fe9800",
        "description": "숫자 컬럼 간 상관계수 행렬 (heatmap 용 matrix 또는 long 형식).",
        "params": [
            {"name": "columns", "label": "Columns (empty = all numeric)", "type": "columns", "default": []},
            {"name": "method", "label": "Method", "type": "select", "options": ["pearson", "spearman"], "default": "pearson"},
            {"name": "format", "label": "Output format", "type": "select", "options": ["matrix", "long"], "default": "matrix"},
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
        "name": "Linear regression",
        "category": "Analysis",
        "color": "#fe9800",
        "description": "X 컬럼들 × Y 컬럼들 조합별 단순 선형회귀 (n, r, r², 기울기, 절편).",
        "params": [
            {"name": "x_columns", "label": "X (cause)", "type": "columns", "default": []},
            {"name": "y_columns", "label": "Y (effect)", "type": "columns", "default": []},
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
        "name": "Descriptive stats",
        "category": "Analysis",
        "color": "#fe9800",
        "description": "컬럼별 개수/평균/표준편차/분위수.",
        "params": [{"name": "columns", "label": "Columns (empty = all numeric)", "type": "columns", "default": []}],
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
        "name": "Remove outliers",
        "category": "Analysis",
        "color": "#fe9800",
        "description": "σ 또는 IQR 기준으로 이상치 행을 제거합니다.",
        "params": [
            {"name": "columns", "label": "Columns", "type": "columns", "default": []},
            {"name": "method", "label": "Method", "type": "select", "options": ["sigma", "iqr"], "default": "sigma"},
            {"name": "k", "label": "Multiplier (σ: 3, IQR: 1.5 suggested)", "type": "number", "default": 3},
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
        "name": "Join side by side",
        "category": "Transform",
        "color": "#3182f6",
        "inputs": 2,
        "description": "두 입력을 행 순서대로 좌우로 붙입니다.",
        "params": [],
        "code": '''def run(inputs, params):
    return pd.concat([i.reset_index(drop=True) for i in inputs], axis=1)
''',
    },
]

# 이전(한국어) 기본값 — 기존 DB 의 노드가 아직 이 값이면 영어 기본값으로 바꾼다 (seed.ensure_node_library)
LEGACY_KO = {'filter_rows': {'name': '행 필터', 'category': '변환', 'labels': {'expr': '조건식'}},
 'select_columns': {'name': '컬럼 선택/이름변경',
                    'category': '변환',
                    'labels': {'columns': '남길 컬럼 (비우면 전체)', 'rename': '이름 변경 (줄마다 원래이름=새이름)'}},
 'formula': {'name': '계산 컬럼', 'category': '변환', 'labels': {'column': '새 컬럼명', 'expr': '식'}},
 'dropna': {'name': '결측 제거', 'category': '변환', 'labels': {'columns': '검사 컬럼 (비우면 전체)', 'how': '조건'}},
 'to_numeric': {'name': '숫자 변환', 'category': '변환', 'labels': {'columns': '컬럼'}},
 'normalize_keys': {'name': '키 정규화',
                    'category': '매칭 보조',
                    'labels': {'columns': '컬럼', 'upper': '대문자 변환', 'remove': '제거할 정규식', 'zfill': '앞자리 0 채우기 길이'}},
 'sort_limit': {'name': '정렬/상위 N', 'category': '변환', 'labels': {'column': '정렬 컬럼', 'ascending': '오름차순'}},
 'time_bucket': {'name': '시간 구간', 'category': '변환', 'labels': {'column': '시간 컬럼', 'freq': '구간', 'target': '새 컬럼명'}},
 'group_aggregate': {'name': '그룹 집계',
                     'category': '분석',
                     'labels': {'group_by': '그룹 컬럼',
                                'columns': '집계 컬럼 (비우면 숫자 전체)',
                                'func': '함수',
                                'add_count': '건수 컬럼 추가'}},
 'correlation': {'name': '상관 분석',
                 'category': '분석',
                 'labels': {'columns': '컬럼 (비우면 숫자 전체)', 'method': '방법', 'format': '출력 형식'}},
 'regression': {'name': '선형 회귀', 'category': '분석', 'labels': {'x_columns': 'X (원인)', 'y_columns': 'Y (결과)'}},
 'describe': {'name': '기술 통계', 'category': '분석', 'labels': {'columns': '컬럼 (비우면 숫자 전체)'}},
 'outlier_filter': {'name': '이상치 제거',
                    'category': '분석',
                    'labels': {'columns': '컬럼', 'method': '방법', 'k': '배수 (σ: 3, IQR: 1.5 권장)'}},
 'concat_columns': {'name': '좌우 붙이기', 'category': '변환', 'labels': {}}}
