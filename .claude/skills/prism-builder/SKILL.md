---
name: prism-builder
description: Build PRISM (camera-module manufacturing tracking) pipelines from a plain-language request — find the equipment data, create a Match flow that links process stages per product, an Analysis flow on the matched dataset, and a dashboard. Use when asked to create/extend PRISM flows, datasets or dashboards, or to "analyze X vs Y" on PRISM data.
---

# PRISM builder

PRISM collects log files from factory equipment, links the records of one product across process stages (**Match flow**), analyzes the linked data (**Analysis flow**), and shows the results (**Dashboard**). You build these through the PRISM REST API with the helper script — never by editing PRISM's own files or database.

```
python .claude/skills/prism-builder/scripts/prism.py <command> ...
```

Run it with `--help` for every command. It only creates or updates; it never deletes. Write each JSON payload to a file in the current directory with the Write tool, then pass the file path. Pass API paths without a leading slash (`get api/flows/3`).

Call the helper exactly in that form, one command per Bash call, from the current directory: no `cd`, no `VAR=value` prefix, no `&&`, `;` or pipes. The server address is already set in the environment. Other shell commands are not permitted and will be refused.

## Workflow

Work through these steps in order. Keep the user's language (Korean or English) for names, titles and the final report.

1. **Understand the data** — `summary`, then for the relevant equipment `fields <id> --grep ...` and `sample <id> --grep ... --rows 5`. Equipment of the same `process` normally share one parser and one field layout, so put them in one source node.
   - Each record has `_ts` (record time) and `_equipment` (equipment name) besides its own fields.
   - Look for the product's identity at each stage: serial/VAID/QR/barcode columns, or carrier keys such as tray number + position. Confirm with sample values that the same value really appears on both sides (case, padding and prefixes matter).
   - If a dataset that already links the stages exists (`summary` → datasets), reuse it instead of building a new Match flow.
2. **Match flow** — read [reference/flows.md](reference/flows.md). One `source` node per stage with an `alias` (it prefixes every column: `blade.Tray No`), then `match` nodes chained stage by stage, then one `output` node.
   - Before saving, `preview <file> <match_node_id>` and compare row counts. To measure the match rate, preview once with `"how": "inner"`: inner rows ÷ left rows = matched share. Below ~80 %, inspect sample keys and fix the keys (`normalize_keys` node, `ignore_case`, a nearest-time strategy for reused carriers like trays) before going on. Report the final rate.
   - `create-flow`, then `run-flow <id>` and check the output dataset rows.
3. **Analysis flow** — start from a `dataset` node reading the match output. Typical chain: `dropna` → `select_columns` (rename `stage.col` to short names) → analysis nodes (`correlation`, `regression`, `group_aggregate`, `describe`, `time_bucket`, `outlier_filter`, `filter_rows`, `formula`, …) → one `output` per result table. Check the node library in `summary` for exact params. `create-flow`, `run-flow`.
4. **Dashboard** — read [reference/dashboards.md](reference/dashboards.md). Choose chart kinds by question (trend → line, relation → scatter with trendline, distribution/capability → histogram with limits, share → pie, position → xy, matrix → heatmap). Lay widgets out on the 12-column grid without overlaps: KPI `stat` tiles across the top, main charts next, a detail `table` last. `check-dashboard`, then `create-dashboard`.
5. **Report** — list what you created (flow/dashboard names and their paths `/match/<id>`, `/analysis/<id>`, `/dashboards/<id>`), the match rate, the key findings visible in the data (e.g. the strongest correlations), and anything you could not do and why.

## Rules

- Never delete or overwrite existing flows, datasets or dashboards. New dataset names must not collide with datasets made by other flows (the helper refuses). If the user asks to change an existing one, use `update-flow` / `update-dashboard` on that id only.
- Leave `schedule_minutes` at 0 (no auto-run) unless the user asks for a schedule.
- Prefer built-in and library nodes over `python` nodes. Use a `python` node only when nothing else fits, and keep its code short.
- Column names are case- and space-sensitive and may contain spaces and dots — copy them exactly from `fields`/`dataset` output.
- When the request is ambiguous (which stages, which metric), choose the most reasonable reading from the data, say what you assumed in the report, and continue — there is nobody to answer questions mid-run.
- If a step fails, read the error (it names the node and column), fix the JSON, and retry. Stop after three failed attempts on the same step and report.
