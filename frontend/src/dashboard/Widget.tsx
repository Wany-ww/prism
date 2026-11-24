import { Button, Empty, Space, Spin, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, FramePayload } from '../api';
import DataGrid from '../components/DataGrid';
import { useTheme } from '../theme';
import { buildOption, ChartConfig, neededColumns } from './charts';

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
  limit?: number;
  chart?: ChartConfig;
  table?: { columns?: string[]; pageSize?: number };
  stat?: { column?: string; agg?: StatAgg; decimals?: number; prefix?: string; suffix?: string };
  text?: { content?: string };
};

function useHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [h, setH] = useState(200);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setH(e.contentRect.height));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, h] as const;
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

export default function WidgetView({ w, tick, editing, onEdit, onDelete }: { w: Widget; tick: number; editing?: boolean; onEdit?: () => void; onDelete?: () => void }) {
  const [data, setData] = useState<FramePayload | null>(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [bodyRef, bodyH] = useHeight<HTMLDivElement>();
  const cols = neededColumns(w).join(',');
  const limit = w.limit ?? (w.type === 'table' ? 5000 : w.type === 'stat' ? 0 : 50000);

  useEffect(() => {
    if (w.type === 'text' || !w.dataset) return;
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(limit), ...(cols ? { columns: cols } : {}) });
    api
      .get<FramePayload>(`/api/datasets/${encodeURIComponent(w.dataset)}/data?${qs}`)
      .then((d) => {
        setData(d);
        setErr('');
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [w.dataset, w.type, cols, limit, tick]);

  const { mode } = useTheme();
  const option = useMemo(() => (w.type === 'chart' && w.chart && data ? buildOption(w.chart, data, mode) : null), [w.type, w.chart, data, mode]);

  let body: React.ReactNode = null;
  if (w.type === 'text') {
    body = <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 4, color: 'var(--text-2)' }}>{w.text?.content}</Typography.Paragraph>;
  } else if (!w.dataset) {
    body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="데이터셋을 지정하세요" />;
  } else if (err) {
    body = <Typography.Text type="danger" style={{ fontSize: 12 }}>{err}</Typography.Text>;
  } else if (!data) {
    body = <Spin style={{ margin: 24 }} />;
  } else if (w.type === 'chart' && option) {
    body = <ReactECharts option={option} notMerge lazyUpdate style={{ height: '100%', width: '100%' }} />;
  } else if (w.type === 'table') {
    body = <DataGrid data={data} columns={w.table?.columns} pageSize={w.table?.pageSize ?? 20} height={Math.max(60, bodyH - 80)} />;
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
          {aggName[w.stat.agg ?? 'count']} · {w.stat.column ?? '행'} · {w.dataset}
        </div>
      </div>
    );
  }

  return (
    <div className="dash-widget">
      <div className="dash-widget-head drag-handle">
        <span style={{ fontSize: w.type === 'stat' ? 13 : undefined, fontWeight: w.type === 'stat' ? 500 : undefined, color: w.type === 'stat' ? 'var(--text-2)' : undefined }}>
          {w.title}
          {loading && data && <Spin size="small" style={{ marginLeft: 8 }} />}
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
