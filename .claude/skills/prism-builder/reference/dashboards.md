# Dashboard JSON

`create-dashboard` takes:

```json
{"name": "핀 위치 ↔ Area 상관성", "description": "one line", "refresh_sec": 60,
 "layout": {"widgets": [ ... ]}}
```

`refresh_sec` re-reads data every N seconds (0 = off). The slug (URL id) is generated from the name.

## Widget

```json
{"i": "w1", "x": 0, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "추적 제품 수", "dataset": "product_trace", ...type-specific...}
```

- `i`: unique id (`w1`, `w2`, …). Grid: 12 columns wide; `x`+`w` ≤ 12; `y`/`h` in rows of ~30 px. No overlaps — place row by row.
- Good sizes: stat 3×3 (four across), chart 6×8 or 12×8, heatmap 5×9, table 12×7 or 6×8.
- `dataset`: a dataset name; columns must exist in it (`check-dashboard` verifies).
- `limit` (optional): max rows read (default 50 000 for charts, 5 000 for tables).

## Types

### stat — one number
`"stat": {"column": "F14 Area", "agg": "mean", "decimals": 2, "suffix": " ea"}` — `agg`: `count`, `distinct`, `mean`, `sum`, `min`, `max`, `last`.

### chart
`"chart": {"kind": "...", "x": "...", "y": ["..."], ...}`

| kind | fields | use |
|---|---|---|
| `line`, `area`, `bar` | `x`, `y` (list), `series`, `agg` (`none`,`mean`,`sum`,`count`,`min`,`max`), `stack`, bar `sort` (`asc`/`desc`) | trends over time / categories |
| `scatter` | `x`, `y` (1), `series`, `tip` (column shown on hover, e.g. VAID), `trendline: true` | relation between two numbers |
| `xy` | `x`, `y` (1) as positions, `series`, `tip`, `spec`: `{"shape": "circle", "cx", "cy", "r"}` or `{"shape": "rect", "cx", "cy", "dx", "dy"}` | pin / part position vs. target and tolerance |
| `histogram` | `x` (value column), `bins`, `series`, `limits`: `{"lsl": 86, "usl": 104}` → Cp/Cpk | distribution, process capability |
| `box` | `x` (group, optional), `y` | spread by group |
| `heatmap` | `x` = row-label column (`variable` for correlation matrix output), `y` empty = all numeric | matrices |
| `pie` | `x` = category, `y` = [value] or empty for count | share |
| `scatter3d` | `x`, `y` (1), `z`, `series`, `tip` | three numbers at once |

### table
`"table": {"columns": ["VAID", "F14 Area"], "pageSize": 10}` (empty columns = all). Add `"select": {"column": "VAID"}` to let a row click filter the other widgets by that value.

### text
`"text": {"content": "How to read this dashboard …"}` — no dataset.

### control — dropdown / slider that swaps a column in other widgets
```json
{"i": "w9", "type": "control", "title": "Metric", "x": 0, "y": 20, "w": 4, "h": 4,
 "control": {"kind": "dropdown", "paramId": "metric", "options": [{"label": "F14 Area", "value": "F14 Area"}, {"label": "F1440 Area", "value": "F1440 Area"}]}}
```
Other widgets use `"$metric"` in place of a column name (e.g. `"x": "$metric"`).

## Linking
Widgets react to a table row selection by matching column names automatically. Set `"link": {"mode": "off"}` on KPI tiles and overview charts that should always show everything; `"link": {"mode": "column", "column": "drive.VAID"}` when the column name differs.

## Example

```json
{"name": "핀 위치 ↔ Area 상관성", "refresh_sec": 60, "layout": {"widgets": [
 {"i": "w1", "x": 0, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "추적 제품 수", "dataset": "product_trace", "stat": {"column": "drive.VAID", "agg": "count", "suffix": " ea"}, "link": {"mode": "off"}},
 {"i": "w2", "x": 3, "y": 0, "w": 3, "h": 3, "type": "stat", "title": "평균 F14 Area", "dataset": "pin_area_data", "stat": {"column": "F14 Area", "agg": "mean", "decimals": 2}, "link": {"mode": "off"}},
 {"i": "w3", "x": 0, "y": 3, "w": 5, "h": 9, "type": "chart", "title": "상관 행렬", "dataset": "pin_area_corr", "chart": {"kind": "heatmap", "x": "variable", "y": []}},
 {"i": "w4", "x": 5, "y": 3, "w": 7, "h": 9, "type": "chart", "title": "base_pin_x vs F14 Area", "dataset": "pin_area_data", "chart": {"kind": "scatter", "x": "base_pin_x", "y": ["F14 Area"], "series": "blade_machine", "tip": "VAID", "trendline": true}},
 {"i": "w5", "x": 0, "y": 12, "w": 12, "h": 8, "type": "table", "title": "제품 목록", "dataset": "pin_area_data", "table": {"columns": [], "pageSize": 10}, "select": {"column": "VAID"}}
]}}
```
