# Flow JSON

`create-flow` takes a whole flow:

```json
{
  "name": "제품 공정 Trace (Blade→구동→EOL)",
  "kind": "match",
  "description": "one line on what it links",
  "schedule_minutes": 0,
  "graph": { "nodes": [ ... ], "edges": [ ... ] }
}
```

`kind` is `match` (links raw equipment data) or `analysis` (works on datasets).

## Nodes and edges

```json
{ "id": "m1", "type": "op", "position": {"x": 360, "y": 40},
  "data": { "kind": "match", "label": "Tray ↔ QR", "params": { ... } } }

{ "id": "e_blade_m1", "source": "blade", "target": "m1", "sourceHandle": "out", "targetHandle": "left" }
```

- `id`: short, unique within the flow (`blade`, `m1`, `out`).
- `type` is always `"op"`. Lay nodes out left to right: x += 320 per step, y += 140 between parallel nodes.
- Every node has one output handle `"out"`. Input handles (`targetHandle`):

| kind | input handles |
|---|---|
| `source`, `dataset` | none |
| `match` | `left` (base — its rows are kept with how=left), `right` |
| `union` | `in` (several edges allowed) |
| `output`, `graph` | `in` |
| `custom`, `python` | `in0`, `in1`, … (one per input) |

## Built-in kinds

### source — raw records of equipment (match flows)
```json
{"kind": "source", "label": "Blade 조립기", "params": {"alias": "blade", "equipment_ids": [1, 2], "days": 7}}
```
- `equipment_ids`: ids from `summary`. Several machines of the same process go in one source.
- `alias`: prefixes every column → `blade.Tray No`, `blade._ts`, `blade._equipment`. Always set it in match flows.
- Optional: `days` (look-back window), `since` / `until` (ISO time), `columns` (field list — read only these; use it when equipment has thousands of fields).

