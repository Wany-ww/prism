import { Button, Empty, Input, Select, Slider, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { AimOutlined, DeleteOutlined, EditOutlined, FilterOutlined, SearchOutlined, SlidersOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Dataset, FramePayload } from '../api';
import DataGrid from '../components/DataGrid';
import { useTheme } from '../theme';
import { buildOption, ChartConfig, neededColumns } from './charts';
import { DS_COL, Layer, layerLabels, LinkCfg, mergeFrames, normKey, paramIdOf, Params, renameColumns, resolveLinkColumn, resolveParam, SEL_COL, Selection } from './link';

export type WidgetType = 'chart' | 'table' | 'stat' | 'text' | 'control';
export type ControlKind = 'dropdown' | 'slider';
/** 컨트롤 위젯의 한 항목: 고를 때 보여줄 이름과, 그걸 고르면 파라미터에 들어갈 실제 값(보통 컬럼명) */
export type ControlOption = { label: string; value: string };
export type StatAgg = 'count' | 'distinct' | 'mean' | 'sum' | 'min' | 'max' | 'last';
export type Widget = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: WidgetType;
  title: string;
  dataset?: string;
  /** 첫 데이터셋의 표시 이름 (겹친 데이터셋이 있을 때 범례/구분 컬럼에 사용) */
  label?: string;
  /** 함께 겹쳐 그릴 데이터셋 */
  layers?: Layer[];
  limit?: number;
  chart?: ChartConfig;
  table?: { columns?: string[]; pageSize?: number };
  stat?: { column?: string; agg?: StatAgg; decimals?: number; prefix?: string; suffix?: string };
  text?: { content?: string };
  /** 테이블: 행 클릭 시 이 컬럼 값으로 대시보드 선택 */
  select?: { column?: string };
  /** 다른 위젯의 선택에 반응하는 방식 */
  link?: LinkCfg;
  /** 드롭다운/슬라이더: paramId 파라미터를 options 중 고른 값(컬럼명)으로 바꿈 */
  control?: { kind?: ControlKind; paramId?: string; options?: ControlOption[] };
};

/** 강조 표시를 지원하는 차트 (나머지는 필터) */
export const canHighlight = (w: Widget) => w.type === 'chart' && (w.chart?.kind === 'scatter' || w.chart?.kind === 'xy');
export const linkBehavior = (w: Widget) => (canHighlight(w) ? w.link?.behavior ?? 'highlight' : 'filter');

/**
 * 차트/표/통계 설정 안의 `$파라미터` 토큰(paramToken 으로 넣음)을 컨트롤 위젯이 정한
 * 실제 컬럼명으로 바꾼 위젯 사본을 만든다. 파라미터 값이 아직 없으면 그 필드는 빈 채로 둔다.
 * 편집 화면은 항상 원래(토큰이 있는) 위젯을 쓰고, 데이터를 읽고 그리는 쪽만 이 결과를 쓴다.
 */
export function resolveWidgetParams(w: Widget, params: Params): Widget {
  if (w.type === 'chart' && w.chart) {
    const c = w.chart;
    return {
      ...w,
      chart: {
        ...c,
        x: resolveParam(c.x, params),
        y: (c.y ?? []).map((y) => resolveParam(y, params)).filter(Boolean) as string[],
        series: resolveParam(c.series, params),
        tip: resolveParam(c.tip, params),
        z: resolveParam(c.z, params),
      },
    };
  }
  if (w.type === 'table') {
    return {
      ...w,
      table: w.table?.columns?.length ? { ...w.table, columns: w.table.columns.map((c) => resolveParam(c, params)).filter(Boolean) as string[] } : w.table,
      select: w.select?.column ? { column: resolveParam(w.select.column, params) } : w.select,
    };
  }
  if (w.type === 'stat' && w.stat?.column) {
    return { ...w, stat: { ...w.stat, column: resolveParam(w.stat.column, params) } };
  }
  return w;
}

