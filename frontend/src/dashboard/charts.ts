import 'echarts-gl'; // 사이드이펙트: echarts 인스턴스에 3D(grid3D/scatter3D) 컴포넌트를 등록
import type { FramePayload } from '../api';
import type { Mode } from '../theme';
import { addAxisBackground, bgAxisBox, ChartBackground } from './background';
import { DS_COL, SEL_COL } from './link';

// 토스 톤 범주형 팔레트 — validate_palette.js 로 라이트/다크 각각 전 항목 통과한 순서 (순환·재배열 금지)
const THEMES = {
  light: {
    series: ['#3182f6', '#f04452', '#18a5a5', '#fe9800', '#a234c7', '#03b26c'],
    ink: { primary: '#191f28', secondary: '#4e5968', muted: '#8b95a1', grid: '#f2f4f6', axis: '#e5e8eb', surface: '#ffffff', tooltip: '#ffffff' },
    // 상관계수: 파랑(음) ↔ 회색 중간점 ↔ 빨강(양)
    diverging: ['#1b64da', '#90c2ff', '#f2f4f6', '#ffa3a9', '#d22030'],
  },
  dark: {
    series: ['#4593fc', '#f04452', '#139c9c', '#d17d00', '#b65fd6', '#03a362'],
    ink: { primary: '#e4e4e5', secondary: '#9e9ea4', muted: '#7e7e87', grid: '#2c2c35', axis: '#3c3c47', surface: '#202027', tooltip: '#2c2c35' },
    diverging: ['#2f7ae8', '#2b4a78', '#3c3c47', '#7a2e36', '#f04452'],
  },
};
let T = THEMES.light;

export type ChartKind = 'line' | 'area' | 'bar' | 'scatter' | 'xy' | 'histogram' | 'heatmap' | 'box' | 'pie' | 'scatter3d';
export type SpecShape = 'none' | 'circle' | 'rect';
export type ChartConfig = {
  kind: ChartKind;
  x?: string;
  y?: string[];
  /** 3D 산점도: 세 번째 축 컬럼 */
  z?: string;
  series?: string;
  agg?: 'none' | 'mean' | 'sum' | 'count' | 'min' | 'max';
  bins?: number;
  trendline?: boolean;
  stack?: boolean;
  sort?: 'none' | 'asc' | 'desc';
  /** 산점도·좌표 분포·3D: 툴팁에 함께 보여줄 컬럼 (예: VAID) */
  tip?: string;
  /** 좌표 분포: X/Y 축 눈금 1:1 */
  equal?: boolean;
  /** 좌표 분포: 그룹별 평균 중심 표시 */
  centroid?: boolean;
  /** 좌표 분포: 기준 위치와 허용 범위 */
  spec?: { shape?: SpecShape; cx?: number | null; cy?: number | null; r?: number | null; dx?: number | null; dy?: number | null };
  /** 히스토그램: 공정능력(Cp/Cpk) 계산에 쓰는 규격 하한(LSL)/상한(USL). 하나만 넣으면 그쪽만(한쪽 규격) 계산 */
  limits?: { lsl?: number | null; usl?: number | null };
  /** 배경 이미지 (투명도·위치·크기) */
  background?: ChartBackground;
};
export type ChartSize = { width: number; height: number };

const axisCommon = () => ({
  axisLine: { lineStyle: { color: T.ink.axis } },
  axisTick: { show: false },
  axisLabel: { color: T.ink.muted, fontSize: 11 },
  splitLine: { lineStyle: { color: T.ink.grid } },
  nameTextStyle: { color: T.ink.secondary, fontSize: 11 },
});

