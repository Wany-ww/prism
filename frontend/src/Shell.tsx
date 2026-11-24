import { AutoComplete, Button, Empty, Input } from 'antd';
import { ApiOutlined, CloseOutlined, HistoryOutlined, MoonFilled, PlusOutlined, SearchOutlined, SunFilled } from '@ant-design/icons';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, Equipment } from './api';
import PrismMark from './components/PrismMark';
import { statusMeta } from './components/StatusTag';
import { accentOf, isWorkspace, STAGES, stageOf } from './nav';
import { removeRecent, useRecentList } from './recent';
import { useTheme } from './theme';

type Panel = 'equipment' | 'recent' | null;

function useEquipmentStatus() {
  const [list, setList] = useState<Equipment[]>([]);
  useEffect(() => {
    const load = () => api.get<Equipment[]>('/api/equipment').then(setList).catch(() => undefined);
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  return list;
}

function GlobalSearch() {
  const nav = useNavigate();
  const [opts, setOpts] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const load = async () => {
    const [eqs, flows, dashes, ds, parsers] = await Promise.all([
      api.get<any[]>('/api/equipment'),
      api.get<any[]>('/api/flows'),
      api.get<any[]>('/api/dashboards'),
      api.get<any[]>('/api/datasets'),
      api.get<any[]>('/api/parsers'),
    ]);
    const grp = (label: string, items: { value: string; label: string; sub?: string }[]) => ({
      label,
      options: items.map((i) => ({ value: i.value, label: <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span>{i.label}</span><span className="muted" style={{ fontSize: 12 }}>{i.sub}</span></div>, text: i.label })),
    });
    setOpts([
      grp('Equipment', eqs.map((e) => ({ value: `/capture/equipment?eq=${e.id}`, label: e.name, sub: `${e.process} · ${e.ip}` }))),
      grp('Flow', flows.map((f) => ({ value: `/${f.kind}/${f.id}`, label: f.name, sub: f.kind === 'match' ? 'Match' : 'Analysis' }))),
      grp('Dashboards', dashes.map((d) => ({ value: `/dashboards/${d.id}`, label: d.name, sub: `${d.widget_count} widgets` }))),
      grp('Datasets', ds.map((d) => ({ value: `/datasets?name=${encodeURIComponent(d.name)}`, label: d.name, sub: `${d.row_count.toLocaleString()} rows` }))),
      grp('Parser', parsers.map((p) => ({ value: `/capture/parsers?id=${p.id}`, label: p.name }))),
    ]);
  };
  const filtered = useMemo(
    () =>
      opts
        .map((g) => ({ ...g, options: g.options.filter((o: any) => !q || o.text.toLowerCase().includes(q.toLowerCase())) }))
        .filter((g) => g.options.length),
    [opts, q],
  );
  return (
    <AutoComplete
      className="searchpill"
      options={filtered}
      value={q}
      onFocus={load}
      onSearch={setQ}
      onSelect={(v: string) => {
        setQ('');
        nav(v);
      }}
      popupMatchSelectWidth={340}
    >
      <Input placeholder="Search equipment · flows · dashboards" suffix={<SearchOutlined style={{ color: 'var(--text-3)' }} />} />
    </AutoComplete>
  );
}

function RecentAvatar({ kind, label }: { kind: string; label: string }) {
  const map: Record<string, [string, string]> = {
    match: ['#18a5a5', 'M'],
    analysis: ['#a234c7', 'A'],
    dashboard: ['#3182f6', 'D'],
    parser: ['#fe9800', 'P'],
  };
  const [bg, ch] = map[kind] ?? [accentOf(label), label[0]];
  return (
    <span className="avatar" style={{ background: bg }}>
      {ch}
    </span>
  );
}

export default function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  const { mode, toggle } = useTheme();
  const [panel, setPanel] = useState<Panel>(null);
  const eqs = useEquipmentStatus();
  const recent = useRecentList();
  const stage = stageOf(loc.pathname);
  const errors = eqs.filter((e) => e.enabled && (e.status === 'error' || e.status === 'warning')).length;
  const flip = (p: Panel) => setPanel((cur) => (cur === p ? null : p));

  return (
    <div className={`shell ${panel ? 'panel-open' : ''}`}>
      <div className="shell-main">
        <header className="topbar">
          <div className="brand" onClick={() => nav('/')}>
            <PrismMark />
            PRISM
          </div>
          <nav className="topnav">
            {STAGES.map((s) => (
              <a key={s.key} className={stage.key === s.key ? 'active' : ''} onClick={() => nav(s.tabs[0].path)}>
                {s.label}
              </a>
            ))}
            <GlobalSearch />
          </nav>
          <div className="topbar-right">
            <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/capture/equipment?new=1')}>
              Add equipment
            </Button>
          </div>
        </header>
        <div className={`content ${isWorkspace(loc.pathname) ? 'sub' : ''}`}>{children}</div>
        <footer className="ticker">
          <div className="ticker-label" onClick={() => nav('/capture/equipment')}>
            Capture status
          </div>
          <div className="ticker-viewport">
            {eqs.length > 0 && (
              <div className="ticker-track" style={{ animationDuration: `${Math.max(30, eqs.length * 8)}s` }}>
                {[...eqs, ...eqs].map((e, i) => {
                  const st = statusMeta(e.running ? 'running' : e.status, e.enabled);
                  return (
                    <span key={i} className="ticker-item" onClick={() => nav(`/capture/equipment?eq=${e.id}`)}>
                      <b>[{e.name}]</b>
                      <span className="num">{(e.record_count ?? 0).toLocaleString()} rows</span>
                      <span style={{ color: st.color }}>{st.label}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        </footer>
      </div>

      {panel && (
        <aside className="side-panel">
          <div className="side-panel-head">
            {panel === 'equipment' ? 'Equipment capture status' : 'Recently viewed'}
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={() => setPanel(null)} />
          </div>
          <div className="side-panel-body">
            {panel === 'equipment' &&
              eqs.map((e) => {
                const st = statusMeta(e.running ? 'running' : e.status, e.enabled);
                return (
                  <div key={e.id} className="side-item" onClick={() => nav(`/capture/equipment?eq=${e.id}`)}>
                    <span className="avatar" style={{ background: accentOf(e.process || e.name) }}>
                      {(e.process || e.name).slice(0, 1)}
                    </span>
                    <div className="name">
                      {e.name}
                      <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                        {e.process} · {e.ip}
                      </div>
                    </div>
                    <div className="val num">
                      {(e.record_count ?? 0).toLocaleString()} rows
                      <small style={{ color: st.color }}>{st.label}</small>
                    </div>
                  </div>
                );
              })}
            {panel === 'recent' &&
              (recent.length ? (
                recent.map((r) => (
                  <div key={r.key} className="side-item" onClick={() => nav(r.path)}>
                    <RecentAvatar kind={r.kind} label={r.label} />
                    <div className="name">
                      {r.label}
                      <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                        {{ match: 'Match Flow', analysis: 'Analysis Flow', dashboard: 'Dashboard', parser: 'Parser' }[r.kind]}
                      </div>
                    </div>
                    <CloseOutlined
                      className="x"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        removeRecent(r.key);
                      }}
                    />
                  </div>
                ))
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing viewed yet" style={{ marginTop: 60 }} />
              ))}
          </div>
        </aside>
      )}

      <nav className="rail">
        <div className={`rail-btn ${panel === 'equipment' ? 'active' : ''}`} onClick={() => flip('equipment')}>
          <ApiOutlined />
          {errors > 0 && <span className="rail-badge">{errors}</span>}
          Equipment
        </div>
        <div className={`rail-btn ${panel === 'recent' ? 'active' : ''}`} onClick={() => flip('recent')}>
          <HistoryOutlined />
          Recent
        </div>
        <div className="theme-btn" onClick={toggle} title={mode === 'dark' ? 'Light mode' : 'Dark mode'}>
          {mode === 'dark' ? <MoonFilled /> : <SunFilled />}
        </div>
      </nav>
    </div>
  );
}
