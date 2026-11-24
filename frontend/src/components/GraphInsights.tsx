import { Alert, Empty, Spin, Table, Tooltip } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useState } from 'react';
import { api, Impact, ImpactItem, Outcome } from '../api';
import { useTheme } from '../theme';

const HOURS = [1, 4, 12, 24];
const CATS = [
  { key: 'product', name: '기준 제품', color: '#3182f6' },
  { key: 'step', name: '공정', color: '#18a5a5' },
  { key: 'equipment', name: '설비', color: '#8b95a1' },
  { key: 'resource', name: '공유 자원', color: '#fe9800' },
  { key: 'related', name: '연관 제품', color: '#a234c7' },
  { key: 'bad', name: '연관 제품 (불량)', color: '#f04452' },
];

function fmtDt(sec: number) {
  const m = Math.round(Math.abs(sec) / 60);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}

function Outcomes({ list }: { list: Outcome[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
      {list.map((o, i) => (
        <Tooltip key={i} title={`${o.stage}.${o.field}`}>
          <span className={`st ${o.bad ? 'st-error' : 'st-idle'}`}>{o.value}</span>
        </Tooltip>
      ))}
    </span>
  );
}

/** Neo4j 제품 계보 그래프 기반: 영향 범위 분석 + 공정 이력 그래프 */
export default function GraphInsights({ graph, product, onOpen }: { graph: string; product: string; onOpen: (pid: string) => void }) {
  const { mode } = useTheme();
  const [hours, setHours] = useState(4);
  const [via, setVia] = useState({ resource: true, equipment: true });
  const [onlyBad, setOnlyBad] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [net, setNet] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const viaQ = Object.entries(via).filter(([, v]) => v).map(([k]) => k).join(',');
    if (!viaQ) return;
    const qs = (extra = '') => `graph_name=${encodeURIComponent(graph)}&product=${encodeURIComponent(product)}&hours=${hours}${extra}`;
    setLoading(true);
    setErr('');
    Promise.all([api.get<Impact>(`/api/graph/impact?${qs(`&via=${viaQ}`)}`), api.get(`/api/graph/product?${qs()}`)])
      .then(([i, g]) => {
        setImpact(i);
        setNet(g);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [graph, product, hours, via.resource, via.equipment]);

  const option = useMemo(() => {
    if (!net) return null;
    const ink = mode === 'dark' ? '#e4e4e5' : '#191f28';
    const idx = Object.fromEntries(CATS.map((c, i) => [c.key, i]));
    return {
      color: CATS.map((c) => c.color),
      legend: { data: CATS.map((c) => c.name), top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: mode === 'dark' ? '#9e9ea4' : '#4e5968', fontSize: 12 } },
      tooltip: { formatter: (p: any) => (p.dataType === 'edge' ? p.data.label : `${p.data.name}${p.data.ts ? `<br/>${p.data.ts}` : ''}${p.data.equipment ? `<br/>${p.data.equipment}` : ''}`) },
      series: [
        {
          type: 'graph',
          layout: 'force',
          top: 40,
          roam: true,
          draggable: true,
          categories: CATS.map((c) => ({ name: c.name })),
          force: { repulsion: 420, edgeLength: [80, 150], gravity: 0.1, layoutAnimation: true },
          label: { show: true, position: 'right', fontSize: 11, color: ink },
          lineStyle: { color: mode === 'dark' ? '#3c3c47' : '#d1d6db', width: 1.4, curveness: 0.08 },
          edgeSymbol: ['none', 'arrow'],
          edgeSymbolSize: 6,
          emphasis: { focus: 'adjacency', lineStyle: { width: 2.5 }, label: { show: true } },
          data: net.nodes.map((n: any) => ({
            ...n,
            category: idx[n.category],
            symbolSize: n.category === 'product' ? 30 : n.category === 'step' ? 22 : n.category === 'resource' ? 20 : 14,
            itemStyle: { borderColor: mode === 'dark' ? '#202027' : '#ffffff', borderWidth: 2 },
            // 기준 제품은 가운데 고정, 정상 연관 제품 이름은 hover 시에만 (겹침 방지)
            ...(n.category === 'product' ? { fixed: true, x: 300, y: 260 } : {}),
            label: { show: n.category !== 'related', fontWeight: n.category === 'product' ? 700 : 400 },
          })),
          links: net.edges,
        },
      ],
    };
  }, [net, mode]);

  const rows = (impact?.items ?? []).filter((r) => !onlyBad || r.bad);

  return (
    <div style={{ marginTop: 32 }}>
      <div className="section-title" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span>
          영향 범위 분석 <small>Neo4j 제품 계보 그래프 · 기준 제품과 ±{hours}시간 안에 자원·설비를 공유한 제품</small>
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div className="pill-tabs">
          {HOURS.map((h) => (
            <div key={h} className={`pill-tab ${hours === h ? 'active' : ''}`} onClick={() => setHours(h)}>
              ±{h}시간
            </div>
          ))}
        </div>
        <div className="pill-tabs">
          <div className={`pill-tab ${via.resource ? 'active' : ''}`} onClick={() => setVia((v) => ({ ...v, resource: !v.resource || !v.equipment }))}>
            공유 자원
          </div>
          <div className={`pill-tab ${via.equipment ? 'active' : ''}`} onClick={() => setVia((v) => ({ ...v, equipment: !v.equipment || !v.resource }))}>
            같은 설비
          </div>
          <div className={`pill-tab ${onlyBad ? 'active' : ''}`} onClick={() => setOnlyBad(!onlyBad)}>
            불량만
          </div>
        </div>
        {loading && <Spin size="small" />}
      </div>
      {err && <Alert type="error" showIcon message={err} style={{ marginBottom: 12 }} />}
      {impact && (
        <>
          <div className="tiles" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 16 }}>
            <div className="tile">
              <div className="tile-label">연관 제품</div>
              <div className="tile-value">{impact.total.toLocaleString()}</div>
              <div className="tile-sub">기준 결과 <Outcomes list={impact.origin.outcomes} /></div>
            </div>
            <div className="tile">
              <div className="tile-label">공유 자원 기준</div>
              <div className="tile-value">{impact.by_resource.toLocaleString()}</div>
              <div className="tile-sub">같은 트레이 등을 함께 쓴 제품</div>
            </div>
            <div className="tile">
              <div className="tile-label">같은 설비 기준</div>
              <div className="tile-value">{impact.by_equipment.toLocaleString()}</div>
              <div className="tile-sub">같은 설비를 ±{hours}시간 안에 거친 제품</div>
            </div>
            <div className="tile">
              <div className="tile-label">그중 불량</div>
              <div className="tile-value" style={{ color: impact.bad ? 'var(--red)' : undefined }}>{impact.bad.toLocaleString()}</div>
              <div className="tile-sub">표시된 {impact.shown.toLocaleString()}개 중 판정 NG/FAIL</div>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
            <Table<ImpactItem>
              rowKey="product"
              size="small"
              dataSource={rows}
              pagination={{ pageSize: 12, size: 'small', showSizeChanger: false }}
              locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="연관 제품이 없어요" /> }}
              columns={[
                {
                  title: '제품',
                  dataIndex: 'label',
                  render: (v, r) =>
                    r.keyed ? (
                      <a onClick={() => onOpen(r.product)} style={{ fontWeight: 600 }}>
                        {v}
                      </a>
                    ) : (
                      <span className="muted">{v}</span>
                    ),
                },
                {
                  title: '연결 사유',
                  render: (_, r) => (
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.reasons.slice(0, 3).map((x, i) => (
                        <span key={i} className={`st ${x.via === 'resource' ? 'st-running' : 'st-idle'}`}>
                          {x.via === 'resource' ? `${x.kind} ${x.value}` : x.value} · {x.stage}
                        </span>
                      ))}
                    </span>
                  ),
                },
                { title: '시간차', dataIndex: 'min_dt', align: 'right', className: 'num', width: 90, render: (v) => fmtDt(v) },
                { title: '결과', render: (_, r) => <Outcomes list={r.outcomes} /> },
              ]}
            />
            <div className="tile" style={{ padding: 8, height: 560 }}>
              {option ? (
                <ReactECharts
                  option={option}
                  notMerge
                  style={{ height: '100%' }}
                  onEvents={{ click: (p: any) => p.dataType === 'node' && p.data.product && p.data.product !== product && onOpen(p.data.product) }}
                />
              ) : (
                <Empty />
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