function colIdx(d: FramePayload, name?: string) {
  return name ? d.columns.findIndex((c) => c.name === name) : -1;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function aggregate(vals: number[], agg: string) {
  if (agg === 'count') return vals.length;
  if (!vals.length) return null;
  if (agg === 'sum') return vals.reduce((a, b) => a + b, 0);
  if (agg === 'min') return Math.min(...vals);
  if (agg === 'max') return Math.max(...vals);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
const round = (v: number) => Number(v.toPrecision(6));

function base(legend: boolean) {
  return {
    color: T.series,
    backgroundColor: 'transparent',
    animationDuration: 300,
    textStyle: { fontFamily: '"Pretendard Variable", Pretendard, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif' },
    grid: { left: 8, right: 16, top: legend ? 34 : 14, bottom: 8, containLabel: true },
    legend: legend
      ? { show: true, top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: T.ink.secondary, fontSize: 12 } }
      : { show: false },
    tooltip: {
      confine: true,
      backgroundColor: T.ink.tooltip,
      borderWidth: 0,
      padding: [8, 12],
      extraCssText: 'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.14);',
      textStyle: { color: T.ink.primary, fontSize: 12 },
    },
  };
}

/**
 * 행을 색 구분 그룹으로 나눔. 여러 데이터셋을 겹친 위젯이면 데이터셋(_dataset)이 1차 구분,
 * 시리즈 컬럼이 2차 구분. 데이터셋은 위젯에 추가한 순서, 시리즈 값은 이름순 (색이 값에 고정되도록).
 */
function seriesGroups(d: FramePayload, seriesCol?: string): [string, unknown[][]][] {
  const si = colIdx(d, seriesCol);
  const di = colIdx(d, DS_COL);
  if (si < 0 && di < 0) return [['', d.rows]];
  const m = new Map<string, { ds: number; s: string; rows: unknown[][] }>();
  const dsOrder = new Map<string, number>();
  for (const r of d.rows) {
    const ds = di >= 0 ? String(r[di]) : '';
    if (!dsOrder.has(ds)) dsOrder.set(ds, dsOrder.size);
    const s = si >= 0 ? (r[si] == null ? '(none)' : String(r[si])) : '';
    const k = [ds, s].filter(Boolean).join(' · ');
    if (!m.has(k)) m.set(k, { ds: dsOrder.get(ds)!, s, rows: [] });
    m.get(k)!.rows.push(r);
  }
  return [...m.entries()].sort((a, b) => a[1].ds - b[1].ds || a[1].s.localeCompare(b[1].s)).map(([k, v]) => [k, v.rows]);
}

/** 선택 연동 '강조' 상태: __sel 컬럼이 있고 하나라도 true 면 선택 행 인덱스 집합 */
function selectedRows(d: FramePayload): Set<unknown[]> | null {
  const i = colIdx(d, SEL_COL);
  if (i < 0) return null;
  const s = new Set(d.rows.filter((r) => r[i] === true));
  return s;
}

export function buildOption(cfg: ChartConfig, d: FramePayload, mode: Mode = 'light', size?: ChartSize): any {
  return addAxisBackground(chartOption(cfg, d, mode, size), cfg.background, cfg.kind);
}

function chartOption(cfg: ChartConfig, d: FramePayload, mode: Mode, size?: ChartSize): any {
  T = THEMES[mode];
  switch (cfg.kind) {
    case 'heatmap':
      return heatmap(cfg, d);
    case 'histogram':
      return histogram(cfg, d, size);
    case 'scatter':
      return scatter(cfg, d);
    case 'xy':
      return xyPlot(cfg, d, size);
    case 'box':
      return box(cfg, d);
    case 'pie':
      return pie(cfg, d);
    case 'scatter3d':
      return scatter3D(cfg, d);
    default:
      return cartesian(cfg, d);
  }
}

function cartesian(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const xType = xi >= 0 ? d.columns[xi].dtype : 'string';
  const ys = (cfg.y ?? []).filter((y) => colIdx(d, y) >= 0);
  const agg = cfg.agg ?? 'none';
  const groups = seriesGroups(d, ys.length === 1 ? cfg.series : undefined);
  const out: any[] = [];
  const catOrder: string[] = [];
  const isTime = xType === 'datetime' && cfg.kind !== 'bar';
  const isValue = xType === 'number' && cfg.kind !== 'bar';
  let k = 0;
  for (const [gname, rows] of groups) {
    for (const y of ys) {
      const yi = colIdx(d, y);
      let pts: [unknown, number | null][];
      if (agg === 'none') {
        pts = rows.map((r) => [r[xi], num(r[yi])]);
      } else {
        const m = new Map<string, number[]>();
        rows.forEach((r) => {
          const key = String(r[xi]);
          if (!m.has(key)) m.set(key, []);
          const v = num(r[yi]);
          if (v !== null || agg === 'count') m.get(key)!.push(v ?? 0);
        });
        pts = [...m.entries()].map(([key, vs]) => [isValue ? Number(key) : key, aggregate(vs, agg)]);
      }
      if (isTime || isValue) pts.sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
      if (cfg.sort && cfg.sort !== 'none') pts.sort((a, b) => ((a[1] ?? 0) - (b[1] ?? 0)) * (cfg.sort === 'asc' ? 1 : -1));
      if (!isTime && !isValue) pts.forEach((p) => !catOrder.includes(String(p[0])) && catOrder.push(String(p[0])));
      const name = gname ? (ys.length > 1 ? `${gname} · ${y}` : gname) : y;
      const color = T.series[k++ % T.series.length];
      out.push({
        name,
        type: cfg.kind === 'bar' ? 'bar' : 'line',
        data: isTime || isValue ? pts : pts.map((p) => [String(p[0]), p[1]]),
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2 },
        stack: cfg.stack ? 'total' : undefined,
        areaStyle:
          cfg.kind === 'area'
            ? { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: color + '55' }, { offset: 1, color: color + '00' }] } }
            : undefined,
        barMaxWidth: 28,
        itemStyle: cfg.kind === 'bar' ? { borderRadius: [4, 4, 0, 0], borderColor: T.ink.surface, borderWidth: 1 } : undefined,
        connectNulls: true,
      });
    }
  }
  const b = base(out.length > 1);
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: cfg.kind === 'bar' ? 'shadow' : 'line', lineStyle: { color: T.ink.axis } } },
    xAxis: { type: isTime ? 'time' : isValue ? 'value' : 'category', data: isTime || isValue ? undefined : catOrder, scale: isValue, ...axisCommon(), splitLine: { show: false } },
    yAxis: { type: 'value', scale: cfg.kind !== 'bar', position: 'right', ...axisCommon() },
    series: out,
  };
}

