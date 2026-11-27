import { Table } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { FramePayload } from '../api';
import VirtualGrid, { VCol } from './VirtualGrid';

export function fmtCell(v: unknown, dtype?: string) {
  if (v === null || v === undefined) return <span style={{ color: 'var(--text-4)' }}>—</span>;
  if (dtype === 'number' && typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : Number(v.toPrecision(6)).toString();
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// 한 페이지 셀 수가 이보다 많으면 행·열을 모두 가상화한 표로 그림 (컬럼이 수천 개여도 멈추지 않게)
const VIRTUAL_CELLS = 4000;

/** CSS 높이(예: 'calc(100vh - 480px)')를 픽셀로 — 가상 표는 숫자 높이가 필요함 */
function usePixelHeight(height: number | string) {
  const probe = useRef<HTMLDivElement>(null);
  const [px, setPx] = useState(typeof height === 'number' ? height : 360);
  useEffect(() => {
    if (typeof height === 'number') {
      setPx(height);
      return;
    }
    const el = probe.current;
    if (!el) return;
    const measure = () => setPx(Math.max(60, el.offsetHeight));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [height]);
  const probeEl = typeof height === 'string' ? <div ref={probe} aria-hidden style={{ position: 'absolute', width: 0, height, visibility: 'hidden', pointerEvents: 'none' }} /> : null;
  return { px, probeEl };
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
  const vcols: VCol[] = useMemo(() => {
    if (!data) return [];
    // '__' 로 시작하는 컬럼은 내부용 (예: __sel)
    return data.columns
      .map((c, i) => ({ ...c, i }))
      .filter((c) => !c.name.startsWith('__') && (!only?.length || only.includes(c.name)))
      .sort((a, b) => (only?.length ? only.indexOf(a.name) - only.indexOf(b.name) : 0))
      .map((c) => ({
        key: c.name,
        title: c.name,
        i: c.i,
        width: Math.min(Math.max(c.name.length * 8 + 24, 90), 260),
        align: c.dtype === 'number' ? ('right' as const) : undefined,
        render: (v: unknown) => fmtCell(v, c.dtype),
      }));
  }, [data, only]);

  const rowCount = data?.rows.length ?? 0;
  const wide = vcols.length * Math.min(rowCount, pageSize) > VIRTUAL_CELLS;
  const { px, probeEl } = usePixelHeight(height);

  const { cols, rows } = useMemo(() => {
    if (!data || wide) return { cols: [], rows: [] };
    const cols = vcols.map((c) => ({
      title: <span title={c.title}>{c.title}</span>,
      dataIndex: String(c.i),
      key: c.key,
      ellipsis: true,
      width: c.width,
      align: c.align,
      render: c.render,
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
  }, [data, vcols, wide]);

  if (wide && data) {
    return (
      <>
        {probeEl}
        <VirtualGrid cols={vcols} rows={data.rows} maxHeight={px} onRowClick={onRowClick} isSelected={isSelected} />
      </>
    );
  }

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
