import { Alert, Table, Tooltip } from 'antd';
import ReactECharts from 'echarts-for-react';
import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Sparkline from '../components/Sparkline';
import StageHeader from '../components/StageHeader';
import { useTheme } from '../theme';

/** 서버가 5초마다 모으는 표본 하나 (Windows 가 아니면 자원 값은 비어 있음) */
type Sample = {
  t: number;
  cpu?: number;
  mem_total?: number;
  mem_used?: number;
  prism_cpu?: number;
  prism_rss?: number;
  pg_cpu?: number;
  pg_rss?: number;
  net_rx?: number;
  net_tx?: number;
  disk_total?: number;
  disk_used?: number;
  db_conns?: number;
  db_active?: number;
  db_idle_tx?: number;
  db_size?: number;
  db_commit?: number;
  db_rollback?: number;
  db_ins?: number;
  db_upd?: number;
  db_del?: number;
  db_fetch?: number;
  db_hit?: number;
  db_ping_ms?: number;
  db_error?: string;
};
type Metrics = {
  interval: number;
  samples: Sample[];
  procs: { group: string; count: number; rss: number; cpu: number | null }[];
  dirs: { name: string; path: string; desc: string; bytes: number; files: number }[];
  info: { host: string; os: string; python: string; cpu_count: number; server_started: number; boot_time?: number; db_kind: string; data_dir: string };
};
type DbDetail = {
  kind: string;
  version: string;
  started?: number;
  database?: string;
  size: number;
  settings: { name: string; value: string; unit: string }[];
  totals?: { commits: number; rollbacks: number; cache_hit: number | null; deadlocks: number; temp_bytes: number };
  tables: { name: string; rows: number; total?: number; data?: number; index?: number; seq_scan?: number; idx_scan?: number; last_vacuum?: number | null; dead_rows?: number }[];
  connections: { pid: number; app: string; client: string; state: string; since: number | null; wait: string; query: string }[];
};

const WINDOWS = [
  { label: '5m', sec: 300 },
  { label: '15m', sec: 900 },
  { label: '1h', sec: 3600 },
];
// 검증된 범주형 팔레트 순서 (nav.ts ACCENTS 와 같음)
const C = { blue: '#3182f6', red: '#f04452', teal: '#18a5a5', orange: '#fe9800', purple: '#a234c7', green: '#03b26c' };
const KEEP = 720;
/** 그래프 가로축 범위 (선택한 기간) */
const WindowCtx = createContext({ end: 0, start: 0 });