function linreg(pts: [number, number, ...unknown[]][]) {
  const n = pts.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  return { slope, intercept: (sy - slope * sx) / n };
}

const emptyOption = (text: string) => ({ title: { text, left: 'center', top: 'middle', textStyle: { color: T.ink.muted, fontSize: 13, fontWeight: 400 } } });

type Pt = [number, number, unknown, unknown];
/** 행 → [x, y, 툴팁값, _dataset 값] (숫자가 아닌 좌표는 제외). 뒤 두 값은 점 클릭으로 선택할 때 씀 */
function points(rows: unknown[][], xi: number, yi: number, ti: number, dsi: number, only?: Set<unknown[]> | null): Pt[] {
  const out: Pt[] = [];
  for (const r of rows) {
    if (only && !only.has(r)) continue;
    const x = num(r[xi]), y = num(r[yi]);
    if (x !== null && y !== null) out.push([x, y, ti >= 0 ? r[ti] : undefined, dsi >= 0 ? r[dsi] : undefined]);
  }
  return out;
}

/** 선택 연동으로 강조된 점: 크게 + 파문 효과, 같은 이름이라 범례 토글도 함께 */
function selectedSeries(name: string, color: string, data: Pt[]) {
  return {
    name,
    type: 'effectScatter',
    data,
    symbolSize: 13,
    rippleEffect: { brushType: 'stroke', scale: 2.4, period: 3 },
    itemStyle: { color, borderColor: T.ink.surface, borderWidth: 2 },
    z: 10,
  };
}

const tipLine = (cfg: ChartConfig, v: unknown) => (cfg.tip && v !== undefined && v !== null ? `${cfg.tip}: <b>${v}</b><br/>` : '');

function scatter(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const ti = colIdx(d, cfg.tip);
  const dsi = colIdx(d, DS_COL);
  const ys = (cfg.y ?? []).filter((y) => colIdx(d, y) >= 0);
  const groups = seriesGroups(d, cfg.series);
  const sel = selectedRows(d);
  const hl = !!sel?.size;
  const out: any[] = [];
  let k = 0;
  for (const [gname, rows] of groups) {
    for (const y of ys) {
      const yi = colIdx(d, y);
      const pts = points(rows, xi, yi, ti, dsi);
      const name = gname ? (ys.length > 1 ? `${gname} · ${y}` : gname) : y;
      const color = T.series[k++ % T.series.length];
      out.push({ name, type: 'scatter', data: pts, symbolSize: 7, large: !hl && pts.length > 5000, itemStyle: { color, opacity: hl ? 0.12 : 0.5, borderColor: T.ink.surface, borderWidth: 1 } });
      if (hl) out.push(selectedSeries(name, color, points(rows, xi, yi, ti, dsi, sel)));
      if (cfg.trendline) {
        const lr = linreg(pts);
        if (lr) {
          const xs = pts.map((p) => p[0]);
          const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
          out.push({
            name,
            type: 'line',
            data: [[x0, lr.slope * x0 + lr.intercept], [x1, lr.slope * x1 + lr.intercept]],
            symbol: 'none',
            lineStyle: { width: 2, color, type: 'dashed' },
            tooltip: { show: false },
            silent: true,
            z: 5,
          });
        }
      }
    }
  }
  const b = base(groups.length * ys.length > 1);
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'item', formatter: (p: any) => `${p.seriesName}<br/>${tipLine(cfg, p.value[2])}${cfg.x}: <b>${round(p.value[0])}</b><br/>${ys.length === 1 ? ys[0] : 'y'}: <b>${round(p.value[1])}</b>` },
    xAxis: { type: 'value', scale: true, name: cfg.x, nameLocation: 'middle', nameGap: 24, ...axisCommon() },
    yAxis: { type: 'value', scale: true, name: ys.length === 1 ? ys[0] : undefined, nameLocation: 'middle', nameGap: 36, ...axisCommon() },
    grid: { ...b.grid, left: 26, bottom: 26 },
    series: out,
  };
}

