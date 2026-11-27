import { CaretDownFilled, CaretUpFilled } from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';

export type VCol = { key: string; title: string; width: number; align?: 'right'; i: number; render: (v: unknown) => React.ReactNode };

const ROW_H = 36;
const HEAD_H = 38;
const OVERSCAN_ROWS = 6;
const OVERSCAN_COLS = 3;

/** 첫 번째 offsets[i] > x 인 i - 1 (x 위치에 있는 열) */
function colAt(offsets: number[], x: number) {
  let lo = 0, hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function cmp(x: unknown, y: unknown) {
  if (x === y) return 0;
  if (x === null || x === undefined) return -1;
  if (y === null || y === undefined) return 1;
  return (x as any) > (y as any) ? 1 : -1;
}

/**
 * 행과 열을 모두 가상화한 표: 화면에 보이는 셀만 그린다.
 * 컬럼이 수천 개인 데이터셋은 antd Table(행만 가상화)로는 한 행에 수천 개 셀을 그려서 화면이 멈춘다.
 */
export default function VirtualGrid({
  cols,
  rows,
  maxHeight,
  onRowClick,
  isSelected,
}: {
  cols: VCol[];
  rows: unknown[][];
  maxHeight: number;
  onRowClick?: (row: unknown[], e: React.MouseEvent) => void;
  isSelected?: (row: unknown[]) => boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, left: 0, w: 800 });
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(null);
  const frame = useRef(0);

  const offsets = useMemo(() => {
    const o = [0];
    cols.forEach((c) => o.push(o[o.length - 1] + c.width));
    return o;
  }, [cols]);
  const totalW = offsets[offsets.length - 1];

  const order = useMemo(() => {
    const idx = rows.map((_, k) => k);
    if (sort) idx.sort((a, b) => sort.dir * cmp(rows[a][sort.i], rows[b][sort.i]));
    return idx;
  }, [rows, sort]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, w: el.clientWidth })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = box.current;
      if (el) setView({ top: el.scrollTop, left: el.scrollLeft, w: el.clientWidth });
    });
  };

  const height = Math.min(maxHeight, HEAD_H + Math.max(1, rows.length) * ROW_H + 12);
  const bodyH = height - HEAD_H;
  const r0 = Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN_ROWS);
  const r1 = Math.min(order.length, Math.ceil((view.top + bodyH) / ROW_H) + OVERSCAN_ROWS);
  const c0 = Math.max(0, colAt(offsets, view.left) - OVERSCAN_COLS);
  const c1 = Math.min(cols.length, colAt(offsets, view.left + view.w) + 1 + OVERSCAN_COLS);
  const visCols = cols.slice(c0, c1);

  return (
    <div ref={box} className="vgrid num" style={{ height }} onScroll={onScroll} role="grid" aria-rowcount={rows.length} aria-colcount={cols.length}>
      <div style={{ width: totalW, height: HEAD_H + order.length * ROW_H, position: 'relative' }}>
        <div className="vgrid-head" style={{ width: totalW, height: HEAD_H }}>
          {visCols.map((c, j) => {
            const active = sort?.i === c.i;
            return (
              <div
                key={c.key}
                className="vgrid-h"
                role="columnheader"
                title={c.title}
                style={{ left: offsets[c0 + j], width: c.width, justifyContent: c.align === 'right' ? 'flex-end' : undefined }}
                onClick={() => setSort(!active ? { i: c.i, dir: 1 } : sort!.dir === 1 ? { i: c.i, dir: -1 } : null)}
              >
                <span className="vgrid-t">{c.title}</span>
                {active && (sort!.dir === 1 ? <CaretUpFilled /> : <CaretDownFilled />)}
              </div>
            );
          })}
        </div>
        {order.slice(r0, r1).map((k, n) => {
          const row = rows[k];
          const sel = isSelected?.(row);
          return (
            <div
              key={k}
              className={`vgrid-r${sel ? ' selected' : ''}${onRowClick ? ' clickable' : ''}`}
              role="row"
              style={{ top: HEAD_H + (r0 + n) * ROW_H, width: totalW }}
              onClick={onRowClick ? (e) => onRowClick(row, e) : undefined}
            >
              {visCols.map((c, j) => (
                <div key={c.key} className="vgrid-c" role="gridcell" style={{ left: offsets[c0 + j], width: c.width, textAlign: c.align }}>
                  {c.render(row[c.i])}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