/** 위젯이 쓰는 파라미터 id 목록 (대시보드 안에서 어떤 파라미터가 쓰이는지 모을 때) */
export function widgetParamIds(w: Widget): string[] {
  const vals = [w.chart?.x, ...(w.chart?.y ?? []), w.chart?.series, w.chart?.tip, w.chart?.z, w.stat?.column, w.select?.column, ...(w.table?.columns ?? [])];
  return [...new Set(vals.map(paramIdOf).filter((x): x is string => x !== null))];
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 200 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: Math.round(e.contentRect.width), height: Math.round(e.contentRect.height) }));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function computeStat(d: FramePayload, s: NonNullable<Widget['stat']>) {
  const i = d.columns.findIndex((c) => c.name === s.column);
  const agg = s.agg ?? 'count';
  if (i < 0) return agg === 'count' ? d.row_count : null;
  const vals = d.rows.map((r) => r[i]).filter((v) => v !== null && v !== undefined && v !== '');
  if (agg === 'count') return vals.length;
  if (agg === 'distinct') return new Set(vals.map(String)).size;
  if (agg === 'last') return vals[vals.length - 1] ?? null;
  const nums = vals.map(Number).filter(Number.isFinite);
  if (!nums.length) return null;
  if (agg === 'sum') return nums.reduce((a, b) => a + b, 0);
  if (agg === 'min') return Math.min(...nums);
  if (agg === 'max') return Math.max(...nums);
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** 위젯이 읽을 데이터셋 목록 (첫 데이터셋 + 겹친 데이터셋) */
export type Source = { dataset: string; label: string; map?: Record<string, string> };
export function widgetSources(w: Widget): Source[] {
  if (!w.dataset) return [];
  const list: Layer[] = [{ dataset: w.dataset, label: w.label }, ...(w.layers ?? []).filter((l) => l.dataset)];
  const labels = layerLabels(list.map((l) => l.label?.trim() || l.dataset));
  return list.map((l, i) => ({ dataset: l.dataset, label: labels[i], map: l.map }));
}

type Req = Source & { url: string; linkCol: string | null; highlight: boolean };

export default function WidgetView({
  w: wRaw,
  tick,
  editing,
  datasets,
  selection,
  onSelect,
  params,
  liveParamIds,
  onParamChange,
  onEdit,
  onDelete,
}: {
  w: Widget;
  tick: number;
  editing?: boolean;
  datasets: Dataset[];
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  params: Params;
  /** 지금 대시보드에 실제로 있는 컨트롤 위젯들의 paramId — 이 위젯이 참조하는 파라미터가 없어졌는지 확인용 */
  liveParamIds: string[];
  onParamChange: (paramId: string, value: string) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [data, setData] = useState<FramePayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [bodyRef, size] = useSize<HTMLDivElement>();
  // 이 위젯이 쓰는 파라미터 중, 그걸 정해줄 컨트롤 위젯이 더는 없는 것 (지워졌거나 이름이 바뀜)
  const missingParams = useMemo(() => widgetParamIds(wRaw).filter((id) => !liveParamIds.includes(id)), [wRaw, liveParamIds]);
  // 파라미터 토큰($metric 등)을 현재 컨트롤 값으로 바꾼 위젯. 편집은 항상 wRaw(토큰 그대로)를 쓴다.
  const w = useMemo(() => resolveWidgetParams(wRaw, params), [wRaw, params]);
  const limit = w.limit ?? (w.type === 'table' ? 5000 : w.type === 'stat' ? 0 : 50000);
  const isSource = !!selection && selection.source === w.i;
  const behavior = linkBehavior(w);

  // 데이터셋별 요청 (선택 연동 컬럼은 데이터셋마다 다를 수 있음)
  const reqs: Req[] = useMemo(() => {
    if (w.type === 'text' || w.type === 'control' || missingParams.length) return [];
    const need = neededColumns(w);
    return widgetSources(w).map((s) => {
      const meta = datasets.find((d) => d.name === s.dataset);
      const linkCol = isSource || !meta ? null : resolveLinkColumn(selection, w.link, meta.columns.map((c) => c.name), s.map);
      const highlight = !!linkCol && behavior === 'highlight';
      const cols = need.map((c) => s.map?.[c] || c);
      if (highlight && cols.length && !cols.includes(linkCol!)) cols.push(linkCol!);
      const qs = new URLSearchParams({ limit: String(limit) });
      if (cols.length) qs.set('columns', cols.join(','));
      if (linkCol && !highlight) {
        qs.set('filter_col', linkCol);
        qs.set('filter_values', JSON.stringify(selection!.values));
      }
      return { ...s, url: `/api/datasets/${encodeURIComponent(s.dataset)}/data?${qs}`, linkCol, highlight };
    });
  }, [w, datasets, selection, isSource, behavior, limit, missingParams]);
  const reqKey = JSON.stringify(reqs.map((r) => [r.url, r.label, r.map, r.highlight && selection?.values]));
  const linked = reqs.some((r) => r.linkCol);

  useEffect(() => {
    if (!reqs.length) {
      setData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    Promise.all(
      reqs.map(async (r) => {
        let d = await api.get<FramePayload>(r.url);
        if (r.highlight) {
          const li = d.columns.findIndex((c) => c.name === r.linkCol);
          const want = new Set(selection!.values);
          d = { ...d, columns: [...d.columns, { name: SEL_COL, dtype: 'bool' }], rows: d.rows.map((row) => [...row, li >= 0 && want.has(normKey(row[li]))]) };
        }
        return { label: r.label, data: renameColumns(d, r.map) };
      }),
    )
      .then((parts) => {
        if (!alive) return;
        setData(mergeFrames(parts, parts.length > 1));
        setErr('');
      })
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey, tick]);

  const { mode } = useTheme();
  const chartSize = w.type === 'chart' && (w.chart?.kind === 'xy' || w.chart?.kind === 'histogram') ? size : undefined;
  const option = useMemo(
    () => (w.type === 'chart' && w.chart && data ? buildOption(w.chart, data, mode, chartSize) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [w.type, w.chart, data, mode, chartSize?.width, chartSize?.height],
  );

  // ---- 테이블: 행 클릭으로 선택 ----
  const selCol = w.type === 'table' ? w.select?.column : undefined;
  const selIdx = data && selCol ? data.columns.findIndex((c) => c.name === selCol) : -1;
  const dsIdx = data ? data.columns.findIndex((c) => c.name === DS_COL) : -1;
  const selected = useMemo(() => new Set(isSource ? selection!.values : []), [isSource, selection]);
  const onRowClick = (row: unknown[], e: React.MouseEvent) => {
    const v = normKey(row[selIdx]);
    if (!v) return;
    // 겹친 데이터셋의 행이면 그 데이터셋의 실제 컬럼명/이름으로
    const src = widgetSources(w).find((s) => dsIdx < 0 || s.label === row[dsIdx]) ?? widgetSources(w)[0];
    const column = src.map?.[selCol!] || selCol!;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const cur = isSource && selection!.column === column ? selection!.values : [];
    let values: string[];
    if (additive) values = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    else values = cur.length === 1 && cur[0] === v ? [] : [v];
    onSelect(values.length ? { column, values, source: w.i, dataset: src.dataset } : null);
  };

  // ---- 차트(산점도/XY/3D): 툴팁 컬럼이 있으면 점 클릭으로도 선택 (같은 점을 다시 누르면 해제) ----
  const canClickSelect = w.type === 'chart' && !!w.chart?.tip && (w.chart.kind === 'scatter' || w.chart.kind === 'xy' || w.chart.kind === 'scatter3d');
  const onChartClick = (p: any) => {
    const tip = w.chart?.tip;
    const arr = p?.value;
    if (!tip || !Array.isArray(arr)) return;
    const tipIdx = w.chart!.kind === 'scatter3d' ? 3 : 2; // [x,y,tip,ds] 또는 3D [x,y,z,tip,ds]
    const v = normKey(arr[tipIdx]);
    if (!v) return;
    const dsLabel = arr[tipIdx + 1];
    const sources = widgetSources(w);
    const src = (dsLabel != null ? sources.find((s) => s.label === dsLabel) : undefined) ?? sources[0];
    const column = (src?.map?.[tip] || tip)!;
    const cleared = isSource && selection!.column === column && selection!.values.length === 1 && selection!.values[0] === v;
    onSelect(cleared ? null : { column, values: [v], source: w.i, dataset: src?.dataset ?? w.dataset! });
  };

  const tableData = useMemo(() => {
    if (!data || w.type !== 'table' || !q.trim()) return data;
    const s = q.trim().toLowerCase();
    return { ...data, rows: data.rows.filter((r) => r.some((v) => v !== null && String(v).toLowerCase().includes(s))) };
  }, [data, q, w.type]);

  // ---- 컨트롤(드롭다운/슬라이더): 고른 항목의 값을 파라미터에 반영 ----
  const ctrl = w.control;
  const ctrlOpts = ctrl?.options?.filter((o) => o.value) ?? [];
  const ctrlVal = ctrl?.paramId ? params[ctrl.paramId] : undefined;
  const ctrlIdx = Math.max(0, ctrlOpts.findIndex((o) => o.value === ctrlVal));

  let body: React.ReactNode = null;
  if (w.type === 'text') {
    body = <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 4, color: 'var(--text-2)' }}>{w.text?.content}</Typography.Paragraph>;
  } else if (w.type === 'control') {
    if (!ctrl?.paramId || !ctrlOpts.length) {
      body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Set a parameter and options" />;
    } else if (ctrl.kind === 'slider') {
      body = (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '4px 20px' }}>
          <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 600, marginBottom: 10 }}>{ctrlOpts[ctrlIdx]?.label}</div>
          <Slider
            min={0}
            max={ctrlOpts.length - 1}
            step={1}
            value={ctrlIdx}
            tooltip={{ formatter: (i) => (i === undefined ? '' : ctrlOpts[i]?.label) }}
            marks={Object.fromEntries(ctrlOpts.map((_, i) => [i, '']))}
            onChange={(i) => onParamChange(ctrl.paramId!, ctrlOpts[i as number].value)}
          />
        </div>
      );
    } else {
      body = (
        <div style={{ padding: '10px 16px' }}>
          <Select
            style={{ width: '100%' }}
            value={ctrlVal}
            placeholder="Select a value"
            options={ctrlOpts.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => onParamChange(ctrl.paramId!, v)}
          />
        </div>
      );
    }
  } else if (!w.dataset) {
    body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Choose a dataset" />;
  } else if (missingParams.length) {
    body = (
      <Typography.Text type="warning" style={{ fontSize: 12 }}>
        Parameter {missingParams.map((p) => `⚙ ${p}`).join(', ')} has no control widget — add one, or edit this widget to pick a column
      </Typography.Text>
    );
  } else if (err) {
    body = <Typography.Text type="danger" style={{ fontSize: 12 }}>{err}</Typography.Text>;
  } else if (!data) {
    body = <Spin style={{ margin: 24 }} />;
  } else if (linked && behavior === 'filter' && !data.rows.length) {
    body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No data for the selected value" />;
  } else if (w.type === 'chart' && option) {
    body = (
      <ReactECharts
        option={option}
        notMerge
        lazyUpdate
        style={{ height: '100%', width: '100%' }}
        onEvents={canClickSelect ? { click: onChartClick } : undefined}
      />
    );
  } else if (w.type === 'table') {
    const cols = w.table?.columns?.length ? [...(dsIdx >= 0 ? [DS_COL] : []), ...w.table.columns] : undefined;
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {selCol && (
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ color: 'var(--text-4)' }} />}
            placeholder={`Search, then click a row to filter other widgets by ${selCol}`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ marginBottom: 6 }}
          />
        )}
        <DataGrid
          data={tableData}
          columns={cols}
          pageSize={w.table?.pageSize ?? 20}
          height={Math.max(60, size.height - (selCol ? 112 : 80))}
          onRowClick={selIdx >= 0 ? onRowClick : undefined}
          isSelected={selIdx >= 0 && isSource ? (r) => selected.has(normKey(r[selIdx])) : undefined}
        />
      </div>
    );
  } else if (w.type === 'stat' && w.stat) {
    const v = computeStat(data, w.stat);
    const txt = typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: w.stat.decimals ?? 0, minimumFractionDigits: w.stat.agg === 'count' || w.stat.agg === 'distinct' ? 0 : w.stat.decimals ?? 0 }) : String(v ?? '-');
    const aggName: Record<string, string> = { count: 'Count', distinct: 'Distinct', mean: 'Mean', sum: 'Sum', min: 'Min', max: 'Max', last: 'Last value' };
    body = (
      <div style={{ padding: '2px 6px' }}>
        <div className="stat-value num">
          {w.stat.prefix}
          {txt}
          <span style={{ fontSize: 16, color: 'var(--text-2)', fontWeight: 500, marginLeft: 2 }}>{w.stat.suffix}</span>
        </div>
        <div className="stat-sub">
          {aggName[w.stat.agg ?? 'count']} · {w.stat.column ?? 'rows'} · {widgetSources(w).map((s) => s.label).join(' + ')}
        </div>
      </div>
    );
  }

  const selText = selection ? (selection.values.length > 1 ? `${selection.values[0]} +${selection.values.length - 1}` : selection.values[0]) : '';
  return (
    <div className={`dash-widget${isSource ? ' dash-widget-source' : ''}`}>
      <div className="dash-widget-head drag-handle">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: w.type === 'stat' ? 13 : undefined, fontWeight: w.type === 'stat' ? 500 : undefined, color: w.type === 'stat' ? 'var(--text-2)' : undefined }}>
          <span className="ellipsis">{w.title}</span>
          {canClickSelect && (
            <Tooltip title={`Click a point to filter other widgets by ${w.chart!.tip}`}>
              <AimOutlined style={{ color: 'var(--text-4)', fontSize: 12 }} />
            </Tooltip>
          )}
          {w.type === 'control' && ctrl?.paramId && (
            <Tooltip title={`Other widgets bound to '${ctrl.paramId}' follow this`}>
              <Tag bordered={false} color="purple" icon={<SlidersOutlined />} style={{ margin: 0 }}>
                {ctrl.paramId}
              </Tag>
            </Tooltip>
          )}
          {linked && (
            <Tooltip title={`${selection!.column} = ${selection!.values.join(', ')} ${behavior === 'filter' ? '· showing only these rows' : '· highlighting these points'}`}>
              <Tag bordered={false} color="blue" icon={behavior === 'filter' ? <FilterOutlined /> : <AimOutlined />} style={{ margin: 0, maxWidth: 180 }} className="ellipsis">
                {selText}
              </Tag>
            </Tooltip>
          )}
          {loading && data && <Spin size="small" />}
        </span>
        {editing && (
          <Space size={0} onMouseDown={(e) => e.stopPropagation()}>
            <Tooltip title="Edit">
              <Button size="small" type="text" icon={<EditOutlined />} onClick={onEdit} />
            </Tooltip>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onDelete} />
          </Space>
        )}
      </div>
      <div className="dash-widget-body" ref={bodyRef}>
        {body}
      </div>
    </div>
  );
}