function niceStep(span: number, n = 5) {
  const raw = span / n;
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}
const fix = (v: number) => Number(v.toPrecision(12));

/**
 * 좌표 분포 (X·Y 위치): 핀/부품 위치처럼 두 값이 한 점의 좌표인 데이터.
 * 상관 산점도와 달리 축 눈금을 1:1 로 맞추고, 기준 위치·허용 범위·그룹별 평균 중심을 함께 표시.
 */
function xyPlot(cfg: ChartConfig, d: FramePayload, size?: ChartSize) {
  const xi = colIdx(d, cfg.x);
  const yName = cfg.y?.[0];
  const yi = colIdx(d, yName);
  const ti = colIdx(d, cfg.tip);
  const dsi = colIdx(d, DS_COL);
  if (xi < 0 || yi < 0) return emptyOption('Set the X and Y columns');
  const sel = selectedRows(d);
  const hl = !!sel?.size;

  const sp = cfg.spec ?? {};
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const shape = sp.shape ?? 'none';
  const hasSpec =
    shape !== 'none' && finite(sp.cx) && finite(sp.cy) && (shape === 'circle' ? finite(sp.r) && sp.r > 0 : finite(sp.dx) && finite(sp.dy) && sp.dx > 0 && sp.dy > 0);
  const inSpec = (x: number, y: number) =>
    !hasSpec || (shape === 'circle' ? (x - sp.cx!) ** 2 + (y - sp.cy!) ** 2 <= sp.r! ** 2 : Math.abs(x - sp.cx!) <= sp.dx! && Math.abs(y - sp.cy!) <= sp.dy!);

  const groups = seriesGroups(d, cfg.series);
  const series: any[] = [];
  let xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
  const extend = (x: number, y: number) => {
    xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); ylo = Math.min(ylo, y); yhi = Math.max(yhi, y);
  };
  let total = 0, outside = 0;
  const single = `${cfg.x} × ${yName}`;
  groups.forEach(([g, rows], k) => {
    const name = g || single;
    const color = T.series[k % T.series.length];
    const pts = points(rows, xi, yi, ti, dsi);
    if (!pts.length) return;
    const ins: Pt[] = [], outs: Pt[] = [];
    let sx = 0, sy = 0;
    for (const p of pts) {
      extend(p[0], p[1]);
      (inSpec(p[0], p[1]) ? ins : outs).push(p);
      sx += p[0]; sy += p[1];
    }
    total += pts.length;
    outside += outs.length;
    series.push({ name, type: 'scatter', data: ins, symbolSize: 6, large: !hl && ins.length > 5000, itemStyle: { color, opacity: hl ? 0.12 : 0.55, borderColor: T.ink.surface, borderWidth: 0.5 } });
    if (outs.length)
      series.push({ name, type: 'scatter', data: outs, symbol: 'triangle', symbolSize: 9, itemStyle: { color, opacity: hl ? 0.2 : 1, borderColor: T.ink.primary, borderWidth: 1 }, z: 4 });
    if (hl) series.push(selectedSeries(name, color, points(rows, xi, yi, ti, dsi, sel)));
    if (cfg.centroid ?? true) {
      const mx = sx / pts.length, my = sy / pts.length;
      const sdx = Math.sqrt(pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0) / pts.length);
      const sdy = Math.sqrt(pts.reduce((a, p) => a + (p[1] - my) ** 2, 0) / pts.length);
      series.push({
        name,
        type: 'scatter',
        // 굵은 + 표시
        symbol: 'path://M-1,-0.18H1V0.18H-1Z M-0.18,-1H0.18V1H-0.18Z',
        symbolSize: 18,
        itemStyle: { color, borderColor: T.ink.surface, borderWidth: 1.5 },
        data: [{ value: [mx, my], centroid: { n: pts.length, sdx, sdy } }],
        z: 12,
      });
    }
  });
  if (!total) return emptyOption('No points to show');

  // 축 좌표 배경 이미지도 1:1 축 범위 안에 들어오게
  const bgBox = bgAxisBox(cfg.background, cfg.kind);
  if (bgBox) {
    extend(bgBox[0], bgBox[1]);
    extend(bgBox[2], bgBox[3]);
  }

  if (hasSpec) {
    const cx = sp.cx!, cy = sp.cy!;
    let ring: number[][];
    if (shape === 'circle') {
      ring = Array.from({ length: 73 }, (_, i) => [cx + sp.r! * Math.cos((i / 72) * 2 * Math.PI), cy + sp.r! * Math.sin((i / 72) * 2 * Math.PI)]);
      extend(cx - sp.r!, cy - sp.r!);
      extend(cx + sp.r!, cy + sp.r!);
    } else {
      const [dx, dy] = [sp.dx!, sp.dy!];
      ring = [[cx - dx, cy - dy], [cx + dx, cy - dy], [cx + dx, cy + dy], [cx - dx, cy + dy], [cx - dx, cy - dy]];
      extend(cx - dx, cy - dy);
      extend(cx + dx, cy + dy);
    }
    series.unshift({
      name: 'Tolerance',
      type: 'line',
      data: ring,
      symbol: 'none',
      silent: true,
      lineStyle: { color: T.ink.secondary, width: 1.5, type: 'dashed' },
      markLine: {
        silent: true,
        symbol: 'none',
        label: { show: false },
        lineStyle: { color: T.ink.axis, width: 1, type: 'solid' },
        data: [{ xAxis: cx }, { yAxis: cy }],
      },
      tooltip: { show: false },
      z: 1,
    });
  }

  const legend = groups.length > 1;
  const b = base(legend);
  const xAxis: any = { type: 'value', scale: true, name: cfg.x, nameLocation: 'middle', nameGap: 26, ...axisCommon() };
  const yAxis: any = { type: 'value', scale: true, name: yName, nameLocation: 'middle', nameGap: 46, ...axisCommon() };
  let grid: any = { ...b.grid, left: 30, bottom: 28, top: legend ? 34 : 24 };

  // 1:1 축: 두 축의 범위 폭과 눈금 간격을 같게 하고, 그리는 영역을 정사각형으로
  if ((cfg.equal ?? true) && size && size.width > 120 && size.height > 120) {
    const span = Math.max(xhi - xlo, yhi - ylo) * 1.1 || Math.abs(xlo) * 0.1 || 1;
    const step = niceStep(span);
    const f0x = Math.floor(xlo / step), f0y = Math.floor(ylo / step);
    const nx = Math.max(1, Math.ceil(xhi / step) - f0x), ny = Math.max(1, Math.ceil(yhi / step) - f0y);
    const n = Math.max(nx, ny);
    const xmin = (f0x - Math.floor((n - nx) / 2)) * step;
    const ymin = (f0y - Math.floor((n - ny) / 2)) * step;
    const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const fmt = (v: number) => v.toFixed(dec);
    Object.assign(xAxis, { scale: false, min: fix(xmin), max: fix(xmin + n * step), interval: step, axisLabel: { ...xAxis.axisLabel, formatter: fmt } });
    Object.assign(yAxis, { scale: false, min: fix(ymin), max: fix(ymin + n * step), interval: step, axisLabel: { ...yAxis.axisLabel, formatter: fmt } });
    const left = 64, right = 16, top = legend ? 34 : 24, bottom = 42;
    const side = Math.max(60, Math.min(size.width - left - right, size.height - top - bottom));
    grid = { left: left + (size.width - left - right - side) / 2, top: top + (size.height - top - bottom - side) / 2, width: side, height: side, containLabel: false };
  }

  const graphic = hasSpec
    ? [{ type: 'text', right: 12, top: 2, style: { text: `Out of range ${outside.toLocaleString()} / ${total.toLocaleString()} (${((outside / total) * 100).toFixed(1)}%)`, fill: outside ? T.ink.primary : T.ink.muted, fontSize: 12, fontWeight: outside ? 600 : 400 } }]
    : [];

  return {
    ...b,
    // 범례가 오른쪽 위 '범위 밖' 문구와 겹치지 않도록 폭 제한 (넘치면 스크롤)
    legend: legend ? { ...b.legend, type: 'scroll', width: Math.max(120, (size?.width || 400) - (hasSpec ? 200 : 24)), data: groups.map(([g]) => g) } : b.legend,
    graphic,
    tooltip: {
      ...b.tooltip,
      trigger: 'item',
      formatter: (p: any) => {
        const c = p.data?.centroid;
        if (c)
          return `${p.seriesName} · centroid (n=${c.n.toLocaleString()})<br/>${cfg.x}: <b>${round(p.value[0])}</b> ± ${round(c.sdx)}<br/>${yName}: <b>${round(p.value[1])}</b> ± ${round(c.sdy)}`;
        const v = p.value as Pt;
        const off = hasSpec && !inSpec(v[0], v[1]) ? '<br/><b>Out of range</b>' : '';
        return `${p.seriesName}<br/>${tipLine(cfg, v[2])}${cfg.x}: <b>${round(v[0])}</b><br/>${yName}: <b>${round(v[1])}</b>${off}`;
      },
    },
    grid,
    xAxis,
    yAxis,
    series,
  };
}

