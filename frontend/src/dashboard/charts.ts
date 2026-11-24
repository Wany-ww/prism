import type { FramePayload } from '../api';
import type { Mode } from '../theme';

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

export type ChartKind = 'line' | 'area' | 'bar' | 'scatter' | 'histogram' | 'heatmap' | 'box' | 'pie';
export type ChartConfig = {
  kind: ChartKind;
  x?: string;
  y?: string[];
  series?: string;
  agg?: 'none' | 'mean' | 'sum' | 'count' | 'min' | 'max';
  bins?: number;
  trendline?: boolean;
  stack?: boolean;
  sort?: 'none' | 'asc' | 'desc';
};

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

function seriesGroups(d: FramePayload, seriesCol?: string): [string, unknown[][]][] {
  const si = colIdx(d, seriesCol);
  if (si < 0) return [['', d.rows]];
  const m = new Map<string, unknown[][]>();
  for (const r of d.rows) {
    const k = r[si] == null ? '(없음)' : String(r[si]);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export function buildOption(cfg: ChartConfig, d: FramePayload, mode: Mode = 'light'): any {
  T = THEMES[mode];
  switch (cfg.kind) {
    case 'heatmap':
      return heatmap(cfg, d);
    case 'histogram':
      return histogram(cfg, d);
    case 'scatter':
      return scatter(cfg, d);
    case 'box':
      return box(cfg, d);
    case 'pie':
      return pie(cfg, d);
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

function linreg(pts: [number, number][]) {
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

function scatter(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const ys = (cfg.y ?? []).filter((y) => colIdx(d, y) >= 0);
  const groups = seriesGroups(d, cfg.series);
  const out: any[] = [];
  let k = 0;
  for (const [gname, rows] of groups) {
    for (const y of ys) {
      const yi = colIdx(d, y);
      const pts = rows.map((r) => [num(r[xi]), num(r[yi])]).filter((p) => p[0] !== null && p[1] !== null) as [number, number][];
      const name = gname ? (ys.length > 1 ? `${gname} · ${y}` : gname) : y;
      const color = T.series[k++ % T.series.length];
      out.push({ name, type: 'scatter', data: pts, symbolSize: 7, itemStyle: { color, opacity: 0.5, borderColor: T.ink.surface, borderWidth: 1 } });
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
    tooltip: { ...b.tooltip, trigger: 'item', formatter: (p: any) => `${p.seriesName}<br/>${cfg.x}: <b>${round(p.value[0])}</b><br/>${ys.length === 1 ? ys[0] : 'y'}: <b>${round(p.value[1])}</b>` },
    xAxis: { type: 'value', scale: true, name: cfg.x, nameLocation: 'middle', nameGap: 24, ...axisCommon() },
    yAxis: { type: 'value', scale: true, name: ys.length === 1 ? ys[0] : undefined, nameLocation: 'middle', nameGap: 36, ...axisCommon() },
    grid: { ...b.grid, left: 26, bottom: 26 },
    series: out,
  };
}

function histogram(cfg: ChartConfig, d: FramePayload) {
  const xi = colIdx(d, cfg.x);
  const bins = Math.max(2, cfg.bins ?? 20);
  const groups = seriesGroups(d, cfg.series);
  const all = d.rows.map((r) => num(r[xi])).filter((v): v is number => v !== null);
  if (!all.length) return { title: { text: '데이터 없음', left: 'center', top: 'middle', textStyle: { color: T.ink.muted, fontSize: 13 } } };
  const lo = Math.min(...all), hi = Math.max(...all);
  const w = (hi - lo) / bins || 1;
  const labels = Array.from({ length: bins }, (_, i) => round(lo + w * (i + 0.5)));
  const out = groups.map(([g, rows]) => {
    const counts = new Array(bins).fill(0);
    rows.forEach((r) => {
      const v = num(r[xi]);
      if (v === null) return;
      counts[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
    });
    return { name: g || cfg.x, type: 'bar', data: counts, barGap: '0%', barCategoryGap: '4%', itemStyle: { borderRadius: [4, 4, 0, 0], opacity: groups.length > 1 ? 0.8 : 1 } };
  });
  const b = base(out.length > 1);
  return {
    ...b,
    tooltip: { ...b.tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
    xAxis: { type: 'category', data: labels, name: cfg.x, nameLocation: 'middle', nameGap: 24, ...axisCommon(), splitLine: { show: false } },
    yAxis: { type: 'value', name: '개수', ...axisCommon() },
    grid: { ...b.grid, bottom: 26 },
    series: out,
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
  const cats = groups.map(([g]) => g || '전체');
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
    data = [...data.slice(0, 5), { name: '기타', value: round(rest) }];
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
    return [w.chart.x, ...(w.chart.y ?? []), w.chart.series].filter(Boolean) as string[];
  }
  if (w.type === 'stat') return w.stat?.column ? [w.stat.column] : [];
  if (w.type === 'table') return w.table?.columns ?? [];
  return [];
}
