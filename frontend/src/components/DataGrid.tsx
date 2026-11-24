import { Table } from 'antd';
import { useMemo } from 'react';
import type { FramePayload } from '../api';

export function fmtCell(v: unknown, dtype?: string) {
  if (v === null || v === undefined) return <span style={{ color: 'var(--text-4)' }}>—</span>;
  if (dtype === 'number' && typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Number(v.toPrecision(6)).toString();
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function DataGrid({
  data,
  height = 360,
  pageSize = 50,
  columns: only,
  size = 'small',
  onRowClick,
  isSelected,
}: {
  data?: FramePayload | null;
  height?: number | string;
  pageSize?: number;
  columns?: string[];
  size?: 'small' | 'middle';
  /** 행 클릭 (대시보드 선택 연동) */
  onRowClick?: (row: unknown[], e: React.MouseEvent) => void;
  isSelected?: (row: unknown[]) => boolean;
}) {
  const { cols, rows } = useMemo(() => {
    if (!data) return { cols: [], rows: [] };
    // '__' 로 시작하는 컬럼은 내부용 (예: __sel)
    const idx = data.columns
      .map((c, i) => ({ ...c, i }))
      .filter((c) => !c.name.startsWith('__') && (!only?.length || only.includes(c.name)))
      .sort((a, b) => (only?.length ? only.indexOf(a.name) - only.indexOf(b.name) : 0));
    const cols = idx.map((c) => ({
      title: <span title={c.name}>{c.name}</span>,
      dataIndex: String(c.i),
      key: c.name,
      ellipsis: true,
      width: Math.min(Math.max(c.name.length * 8 + 24, 90), 260),
      align: c.dtype === 'number' ? ('right' as const) : undefined,
      render: (v: unknown) => fmtCell(v, c.dtype),
      sorter: (a: any, b: any) => {
        const x = a[c.i], y = b[c.i];
        if (x === y) return 0;
        if (x === null) return -1;
        if (y === null) return 1;
        return x > y ? 1 : -1;
      },
    }));
    const rows = data.rows.map((r, k) => {
      const o: Record<string, unknown> = { __k: k, __row: r };
      r.forEach((v, i) => (o[String(i)] = v));
      return o;
    });
    return { cols, rows };
  }, [data, only]);

  return (
    <Table
      size={size}
      rowKey="__k"
      columns={cols}
      dataSource={rows}
      scroll={{ x: 'max-content', y: height }}
      pagination={rows.length > pageSize ? { pageSize, size: 'small', showSizeChanger: false } : false}
      className={onRowClick ? 'num grid-selectable' : 'num'}
      rowClassName={isSelected ? (r: any) => (isSelected(r.__row) ? 'row-selected' : '') : undefined}
      onRow={onRowClick ? (r: any) => ({ onClick: (e) => onRowClick(r.__row, e) }) : undefined}
    />
  );
}