/** 평균 mean, 표준편차(모집단) sd 인 정규분포의 x 에서의 밀도값 */
function normalPdf(x: number, mean: number, sd: number) {
  return Math.exp(-0.5 * ((x - mean) / sd) ** 2) / (sd * Math.sqrt(2 * Math.PI));
}

/** 공정능력(Cp/Cpk): 규격 하한(LSL)/상한(USL) 대비 데이터가 3σ 안에 얼마나 여유 있게 들어있는지 */
function capability(all: number[], lim: NonNullable<ChartConfig['limits']>) {
  const n = all.length;
  const mean = all.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(all.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const oob = all.filter((v) => (lim.lsl != null && v < lim.lsl) || (lim.usl != null && v > lim.usl)).length;
  const common = { mean, sd, n, oobPct: (oob / n) * 100 };
  // 데이터에 편차가 거의 없으면(표준편차≈0) 나누기로 의미 없이 큰 값이 나오는 대신 "계산 불가"로 표시
  if (n < 2 || sd < 1e-9) return { ...common, cpk: null, cp: null, noVariance: true };
  const cpu = lim.usl != null ? (lim.usl - mean) / (3 * sd) : undefined;
  const cpl = lim.lsl != null ? (mean - lim.lsl) / (3 * sd) : undefined;
  const cpk = Math.min(...[cpu, cpl].filter((v): v is number => v !== undefined));
  const cp = lim.usl != null && lim.lsl != null ? (lim.usl - lim.lsl) / (6 * sd) : null;
  return { ...common, cpk, cp, noVariance: false };
}

function histogram(cfg: ChartConfig, d: FramePayload, size?: ChartSize) {
  const xi = colIdx(d, cfg.x);
  const bins = Math.max(2, cfg.bins ?? 20);
  const groups = seriesGroups(d, cfg.series);
  const all = d.rows.map((r) => num(r[xi])).filter((v): v is number => v !== null);
  if (!all.length) return { title: { text: 'No data', left: 'center', top: 'middle', textStyle: { color: T.ink.muted, fontSize: 13 } } };
  const lo = Math.min(...all), hi = Math.max(...all);
  const w = (hi - lo) / bins || 1;
  const labels = Array.from({ length: bins }, (_, i) => round(lo + w * (i + 0.5)));
  const out: any[] = groups.map(([g, rows]) => {
    const counts = new Array(bins).fill(0);
    rows.forEach((r) => {
      const v = num(r[xi]);
      if (v === null) return;
      counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
    });
    return { name: g || cfg.x, type: 'bar', data: counts, barGap: '0%', barCategoryGap: '4%', itemStyle: { borderRadius: [4, 4, 0, 0], opacity: groups.length > 1 ? 0.8 : 1 } };
  });

  const lim = cfg.limits;
  const cap = lim && (lim.lsl != null || lim.usl != null) ? capability(all, lim) : null;
  if (cap && !cap.noVariance) {
    // 전체(그룹 구분 없이) 평균/표준편차를 따르는 정규분포 참고선 — 막대 수와 같은 척도(개수)로 스케일
    out.push({
      name: 'Normal fit',
      type: 'line',
      data: labels.map((x) => round(normalPdf(x, cap.mean, cap.sd) * cap.n * w)),
      smooth: true,
      symbol: 'none',
      lineStyle: { width: 2, color: T.ink.secondary, type: 'dashed' },
      tooltip: { show: false },
      silent: true,
      z: 5,
    });
  }

  const legend = out.length > 1;
  const b = base(legend);
  const graphic: any[] = [];
  let grid: any = { ...b.grid, left: 22, bottom: 26 };

  if (cap && size && size.width > 160 && size.height > 140) {
    // Cp/Cpk 주석을 정확한 픽셀 위치에 그리려고 이 경우만 containLabel 을 끄고 여백을 직접 계산
    const left = 46, right = 16, top = legend ? 34 : 18, bottom = 34;
    grid = { left, right, top, bottom, containLabel: false };
    const pw = Math.max(1, size.width - left - right);
    const ph = Math.max(1, size.height - top - bottom);
    const xOf = (v: number) => left + ((v - lo) / (hi - lo || 1)) * pw;
    (['lsl', 'usl'] as const).forEach((key) => {
      const v = lim![key];
      if (v == null) return;
      const x = Math.max(left, Math.min(left + pw, xOf(v)));
      graphic.push(
        { type: 'line', silent: true, position: [x, 0], shape: { x1: 0, y1: top, x2: 0, y2: top + ph }, style: { stroke: T.series[1], lineWidth: 2, lineDash: [5, 4] } },
        { type: 'text', silent: true, position: [x + 4, top + 2], style: { text: key.toUpperCase(), fill: T.series[1], fontSize: 11, fontWeight: 600 } },
      );
    });
    const bad = cap.cpk != null && cap.cpk < 1;
    const parts = [
      cap.noVariance ? 'Cpk N/A (no variation)' : cap.cpk != null ? `Cpk ${cap.cpk.toFixed(2)}` : '',
      cap.cp != null ? `Cp ${cap.cp.toFixed(2)}` : '',
      `μ ${round(cap.mean)}`,
      `σ ${round(cap.sd)}`,
      `Out of spec ${cap.oobPct.toFixed(1)}% (n=${cap.n})`,
    ];
    graphic.push({
      type: 'text',
      silent: true,
      position: [left + 6, top + 4],
      style: { text: parts.filter(Boolean).join(' · '), fill: bad ? T.ink.primary : T.ink.muted, fontWeight: bad ? 700 : 500, fontSize: 12 },
    });
  }

  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: labels, name: cfg.x, nameLocation: 'middle', nameGap: 24, ...axisCommon(), splitLine: { show: false } },
    yAxis: { type: 'value', name: 'Count', nameLocation: 'middle', nameGap: 30, ...axisCommon() },
    graphic,
    grid,
    series: out,
  };
}