### match — link two inputs
```json
{"kind": "match", "label": "Tray ↔ QR", "params": {
  "keys": [{"left": "blade.Tray No", "right": "drive.QRCODE"}, {"left": "blade.Tray Position", "right": "drive.Position No"}],
  "how": "left", "strategy": "nearest_after", "tolerance_hours": 12, "normalize": true}}
```
- `keys`: one or more column pairs that must all be equal.
- `how`: `left` (keep every left row; default choice for trace), `inner` (only matched — use it in preview to measure the match rate), `outer`.
- `strategy`:
  - `exact` — the key identifies one product (VAID, serial). Add `"duplicates": "last"` (or `first`) when the right side may hold re-tests of the same product, `"all"` keeps every combination.
  - `nearest_after` / `nearest_before` / `nearest` — the key is a reusable carrier (tray, jig, pallet). Pairs each left row with the right row whose time is closest after/before/either side. `tolerance_hours` caps the gap (0 = no cap). `left_time` / `right_time` pick time columns (default each side's `_ts`).
- `normalize` (default true) trims spaces and treats `12` and `12.0` the same; `ignore_case` uppercases both sides.
- When both inputs have the same column name, the right one gets a `_r` suffix.

### union — stack rows of several inputs (same layout)
`{"kind": "union", "label": "All lines", "params": {}}`

### dataset — read a saved dataset (analysis flows)
`{"kind": "dataset", "label": "제품 Trace", "params": {"name": "product_trace", "columns": []}}` — `columns` optional.

### output — save the input as a dataset
`{"kind": "output", "label": "Save", "params": {"name": "product_trace"}}`
- Dataset names are global — never reuse a name owned by another flow.
- `"mode": "upsert", "keys": ["drive.VAID"]` replaces rows with the same key and keeps the rest (use with a short `days` window for incremental runs). Default `replace`.

### python — custom code (last resort)
```json
{"kind": "python", "label": "Yield by hour", "params": {"inputs": 1, "code": "def run(inputs, params):\n    df = inputs[0]\n    return df"}}
```
`pd`, `np`, `re`, `json`, `math`, `datetime` are available without import. Return a DataFrame.

### graph / cypher — Neo4j (only if the user asks for lineage/impact graphs and Neo4j is configured)
`graph`: `{"name": "...", "product_key": "drive.VAID", "resources": "blade.Tray No=Tray"}`. Skip otherwise.

## Library nodes (`custom`)

```json
{"kind": "custom", "nodeType": "select_columns", "label": "분석 컬럼 정리",
 "params": {"columns": ["drive.VAID", "drive.F14 Area"], "rename": "drive.VAID=VAID\ndrive.F14 Area=F14 Area"}}
```
`nodeType` is the library key; `summary` lists keys and param names. The standard library:

| key | params | does |
|---|---|---|
| `select_columns` | `columns` (list), `rename` (text, `old=new` per line) | keep / rename columns |
| `dropna` | `columns`, `how` (`any`/`all`) | drop rows with empty values |
| `filter_rows` | `expr` — pandas query, backtick odd names: `` `drive.Judge` == 'PASS' `` | filter rows |
| `formula` | `column`, `expr` — e.g. `df["a"] / df["b"]` | computed column |
| `to_numeric` | `columns` | text → number |
| `normalize_keys` | `columns`, `upper`, `remove` (regex), `zfill` | clean key values before a match |
| `outlier_filter` | `columns`, `method` (`sigma`/`iqr`), `k` | remove outliers |
| `time_bucket` | `column`, `freq` (`10min`,`30min`,`h`,`4h`,`D`), `target` | round time into buckets |
| `group_aggregate` | `group_by`, `columns`, `func` (`mean`,`median`,`sum`,`min`,`max`,`std`,`count`), `add_count` | grouped stats |
| `describe` | `columns` | count/mean/std/quantiles per column |
| `correlation` | `columns`, `method` (`pearson`/`spearman`), `format` (`matrix` for a heatmap, `long`) | correlation matrix — matrix output has a `variable` column |
| `regression` | `x_columns`, `y_columns` | simple linear regression per X×Y pair (n, r, r², slope, intercept) |
| `sort_limit` | `column`, `ascending`, `limit` | sort / top N |
| `concat_columns` | — (2 inputs `in0`, `in1`) | side by side by row order |

## Example — match flow (3 stages)

```json
{"name": "제품 공정 Trace", "kind": "match", "schedule_minutes": 0, "graph": {
 "nodes": [
  {"id": "blade", "type": "op", "position": {"x": 40, "y": 40},  "data": {"kind": "source", "label": "Blade 조립기", "params": {"alias": "blade", "equipment_ids": [1, 2]}}},
  {"id": "drive", "type": "op", "position": {"x": 40, "y": 180}, "data": {"kind": "source", "label": "구동 검사기", "params": {"alias": "drive", "equipment_ids": [3, 4, 5]}}},
  {"id": "eol",   "type": "op", "position": {"x": 360, "y": 320}, "data": {"kind": "source", "label": "EOL", "params": {"alias": "eol", "equipment_ids": [6]}}},
  {"id": "m1", "type": "op", "position": {"x": 360, "y": 100}, "data": {"kind": "match", "label": "Tray ↔ QR", "params": {"how": "left", "strategy": "nearest_after", "tolerance_hours": 12, "normalize": true,
     "keys": [{"left": "blade.Tray No", "right": "drive.QRCODE"}, {"left": "blade.Tray Position", "right": "drive.Position No"}]}}},
  {"id": "m2", "type": "op", "position": {"x": 680, "y": 200}, "data": {"kind": "match", "label": "VAID", "params": {"how": "left", "strategy": "exact", "duplicates": "last", "normalize": true,
     "keys": [{"left": "drive.VAID", "right": "eol.VAID"}]}}},
  {"id": "out", "type": "op", "position": {"x": 1000, "y": 200}, "data": {"kind": "output", "label": "Save", "params": {"name": "product_trace"}}}
 ],
 "edges": [
  {"id": "e1", "source": "blade", "target": "m1", "sourceHandle": "out", "targetHandle": "left"},
  {"id": "e2", "source": "drive", "target": "m1", "sourceHandle": "out", "targetHandle": "right"},
  {"id": "e3", "source": "m1", "target": "m2", "sourceHandle": "out", "targetHandle": "left"},
  {"id": "e4", "source": "eol", "target": "m2", "sourceHandle": "out", "targetHandle": "right"},
  {"id": "e5", "source": "m2", "target": "out", "sourceHandle": "out", "targetHandle": "in"}
 ]}}
```

## Example — analysis flow

`dataset(product_trace)` → `dropna(eol.F1440 Area, drive.F14 Area)` → `select_columns(rename to short names)` → `correlation(format=matrix)` → `output(pin_area_corr)`; the same `select_columns` node also feeds `regression` → `output(pin_area_regression)` and directly `output(pin_area_data)` (the row-level table the dashboard charts use). Fan out from one node by giving it several outgoing edges.
