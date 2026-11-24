import { Button, Empty, Input, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import { AimOutlined, DeleteOutlined, EditOutlined, FilterOutlined, SearchOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Dataset, FramePayload } from '../api';
import DataGrid from '../components/DataGrid';
import { useTheme } from '../theme';
import { buildOption, ChartConfig, neededColumns } from './charts';
import { DS_COL, Layer, layerLabels, LinkCfg, mergeFrames, normKey, renameColumns, resolveLinkColumn, SEL_COL, Selection } from './link';

export type WidgetType = 'chart' | 'table' | 'stat' | 'text';
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
};

/** 강조 표시를 지원하는 차트 (나머지는 필터) */
export const canHighlight = (w: Widget) => w.type === 'chart' && (w.chart?.kind === 'scatter' || w.chart?.kind === 'xy');
export const linkBehavior = (w: Widget) => (canHighlight(w) ? w.link?.behavior ?? 'highlight' : 'filter');

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
  w,
  tick,
  editing,
  datasets,
  selection,
  onSelect,
  onEdit,
  onDelete,
}: {
  w: Widget;
  tick: number;
  editing?: boolean;
  datasets: Dataset[];
  selection: Selection | null;
  onSelect: (s: Selection | null) => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const [data, setData] = useState<FramePayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [bodyRef, size] = useSize<HTMLDivElement>();
  const limit = w.limit ?? (w.type === 'table' ? 5000 : w.type === 'stat' ? 0 : 50000);
  const isSource = !!selection && selection.source === w.i;
  const behavior = linkBehavior(w);

  // 데이터셋별 요청 (선택 연동 컬럼은 데이터셋마다 다를 수 있음)
  const reqs: Req[] = useMemo(() => {
    if (w.type === 'text') return [];
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
  }, [w, datasets, selection, isSource, behavior, limit]);
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
  const chartSize = w.type === 'chart' && w.chart?.kind === 'xy' ? size : undefined;
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

  const tableData = useMemo(() => {
    if (!data || w.type !== 'table' || !q.trim()) return data;
    const s = q.trim().toLowerCase();
    return { ...data, rows: data.rows.filter((r) => r.some((v) => v !== null && String(v).toLowerCase().includes(s))) };
  }, [data, q, w.type]);

  let body: React.ReactNode = null;
  if (w.type === 'text') {
    body = <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 4, color: 'var(--text-2)' }}>{w.text?.content}</Typography.Paragraph>;
  } else if (!w.dataset) {
    body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="데이터셋을 지정하세요" />;
  } else if (err) {
    body = <Typography.Text type="danger" style={{ fontSize: 12 }}>{err}</Typography.Text>;
  } else if (!data) {
    body = <Spin style={{ margin: 24 }} />;
  } else if (linked && behavior === 'filter' && !data.rows.length) {
    body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="선택한 값의 데이터가 없어요" />;
  } else if (w.type === 'chart' && option) {
    body = <ReactECharts option={option} notMerge lazyUpdate style={{ height: '100%', width: '100%' }} />;
  } else if (w.type === 'table') {
    const cols = w.table?.columns?.length ? [...(dsIdx >= 0 ? [DS_COL] : []), ...w.table.columns] : undefined;
    body = (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {selCol && (
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined style={{ color: 'var(--text-4)' }} />}
            placeholder={`검색 후 행을 클릭하면 ${selCol} 로 다른 위젯이 바뀌어요`}
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
    const aggName: Record<string, string> = { count: '개수', distinct: '고유 개수', mean: '평균', sum: '합계', min: '최소', max: '최대', last: '마지막 값' };
    body = (
      <div style={{ padding: '2px 6px' }}>
        <div className="stat-value num">
          {w.stat.prefix}
          {txt}
          <span style={{ fontSize: 16, color: 'var(--text-2)', fontWeight: 500, marginLeft: 2 }}>{w.stat.suffix}</span>
        </div>
        <div className="stat-sub">
          {aggName[w.stat.agg ?? 'count']} · {w.stat.column ?? '행'} · {widgetSources(w).map((s) => s.label).join(' + ')}
        </div>
      </div>
    );
  }

  const selText = selection ? (selection.values.length > 1 ? `${selection.values[0]} 외 ${selection.values.length - 1}` : selection.values[0]) : '';
  return (
    <div className={`dash-widget${isSource ? ' dash-widget-source' : ''}`}>
      <div className="dash-widget-head drag-handle">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: w.type === 'stat' ? 13 : undefined, fontWeight: w.type === 'stat' ? 500 : undefined, color: w.type === 'stat' ? 'var(--text-2)' : undefined }}>
          <span className="ellipsis">{w.title}</span>
          {linked && (
            <Tooltip title={`${selection!.column} = ${selection!.values.join(', ')} ${behavior === 'filter' ? '인 행만 표시' : '인 점을 강조'}`}>
              <Tag bordered={false} color="blue" icon={behavior === 'filter' ? <FilterOutlined /> : <AimOutlined />} style={{ margin: 0, maxWidth: 180 }} className="ellipsis">
                {selText}
              </Tag>
            </Tooltip>
          )}
          {loading && data && <Spin size="small" />}
        </span>
        {editing && (
          <Space size={0} onMouseDown={(e) => e.stopPropagation()}>
            <Tooltip title="편집">
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