/**
 * 3D 산점도: 세 숫자 컬럼을 X·Y·Z 좌표로 그림 (echarts-gl). 마우스 드래그로 회전, 휠로 확대/축소.
 */
function scatter3D(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const yi = colIdx(d, cfg.y?.[0]);
  const zi = colIdx(d, cfg.z);
  const ti = colIdx(d, cfg.tip);
  const dsi = colIdx(d, DS_COL);
  if (xi < 0 || yi < 0 || zi < 0) return emptyOption('Set the X, Y and Z columns');
  const groups = seriesGroups(d, cfg.series);
  const series: any[] = [];
  let total = 0;
  groups.forEach(([g, rows], k) => {
    const color = T.series[k % T.series.length];
    const pts: [number, number, number, unknown, unknown][] = [];
    for (const r of rows) {
      const x = num(r[xi]), y = num(r[yi]), z = num(r[zi]);
      if (x !== null && y !== null && z !== null) pts.push([x, y, z, ti >= 0 ? r[ti] : undefined, dsi >= 0 ? r[dsi] : undefined]);
    }
    if (!pts.length) return;
    total += pts.length;
    series.push({ name: g || [cfg.x, cfg.y?.[0], cfg.z].join(' · '), type: 'scatter3D', data: pts, symbolSize: 6, itemStyle: { color, opacity: 0.85 } });
  });
  if (!total) return emptyOption('No points to show');

  const legend = groups.length > 1;
  const { grid: _grid, ...b } = base(legend);
  return {
    ...b,
    tooltip: {
      ...b.tooltip,
      formatter: (p: any) =>
        `${p.seriesName}<br/>${tipLine(cfg, p.value[3])}${cfg.x}: <b>${round(p.value[0])}</b><br/>${cfg.y?.[0]}: <b>${round(p.value[1])}</b><br/>${cfg.z}: <b>${round(p.value[2])}</b>`,
    },
    legend: legend ? b.legend : { show: false },
    grid3D: {
      viewControl: { projection: 'perspective', autoRotate: false, distance: 180 },
      axisLine: { lineStyle: { color: T.ink.axis } },
      axisLabel: { color: T.ink.muted, fontSize: 10 },
      splitLine: { lineStyle: { color: T.ink.grid } },
      light: { main: { intensity: 1.2, shadow: false }, ambient: { intensity: 0.35 } },
    },
    xAxis3D: { type: 'value', name: cfg.x, axisLabel: { formatter: (v: number) => round(v) }, nameTextStyle: { color: T.ink.secondary } },
    yAxis3D: { type: 'value', name: cfg.y?.[0], axisLabel: { formatter: (v: number) => round(v) }, nameTextStyle: { color: T.ink.secondary } },
    zAxis3D: { type: 'value', name: cfg.z, axisLabel: { formatter: (v: number) => round(v) }, nameTextStyle: { color: T.ink.secondary } },
    series,
  };
}

