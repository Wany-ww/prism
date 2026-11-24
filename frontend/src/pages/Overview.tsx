import { Button, Table } from 'antd';
import { ApiOutlined, BranchesOutlined, DashboardOutlined, ExperimentOutlined, RightOutlined } from '@ant-design/icons';
import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, Equipment, fmtTime } from '../api';
import Sparkline from '../components/Sparkline';
import StatusTag, { statusMeta } from '../components/StatusTag';
import { accentOf } from '../nav';

const STAGE_CARDS: { title: string; desc: string; path: string; icon: ReactNode; grad: string }[] = [
  { title: 'Capture · 수집', desc: '설비 로그를 Parser(Python)로 읽어 DB 에 저장', path: '/capture/equipment', icon: <ApiOutlined />, grad: 'linear-gradient(135deg,#3182f6,#5aa2ff)' },
  { title: 'Match · 매칭', desc: '설비 간 키로 같은 제품의 공정 이력을 연결', path: '/match', icon: <BranchesOutlined />, grad: 'linear-gradient(135deg,#18a5a5,#3cc7b8)' },
  { title: 'Analysis · 분석', desc: 'Python 노드로 가공 · 계산 · 상관 분석', path: '/analysis', icon: <ExperimentOutlined />, grad: 'linear-gradient(135deg,#a234c7,#c86ae0)' },
  { title: 'Present · 대시보드', desc: '도표와 테이블을 원하는 대로 배치', path: '/dashboards', icon: <DashboardOutlined />, grad: 'linear-gradient(135deg,#f04452,#ff7b6b)' },
];