export function fmtBytes(b?: number | null, digits = 1) {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
}
const fmtRate = (b?: number | null) => (b == null ? '–' : `${fmtBytes(b)}/s`);
const fmtNum = (v?: number | null, d = 1) => (v == null ? '–' : v.toLocaleString(undefined, { maximumFractionDigits: d }));
function fmtDur(sec?: number | null) {
  if (sec == null || sec < 0) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(sec % 60)}s`;
}
const pct = (a?: number, b?: number) => (a != null && b ? (100 * a) / b : undefined);

type Level = 'ok' | 'warn' | 'bad';
const level = (v: number | undefined, warn: number, bad: number): Level => (v == null ? 'ok' : v >= bad ? 'bad' : v >= warn ? 'warn' : 'ok');
const LEVEL_LABEL: Record<Level, string> = { ok: 'Normal', warn: 'High', bad: 'Critical' };
const LEVEL_CLS: Record<Level, string> = { ok: 'st-ok', warn: 'st-warning', bad: 'st-error' };

/** 상단 KPI 타일: 값 + 보조 설명 + 최근 추이 */
function Kpi({ label, value, sub, trend, color, lv, hint }: { label: string; value: ReactNode; sub?: ReactNode; trend?: number[]; color?: string; lv?: Level; hint?: string }) {
  return (
    <div className="tile sys-kpi">
      <div className="tile-label">
        <Tooltip title={hint}>
          <span>{label}</span>
        </Tooltip>
        {lv && lv !== 'ok' && <span className={`st ${LEVEL_CLS[lv]}`} style={{ padding: '0 6px', fontSize: 11 }}>{LEVEL_LABEL[lv]}</span>}
      </div>
      <div className="sys-kpi-row">
        <div style={{ minWidth: 0 }}>
          <div className="tile-value">{value}</div>
          {sub && <div className="tile-sub num">{sub}</div>}
        </div>
        {trend && <Sparkline data={trend} color={color} />}
      </div>
    </div>
  );
}

type Line = { name: string; color: string; key: (s: Sample) => number | undefined; area?: boolean };

/** 시간축 선 그래프 (한 축, 같은 단위의 계열만) */
function TimeChart({ title, sub, samples, lines, fmt, max, height = 220 }: { title: string; sub?: string; samples: Sample[]; lines: Line[]; fmt: (v: number) => string; max?: number; height?: number; now?: number }) {
  const { mode } = useTheme();
  const range = useContext(WindowCtx);
  const option = useMemo(() => {
    const ink2 = mode === 'dark' ? '#9e9ea4' : '#4e5968';
    const ink3 = mode === 'dark' ? '#7e7e87' : '#8b95a1';
    const grid = mode === 'dark' ? '#2c2c35' : '#f2f4f6';
    const surface = mode === 'dark' ? '#202027' : '#ffffff';
    return {
      animation: false,
      color: lines.map((l) => l.color),
      grid: { left: 8, right: 12, top: 34, bottom: 4, containLabel: true },
      legend: lines.length > 1 ? { top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, itemGap: 14, textStyle: { color: ink2, fontSize: 12 } } : undefined,
      tooltip: {
        trigger: 'axis',
        backgroundColor: surface,
        borderColor: grid,
        textStyle: { color: mode === 'dark' ? '#e4e4e5' : '#191f28', fontSize: 12 },
        axisPointer: { type: 'line', lineStyle: { color: ink3, width: 1 } },
        valueFormatter: (v: number) => (v == null ? '–' : fmt(v)),
      },
      xAxis: {
        type: 'time',
        min: range.start * 1000,
        max: range.end * 1000,
        axisLine: { lineStyle: { color: grid } },
        axisTick: { show: false },
        axisLabel: { color: ink3, fontSize: 11, hideOverlap: true, formatter: '{HH}:{mm}' },
        splitLine: { show: false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max,
        interval: max === 100 ? 25 : undefined,
        splitNumber: 3,
        axisLabel: { color: ink3, fontSize: 11, formatter: (v: number) => fmt(v) },
        splitLine: { lineStyle: { color: grid } },
      },
      series: lines.map((l) => ({
        name: l.name,
        type: 'line',
        showSymbol: false,
        symbolSize: 8,
        lineStyle: { width: 2 },
        connectNulls: false,
        areaStyle: l.area ? { opacity: 0.1 } : undefined,
        emphasis: { focus: 'series' },
        data: samples.map((s) => [s.t * 1000, l.key(s) ?? null]),
      })),
    };
  }, [samples, lines, mode, max, range]);
  return (
    <div className="panel sys-chart">
      <div className="sys-chart-title">
        {title}
        {sub && <small>{sub}</small>}
      </div>
      <ReactECharts option={option} style={{ height }} notMerge={false} lazyUpdate />
    </div>
  );
}

/** 가로 막대 (용량 비교) */
function BarChart({ title, sub, rows, height }: { title: string; sub?: string; rows: { name: string; parts: { name: string; color: string; value: number }[] }[]; height?: number }) {
  const { mode } = useTheme();
  const option = useMemo(() => {
    const ink2 = mode === 'dark' ? '#9e9ea4' : '#4e5968';
    const ink3 = mode === 'dark' ? '#7e7e87' : '#8b95a1';
    const grid = mode === 'dark' ? '#2c2c35' : '#f2f4f6';
    const surface = mode === 'dark' ? '#202027' : '#ffffff';
    const names = rows.map((r) => r.name).reverse();
    const partNames = rows[0]?.parts.map((p) => p.name) ?? [];
    return {
      animationDuration: 500,
      grid: { left: 8, right: 16, top: partNames.length > 1 ? 30 : 6, bottom: 4, containLabel: true },
      legend: partNames.length > 1 ? { top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: ink2, fontSize: 12 } } : undefined,
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: surface, borderColor: grid, textStyle: { color: mode === 'dark' ? '#e4e4e5' : '#191f28', fontSize: 12 }, valueFormatter: (v: number) => fmtBytes(v) },
      xAxis: { type: 'value', splitNumber: 3, axisLabel: { color: ink3, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmtBytes(v, 0) }, splitLine: { lineStyle: { color: grid } } },
      yAxis: { type: 'category', data: names, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: ink2, fontSize: 12 } },
      series: partNames.map((pn, pi) => ({
        name: pn,
        type: 'bar',
        stack: 'total',
        barMaxWidth: 16,
        color: rows[0].parts[pi].color,
        itemStyle: { borderRadius: pi === partNames.length - 1 ? [0, 4, 4, 0] : 0, borderColor: surface, borderWidth: partNames.length > 1 ? 1 : 0 },
        data: [...rows].reverse().map((r) => r.parts[pi].value),
      })),
    };
  }, [rows, mode]);
  return (
    <div className="panel sys-chart">
      <div className="sys-chart-title">
        {title}
        {sub && <small>{sub}</small>}
      </div>
      <ReactECharts option={option} style={{ height: height ?? Math.max(120, rows.length * 30 + 40) }} />
    </div>
  );
}

/** 5초마다 새 표본만 받아 이어 붙임 */
function useMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [err, setErr] = useState('');
  const last = useRef(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get<Metrics>(`/api/system/metrics?since=${last.current}`);
        if (!alive) return;
        if (r.samples.length) {
          last.current = r.samples[r.samples.length - 1].t;
          setSamples((cur) => [...cur, ...r.samples].slice(-KEEP));
        }
        setM(r);
        setErr('');
      } catch (e: any) {
        if (alive) setErr(e.message);
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { m, samples, err };
}

function WindowTabs({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="pill-tabs">
      {WINDOWS.map((w) => (
        <div key={w.sec} className={`pill-tab ${value === w.sec ? 'active' : ''}`} onClick={() => onChange(w.sec)}>
          {w.label}
        </div>
      ))}
    </div>
  );
}

const lastOf = (samples: Sample[], k: keyof Sample) => {
  for (let i = samples.length - 1; i >= 0; i--) if (samples[i][k] != null) return samples[i][k] as number;
  return undefined;
};
const trendOf = (samples: Sample[], f: (s: Sample) => number | undefined) => samples.slice(-60).map((s) => f(s) ?? 0);

function Resources({ m, samples, win, now }: { m: Metrics | null; samples: Sample[]; win: Sample[]; now: number }) {
  const cpu = lastOf(samples, 'cpu');
  const memPct = pct(lastOf(samples, 'mem_used'), lastOf(samples, 'mem_total'));
  const diskPct = pct(lastOf(samples, 'disk_used'), lastOf(samples, 'disk_total'));
  const prism = m?.procs.find((p) => p.group === 'prism');
  const pg = m?.procs.find((p) => p.group === 'pg');
  const noRes = samples.length > 0 && cpu == null && lastOf(samples, 'mem_total') == null;
  const memTotal = lastOf(samples, 'mem_total');
  return (
    <>
      {noRes && <Alert type="info" showIcon message="이 서버 OS 에서는 CPU·메모리·네트워크 값을 읽지 못해 DB 값만 표시합니다." style={{ marginBottom: 12 }} />}
      <div className="tiles sys-kpis">
        <Kpi label="CPU" value={`${fmtNum(cpu)}%`} sub={`${m?.info.cpu_count ?? '–'} logical cores`} trend={trendOf(samples, (s) => s.cpu)} color={C.blue} lv={level(cpu, 80, 95)} hint="서버 PC 전체 CPU 사용률" />
        <Kpi
          label="Memory"
          value={`${fmtNum(memPct)}%`}
          sub={`${fmtBytes(lastOf(samples, 'mem_used'))} / ${fmtBytes(memTotal)}`}
          trend={trendOf(samples, (s) => pct(s.mem_used, s.mem_total))}
          color={C.purple}
          lv={level(memPct, 85, 95)}
        />
        <Kpi
          label="Disk (data drive)"
          value={`${fmtNum(diskPct)}%`}
          sub={`${fmtBytes((lastOf(samples, 'disk_total') ?? 0) - (lastOf(samples, 'disk_used') ?? 0))} free`}
          lv={level(diskPct, 85, 95)}
          hint={m?.info.data_dir}
        />
        <Kpi label="Network" value={`↓ ${fmtRate(lastOf(samples, 'net_rx'))}`} sub={`↑ ${fmtRate(lastOf(samples, 'net_tx'))}`} trend={trendOf(samples, (s) => s.net_rx)} color={C.teal} hint="이더넷·Wi-Fi 수신/송신 합계" />
        <Kpi label="PRISM server" value={fmtBytes(prism?.rss)} sub={`${prism?.count ?? '–'} processes · CPU ${fmtNum(prism?.cpu)}%`} trend={trendOf(samples, (s) => s.prism_rss)} color={C.teal} hint="웹 서버와 수집·Flow 작업, AI 에이전트 프로세스 합계" />
        <Kpi label="Uptime" value={fmtDur(m ? now - m.info.server_started : undefined)} sub={`PC booted ${fmtDur(m?.info.boot_time ? now - m.info.boot_time : undefined)} ago`} hint="PRISM 서버가 켜진 뒤 지난 시간" />
      </div>

      <div className="sys-grid">
        <TimeChart
          title="CPU"
          sub="%"
          now={now}
          samples={win}
          max={100}
          fmt={(v) => `${Math.round(v)}%`}
          lines={[
            { name: 'Server PC', color: C.blue, key: (s) => s.cpu, area: true },
            { name: 'PRISM', color: C.teal, key: (s) => s.prism_cpu },
            { name: 'PostgreSQL', color: C.purple, key: (s) => s.pg_cpu },
          ]}
        />
        <TimeChart
          title="Memory"
          sub={memTotal ? `of ${fmtBytes(memTotal)}` : undefined}
          now={now}
          samples={win}
          max={memTotal}
          fmt={(v) => fmtBytes(v, 1)}
          lines={[
            { name: 'Server PC used', color: C.blue, key: (s) => s.mem_used, area: true },
            { name: 'PRISM', color: C.teal, key: (s) => s.prism_rss },
            { name: 'PostgreSQL', color: C.purple, key: (s) => s.pg_rss },
          ]}
        />
        <TimeChart
          title="Network"
          sub="bytes/s"
          now={now}
          samples={win}
          fmt={(v) => fmtRate(v)}
          lines={[
            { name: 'Received', color: C.teal, key: (s) => s.net_rx, area: true },
            { name: 'Sent', color: C.orange, key: (s) => s.net_tx },
          ]}
        />
        <BarChart
          title="PRISM data folders"
          sub={m?.dirs.length ? `${fmtBytes(m.dirs.reduce((a, d) => a + d.bytes, 0))} total · updated every minute` : undefined}
          rows={(m?.dirs ?? []).map((d) => ({ name: `${d.name}  ${d.files.toLocaleString()} files`, parts: [{ name: 'Size', color: C.blue, value: d.bytes }] }))}
          height={220}
        />
      </div>

      <div className="section-title">
        Server
        <small>{m?.info.host}</small>
      </div>
      <div className="panel sys-info">
        {[
          ['OS', m?.info.os],
          ['Python', m?.info.python],
          ['Database', m?.info.db_kind],
          ['Data folder', m?.info.data_dir],
          ['PostgreSQL processes', pg ? `${pg.count} · ${fmtBytes(pg.rss)}` : '–'],
          ['Sample interval', m ? `${m.interval}s · last hour kept` : '–'],
        ].map(([k, v]) => (
          <div key={k as string}>
            <span className="muted">{k}</span>
            <b className="ellipsis">{v ?? '–'}</b>
          </div>
        ))}
      </div>
    </>
  );
}

function Database({ samples, win, now }: { samples: Sample[]; win: Sample[]; now: number }) {
  const [d, setD] = useState<DbDetail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () =>
      api
        .get<DbDetail>('/api/system/db')
        .then((r) => {
          setD(r);
          setErr('');
        })
        .catch((e) => setErr(e.message));
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);
  const isPg = d ? d.kind === 'PostgreSQL' : true;
  const maxConn = Number(d?.settings.find((s) => s.name === 'max_connections')?.value) || undefined;
  const conns = lastOf(samples, 'db_conns');
  const connPct = pct(conns, maxConn);
  const hit = lastOf(samples, 'db_hit') ?? d?.totals?.cache_hit ?? undefined;
  const dbErr = samples.length ? samples[samples.length - 1].db_error : undefined;
  const tables = (d?.tables ?? []).filter((t) => t.total != null).slice(0, 10);
  return (
    <>
      {(err || dbErr) && <Alert type="error" showIcon message={err || dbErr} style={{ marginBottom: 12 }} />}
      <div className="tiles sys-kpis">
        <Kpi label="Database size" value={fmtBytes(lastOf(samples, 'db_size') ?? d?.size)} sub={d ? `${d.kind} ${d.version}` : undefined} trend={trendOf(samples, (s) => s.db_size)} color={C.blue} />
        {isPg && (
          <>
            <Kpi
              label="Connections"
              value={fmtNum(conns, 0)}
              sub={`${fmtNum(lastOf(samples, 'db_active'), 0)} active · max ${maxConn ?? '–'}`}
              trend={trendOf(samples, (s) => s.db_conns)}
              color={C.purple}
              lv={level(connPct, 70, 90)}
            />
            <Kpi label="Transactions" value={`${fmtNum(lastOf(samples, 'db_commit'))}/s`} sub={`rollback ${fmtNum(lastOf(samples, 'db_rollback'))}/s`} trend={trendOf(samples, (s) => s.db_commit)} color={C.blue} />
            <Kpi label="Cache hit" value={`${fmtNum(hit, 2)}%`} sub="shared buffer hits" trend={trendOf(samples, (s) => s.db_hit)} color={C.green} lv={hit == null ? 'ok' : hit < 90 ? 'bad' : hit < 97 ? 'warn' : 'ok'} hint="디스크 대신 메모리에서 읽은 비율. 낮으면 shared_buffers 를 늘려 보세요." />
          </>
        )}
        <Kpi label="Query latency" value={`${fmtNum(lastOf(samples, 'db_ping_ms'), 2)} ms`} sub="SELECT 1 round trip" trend={trendOf(samples, (s) => s.db_ping_ms)} color={C.orange} lv={level(lastOf(samples, 'db_ping_ms'), 50, 500)} />
        <Kpi label="DB uptime" value={fmtDur(d?.started ? now - d.started : undefined)} sub={d?.database ? `database '${d.database}'` : undefined} />
      </div>

      {isPg && (
        <div className="sys-grid">
          <TimeChart
            title="Transactions"
            sub="per second"
            now={now}
            samples={win}
            fmt={(v) => fmtNum(v)}
            lines={[
              { name: 'Commit', color: C.blue, key: (s) => s.db_commit, area: true },
              { name: 'Rollback', color: C.red, key: (s) => s.db_rollback },
            ]}
          />
          <TimeChart
            title="Rows"
            sub="per second"
            now={now}
            samples={win}
            fmt={(v) => fmtNum(v)}
            lines={[
              { name: 'Read', color: C.blue, key: (s) => s.db_fetch },
              { name: 'Insert', color: C.teal, key: (s) => s.db_ins },
              { name: 'Update', color: C.orange, key: (s) => s.db_upd },
              { name: 'Delete', color: C.purple, key: (s) => s.db_del },
            ]}
          />
          <TimeChart
            title="Connections"
            sub={maxConn ? `max ${maxConn}` : undefined}
            now={now}
            samples={win}
            fmt={(v) => fmtNum(v, 0)}
            lines={[
              { name: 'Total', color: C.purple, key: (s) => s.db_conns, area: true },
              { name: 'Active', color: C.blue, key: (s) => s.db_active },
              { name: 'Idle in transaction', color: C.orange, key: (s) => s.db_idle_tx },
            ]}
          />
          <TimeChart title="Query latency" sub="ms" now={now} samples={win} fmt={(v) => `${v.toFixed(v < 10 ? 1 : 0)} ms`} lines={[{ name: 'Latency', color: C.orange, key: (s) => s.db_ping_ms, area: true }]} />
        </div>
      )}

      {tables.length > 0 && (
        <div className="sys-grid" style={{ gridTemplateColumns: '1fr' }}>
          <BarChart
            title="Largest tables"
            sub="data + index"
            rows={tables.map((t) => ({
              name: t.name,
              parts: [
                { name: 'Data', color: C.blue, value: t.data ?? 0 },
                { name: 'Index', color: C.teal, value: t.index ?? 0 },
                { name: 'Other (TOAST)', color: C.orange, value: Math.max(0, (t.total ?? 0) - (t.data ?? 0) - (t.index ?? 0)) },
              ],
            }))}
          />
        </div>
      )}

      <div className="section-title">
        Tables
        <small>{d ? `${d.tables.length} tables` : ''}</small>
      </div>
      <Table
        rowKey="name"
        size="small"
        pagination={false}
        dataSource={d?.tables ?? []}
        columns={[
          { title: 'Table', dataIndex: 'name', render: (v) => <b>{v}</b> },
          { title: 'Rows', dataIndex: 'rows', align: 'right', className: 'num', render: (v) => v?.toLocaleString() },
          ...(isPg
            ? [
                { title: 'Total size', dataIndex: 'total', align: 'right' as const, className: 'num', render: (v: number) => fmtBytes(v) },
                { title: 'Index', dataIndex: 'index', align: 'right' as const, className: 'num', render: (v: number) => fmtBytes(v) },
                { title: 'Dead rows', dataIndex: 'dead_rows', align: 'right' as const, className: 'num', render: (v: number, r: any) => <span className={v > 1000 && v / Math.max(1, r.rows) > 0.2 ? 'sys-warn' : ''}>{v?.toLocaleString()}</span> },
                { title: 'Seq / index scans', align: 'right' as const, className: 'num', render: (_: any, r: any) => `${(r.seq_scan ?? 0).toLocaleString()} / ${(r.idx_scan ?? 0).toLocaleString()}` },
                { title: 'Last vacuum', dataIndex: 'last_vacuum', align: 'right' as const, className: 'num', render: (v: number | null) => (v ? `${fmtDur(now - v)} ago` : <span className="muted">never</span>) },
              ]
            : []),
        ]}
      />

      {isPg && (
        <>
          <div className="section-title">
            Connections
            <small>{d ? `${d.connections.length} sessions · refreshed every 15s` : ''}</small>
          </div>
          <Table
            rowKey="pid"
            size="small"
            pagination={false}
            dataSource={d?.connections ?? []}
            columns={[
              { title: 'PID', dataIndex: 'pid', className: 'num', width: 80 },
              { title: 'State', dataIndex: 'state', width: 150, render: (v) => <span className={`st ${v === 'active' ? 'st-running' : v.startsWith('idle in') ? 'st-warning' : 'st-idle'}`}>{v || '–'}</span> },
              { title: 'Client', dataIndex: 'client', width: 120, render: (v, r) => `${v}${r.app ? ` · ${r.app}` : ''}` },
              { title: 'For', dataIndex: 'since', width: 100, align: 'right', className: 'num', render: (v) => fmtDur(v ? now - v : undefined) },
              { title: 'Last query', dataIndex: 'query', render: (v) => <span className="mono ellipsis sys-query">{v}</span> },
            ]}
          />
          <div className="section-title">Settings</div>
          <div className="panel sys-info">
            {(d?.settings ?? []).map((s) => (
              <div key={s.name}>
                <span className="muted">{s.name}</span>
                <b>{s.unit === '8kB' ? fmtBytes(Number(s.value) * 8192) : s.unit === 'kB' ? fmtBytes(Number(s.value) * 1024) : s.unit === 'MB' ? fmtBytes(Number(s.value) * 1048576) : s.value}</b>
              </div>
            ))}
            {d?.totals && (
              <>
                <div>
                  <span className="muted">Total commits / rollbacks</span>
                  <b>
                    {d.totals.commits.toLocaleString()} / {d.totals.rollbacks.toLocaleString()}
                  </b>
                </div>
                <div>
                  <span className="muted">Deadlocks</span>
                  <b>{d.totals.deadlocks.toLocaleString()}</b>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </>
  );
}

/** System: 서버 자원과 DB 상태 모니터링 */
export default function SystemPage({ view }: { view: 'resources' | 'db' }) {
  const { m, samples, err } = useMetrics();
  const [winSec, setWinSec] = useState(900);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 5000);
    return () => clearInterval(t);
  }, []);
  const end = Math.max(now, samples.length ? samples[samples.length - 1].t : 0);
  const win = useMemo(() => samples.filter((s) => s.t >= end - winSec), [samples, end, winSec]);
  const chartNow = useMemo(() => ({ end, start: end - winSec }), [end, winSec]);
  return (
    <div className="page">
      <StageHeader
        stage="system"
        extra={
          <>
            <span className="muted" style={{ fontSize: 12 }}>
              <span className="dot sys-live" /> Live · every 5s
            </span>
            <WindowTabs value={winSec} onChange={setWinSec} />
          </>
        }
      />
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
      <WindowCtx.Provider value={chartNow}>
        {view === 'resources' ? <Resources m={m} samples={samples} win={win} now={end} /> : <Database samples={samples} win={win} now={end} />}
      </WindowCtx.Provider>
    </div>
  );
}