function heatmap(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const valueCols = (cfg.y?.length ? cfg.y : d.columns.filter((c, i) => i !== xi && c.dtype === 'number').map((c) => c.name)).filter((c) => colIdx(d, c) >= 0);
  const rowLabels = d.rows.map((r, i) => (xi >= 0 ? String(r[xi]) : String(i)));
  const data: [number, number, number | null][] = [];
  let lo = Infinity, hi = -Infinity;
  d.rows.forEach((r, ri) =>
    valueCols.forEach((c, ci) => {
      const v = num(r[colIdx(d, c)]);
      if (v !== null) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      data.push([ci, ri, v === null ? null : round(v)]);
    }),
  );
  const isCorr = lo >= -1 && hi <= 1;
  const showLabels = valueCols.length * d.rows.length <= 144;
  const b = base(false);
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'item', formatter: (p: any) => `${rowLabels[p.value[1]]} × ${valueCols[p.value[0]]}<br/><b>${p.value[2] ?? '-'}</b>` },
    grid: { left: 8, right: 8, top: 8, bottom: 44, containLabel: true },
    xAxis: { type: 'category', data: valueCols, ...axisCommon(), axisLabel: { ...axisCommon().axisLabel, rotate: 30 }, splitLine: { show: false } },
    yAxis: { type: 'category', data: rowLabels, inverse: true, ...axisCommon(), splitLine: { show: false } },
    visualMap: {
      min: isCorr ? -1 : lo,
      max: isCorr ? 1 : hi,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      itemWidth: 10,
      textStyle: { color: T.ink.muted, fontSize: 10 },
      inRange: { color: T.diverging },
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: { show: showLabels, fontSize: 11, color: T.ink.primary, formatter: (p: any) => (p.value[2] == null ? '' : Number(p.value[2]).toFixed(2)) },
        itemStyle: { borderColor: T.ink.surface, borderWidth: 2, borderRadius: 6 },
        emphasis: { itemStyle: { borderColor: T.ink.primary, borderWidth: 1 } },
      },
    ],
  };
}