export default function Overview() {
  const nav = useNavigate();
  const [ov, setOv] = useState<any>(null);
  const [eqs, setEqs] = useState<Equipment[]>([]);
  const [act, setAct] = useState<{ hours: string[]; series: Record<string, number[]> }>({ hours: [], series: {} });
  const [proc, setProc] = useState<string>('');
  const [view, setView] = useState<'equipment' | 'pipeline'>('equipment');
  const [runFilter, setRunFilter] = useState<'all' | 'error'>('all');
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => {
      api.get('/api/overview').then(setOv).catch(() => undefined);
      api.get<Equipment[]>('/api/equipment').then(setEqs).catch(() => undefined);
      api.get('/api/overview/activity?hours=24').then(setAct).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);

  const processes = useMemo(() => [...new Set(eqs.map((e) => e.process).filter(Boolean))], [eqs]);
  const shown = eqs.filter((e) => !proc || e.process === proc);
  const runs = (ov?.recent_runs ?? []).filter((r: any) => (!proc || shown.some((e) => e.name === r.equipment)) && (runFilter === 'all' || r.status !== 'ok'));
  const totalRecords = shown.reduce((s, e) => s + (e.record_count ?? 0), 0);
  const lastHour = (id: number) => act.series[id]?.slice(-1)[0] ?? 0;

  return (
    <div className="page">
      <div className="stage-header">
        <div className="big-tabs">
          <div className={`big-tab ${!proc ? 'active' : ''}`} onClick={() => setProc('')}>
            전체
          </div>
          {processes.map((p) => {
            const n = eqs.filter((e) => e.process === p && e.enabled).length;
            const bad = eqs.some((e) => e.process === p && e.enabled && e.status === 'error');
            return (
              <div key={p} className={`big-tab minor ${proc === p ? 'active' : ''}`} onClick={() => setProc(p)}>
                {p}
                <span className="hint">
                  <span className="dot" style={{ background: bad ? 'var(--red)' : 'var(--green)' }} />
                  {n}대 수집 중
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="pill-tabs">
          <div className={`pill-tab ${view === 'equipment' ? 'active' : ''}`} onClick={() => setView('equipment')}>
            설비
          </div>
          <div className={`pill-tab ${view === 'pipeline' ? 'active' : ''}`} onClick={() => setView('pipeline')}>
            파이프라인
          </div>
        </div>
        <div style={{ fontSize: 15, color: 'var(--text-2)' }}>
          누적 레코드 <b className="num" style={{ color: 'var(--text-1)' }}>{totalRecords.toLocaleString()}</b>
          <span className="muted" style={{ marginLeft: 12 }}>최근 1시간 </span>
          {(() => {
            const n = shown.reduce((s, e) => s + lastHour(e.id), 0);
            return <b className={`num ${n ? 'up' : 'muted'}`}>{n ? `+${n.toLocaleString()}` : '0'}</b>;
          })()}
        </div>
      </div>

      {view === 'equipment' ? (
        <div style={{ position: 'relative' }}>
          <div ref={scroller} style={{ display: 'grid', gridAutoFlow: 'column', gridAutoColumns: 'minmax(240px, calc((100% - 40px) / 5))', gap: 10, overflowX: 'auto', scrollbarWidth: 'none' }}>
            {shown.map((e) => {
              const st = statusMeta(e.running ? 'running' : e.status, e.enabled);
              return (
                <div key={e.id} className="tile tile-click" onClick={() => nav(`/capture/equipment?eq=${e.id}`)}>
                  <div className="tile-label">
                    {e.name}
                    <span className="dot" style={{ background: st.color }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div>
                      <div className="tile-value">{(e.record_count ?? 0).toLocaleString()}</div>
                      <div className="tile-sub num">
                        <span style={{ color: st.color }}>{st.label}</span> · 1h +{lastHour(e.id)}
                      </div>
                    </div>
                    <Sparkline data={act.series[e.id] ?? []} color={st.cls === 'st-error' ? 'var(--red)' : 'var(--blue)'} />
                  </div>
                </div>
              );
            })}
          </div>
          {shown.length > 5 && (
            <Button
              shape="circle"
              icon={<RightOutlined />}
              onClick={() => scroller.current?.scrollBy({ left: 500, behavior: 'smooth' })}
              style={{ position: 'absolute', right: -14, top: '50%', transform: 'translateY(-50%)', boxShadow: 'var(--shadow)' }}
            />
          )}
        </div>
      ) : (
        <div className="tiles" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
          {[
            ['설비 (운영/전체)', ov ? `${ov.equipment_enabled} / ${ov.equipment}` : '-', '/capture/equipment'],
            ['Parser', ov?.parsers ?? '-', '/capture/parsers'],
            ['Match Flow', ov?.flows?.match ?? 0, '/match'],
            ['Analysis Flow · 노드', ov ? `${ov.flows.analysis ?? 0} · ${ov.node_types}` : '-', '/analysis'],
            ['데이터셋 · 대시보드', ov ? `${ov.datasets} · ${ov.dashboards}` : '-', '/datasets'],
          ].map(([label, value, path]) => (
            <div key={label as string} className="tile tile-click" onClick={() => nav(path as string)}>
              <div className="tile-label">{label}</div>
              <div className="tile-value">{value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="section-title">
        Prism 파이프라인
        <small>Capture → Match → Analysis → Present</small>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        {STAGE_CARDS.map((s, i) => (
          <div key={s.path} style={{ cursor: 'pointer' }} onClick={() => nav(s.path)}>
            <div style={{ height: 132, borderRadius: 16, background: s.grad, display: 'grid', placeItems: 'center', color: '#fff', fontSize: 44, position: 'relative' }}>
              {s.icon}
              <span style={{ position: 'absolute', left: 16, top: 12, fontSize: 13, fontWeight: 700, opacity: 0.85 }}>STEP {i + 1}</span>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>{s.title}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {s.desc}
            </div>
          </div>
        ))}
      </div>

      <div className="section-title">
        실시간 수집 이력
        <small>10초마다 갱신</small>
      </div>
      <div className="pill-tabs" style={{ marginBottom: 8 }}>
        <div className={`pill-tab ${runFilter === 'all' ? 'active' : ''}`} onClick={() => setRunFilter('all')}>
          전체
        </div>
        <div className={`pill-tab ${runFilter === 'error' ? 'active' : ''}`} onClick={() => setRunFilter('error')}>
          오류만
        </div>
      </div>
      <Table
        rowKey="id"
        pagination={false}
        dataSource={runs}
        locale={{ emptyText: '수집 이력이 없어요' }}
        columns={[
          { title: '', width: 50, render: (_, __, i) => <span className="rank">{i + 1}</span> },
          {
            title: '설비',
            dataIndex: 'equipment',
            render: (v) => {
              const e = eqs.find((x) => x.name === v);
              return (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontWeight: 600 }}>
                  <span className="avatar" style={{ background: accentOf(e?.process || v), width: 28, height: 28, fontSize: 12 }}>
                    {(e?.process || v).slice(0, 1)}
                  </span>
                  {v}
                </span>
              );
            },
          },
          { title: '시작', dataIndex: 'started_at', render: fmtTime, className: 'num' },
          { title: '트리거', dataIndex: 'trigger', render: (v) => ({ schedule: '주기', manual: '수동', agent: 'Agent', seed: '초기' } as any)[v] ?? v },
          { title: '상태', dataIndex: 'status', render: (s) => <StatusTag status={s} /> },
          { title: '파일 (발견/처리)', align: 'right', className: 'num', render: (_, r: any) => `${r.files_found} / ${r.files_parsed}` },
          { title: '행', dataIndex: 'rows', align: 'right', className: 'num', render: (v) => (v ? <span className="up">+{v.toLocaleString()}</span> : <span className="muted">0</span>) },
        ]}
      />
    </div>
  );
}