function quantile(sorted: number[], q: number) {
  const pos = (sorted.length - 1) * q;
  const b = Math.floor(pos);
  return sorted[b + 1] !== undefined ? sorted[b] + (pos - b) * (sorted[b + 1] - sorted[b]) : sorted[b];
}

function box(cfg: ChartConfig, d: FramePayload) {
  const ys = (cfg.y ?? []).filter((y) => colIdx(d, y) >= 0);
  const groups = seriesGroups(d, cfg.x);
  const cats = groups.map(([g]) => g || 'All');
  const out = ys.map((y) => {
    const yi = colIdx(d, y);
    return {
      name: y,
      type: 'boxplot',
      itemStyle: { borderWidth: 1.5 },
      data: groups.map(([, rows]) => {
        const v = rows.map((r) => num(r[yi])).filter((x): x is number => x !== null).sort((a, b) => a - b);
        if (!v.length) return [];
        return [v[0], quantile(v, 0.25), quantile(v, 0.5), quantile(v, 0.75), v[v.length - 1]].map(round);
      }),
    };
  });
  const b = base(out.length > 1);
  return { ...b, tooltip: { ...b.tooltip, trigger: 'item' }, xAxis: { type: 'category', data: cats, ...axisCommon(), splitLine: { show: false } }, yAxis: { type: 'value', scale: true, ...axisCommon() }, series: out };
}

function pie(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const yi = colIdx(d, cfg.y?.[0]);
  const m = new Map<string, number[]>();
  d.rows.forEach((r) => {
    const key = String(r[xi]);
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(yi >= 0 ? num(r[yi]) ?? 0 : 1);
  });
  let data = [...m.entries()].map(([name, vs]) => ({ name, value: round(aggregate(vs, yi >= 0 ? (cfg.agg && cfg.agg !== 'none' ? cfg.agg : 'sum') : 'count') ?? 0) }));
  data.sort((a, b) => b.value - a.value);
  if (data.length > 6) {
    const rest = data.slice(5).reduce((a, b) => a + b.value, 0);
    data = [...data.slice(0, 5), { name: 'Other', value: round(rest) }];
  }
  const b = base(true);
  return {
    ...b,
    legend: { ...b.legend, type: 'scroll' },
    tooltip: { ...b.tooltip, trigger: 'item', formatter: '{b}: <b>{c}</b> ({d}%)' },
    series: [{ type: 'pie', radius: ['48%', '74%'], top: 24, data, label: { color: T.ink.secondary, fontSize: 11 }, itemStyle: { borderColor: T.ink.surface, borderWidth: 2, borderRadius: 6 } }],
  };
}

export function neededColumns(w: { type: string; chart?: ChartConfig; stat?: { column?: string }; table?: { columns?: string[] } }): string[] {
  if (w.type === 'chart' && w.chart) {
    if (w.chart.kind === 'heatmap' && !w.chart.y?.length) return [];
    const ys = w.chart.kind === 'xy' || w.chart.kind === 'scatter3d' ? (w.chart.y ?? []).slice(0, 1) : w.chart.y ?? [];
    const tip = w.chart.kind === 'scatter' || w.chart.kind === 'xy' || w.chart.kind === 'scatter3d' ? w.chart.tip : undefined;
    const z = w.chart.kind === 'scatter3d' ? w.chart.z : undefined;
    return [...new Set([w.chart.x, ...ys, w.chart.series, tip, z].filter(Boolean) as string[])];
  }
  if (w.type === 'stat') return w.stat?.column ? [w.stat.column] : [];
  if (w.type === 'table') return w.table?.columns ?? [];
  return [];
}
