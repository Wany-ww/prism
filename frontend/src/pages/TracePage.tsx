import { Alert, Button, Empty, Input, Select, Space, Typography } from 'antd';
import { RightOutlined, SearchOutlined } from '@ant-design/icons';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Dataset, FramePayload, GraphStatus } from '../api';
import GraphInsights from '../components/GraphInsights';
import { fmtCell } from '../components/DataGrid';
import StageHeader from '../components/StageHeader';

type Group = { name: string; fields: { key: string; value: unknown; dtype: string }[]; ts?: unknown; equipment?: unknown };

function groupRow(data: FramePayload, row: unknown[]): Group[] {
  const groups: Group[] = [];
  const idx: Record<string, Group> = {};
  data.columns.forEach((c, i) => {
    const dot = c.name.indexOf('.');
    const g = dot > 0 ? c.name.slice(0, dot) : 'Other';
    const field = dot > 0 ? c.name.slice(dot + 1) : c.name;
    if (!idx[g]) groups.push((idx[g] = { name: g, fields: [] }));
    if (field === '_ts') idx[g].ts = row[i];
    else if (field === '_equipment') idx[g].equipment = row[i];
    else idx[g].fields.push({ key: field, value: row[i], dtype: c.dtype });
  });
  return groups;
}

export default function TracePage() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [ds, setDs] = useState<string>();
  const [q, setQ] = useState('');
  const [column, setColumn] = useState<string>();
  const [mode, setMode] = useState<'exact' | 'contains'>('exact');
  const [res, setRes] = useState<FramePayload | null>(null);
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState('');

  const [sp] = useSearchParams();
  const [gstat, setGstat] = useState<GraphStatus | null>(null);

  useEffect(() => {
    api.get<GraphStatus>('/api/graph/status').then(setGstat).catch(() => undefined);
  }, []);

  useEffect(() => {
    api.get<Dataset[]>('/api/datasets').then((l) => {
      setDatasets(l);
      const best = l.find((d) => d.name === sp.get('dataset')) ?? l.find((d) => d.name === 'product_trace') ?? l.find((d) => d.columns.some((c) => c.name.includes('.')));
      const name = best?.name ?? l[0]?.name;
      setDs(name);
      // /trace?q=<제품키> 링크로 바로 조회
      const linked = sp.get('q');
      if (linked && name) {
        setQ(linked);
        search(name, linked);
      }
    });
  }, []);

  const cols = useMemo(() => datasets.find((d) => d.name === ds)?.columns.map((c) => c.name) ?? [], [datasets, ds]);
  const keyCols = cols.filter((c) => /vaid|qr|serial|tray no|lot|id$/i.test(c)).slice(0, 6);

  async function search(dsName = ds, query = q) {
    if (!dsName || !query.trim()) return;
    setErr('');
    try {
      const params = new URLSearchParams({ dataset: dsName, q: query, mode, limit: '50', ...(column ? { column } : {}) });
      setRes(await api.get(`/api/trace/search?${params}`));
      setSel(0);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  const groups = res && res.rows[sel] ? groupRow(res, res.rows[sel]) : [];

  // Neo4j 그래프가 이 데이터셋과 같은 이름으로 저장되어 있으면 영향 범위 분석을 함께 표시
  const graphMeta = gstat?.connected ? gstat.graphs?.find((g) => g.graph === ds) : undefined;
  const productId = useMemo(() => {
    if (!graphMeta || !res?.rows[sel]) return null;
    const i = res.columns.findIndex((c) => c.name === graphMeta.product_key);
    const v = i >= 0 ? res.rows[sel][i] : null;
    return v == null || v === '' ? null : String(v);
  }, [graphMeta, res, sel]);

  return (
    <div className="page">
      <StageHeader stage="match" />
      <div className="tile" style={{ padding: 20 }}>
        <Input
          size="large"
          placeholder="Find a product by VAID · QR · Tray No"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPressEnter={() => search()}
          prefix={<SearchOutlined className="muted" />}
          suffix={
            <Button type="primary" onClick={() => search()}>
              Search
            </Button>
          }
          style={{ borderRadius: 14, border: 'none', padding: '8px 8px 8px 16px', fontSize: 16 }}
        />
        <Space wrap style={{ marginTop: 12 }}>
          <Select style={{ width: 200 }} value={ds} onChange={setDs} options={datasets.map((d) => ({ value: d.name, label: d.name }))} placeholder="Match result dataset" />
          <Select allowClear showSearch style={{ width: 220 }} value={column} onChange={setColumn} placeholder="Search column (all)" options={cols.map((c) => ({ value: c, label: c }))} />
          <div className="pill-tabs">
            <div className={`pill-tab ${mode === 'exact' ? 'active' : ''}`} style={{ background: mode === 'exact' ? 'var(--panel)' : undefined }} onClick={() => setMode('exact')}>
              Exact
            </div>
            <div className={`pill-tab ${mode === 'contains' ? 'active' : ''}`} style={{ background: mode === 'contains' ? 'var(--panel)' : undefined }} onClick={() => setMode('contains')}>
              Contains
            </div>
          </div>
          {keyCols.map((c) => (
            <span key={c} className="st st-idle" style={{ cursor: 'pointer', background: column === c ? 'var(--blue-soft)' : 'var(--panel)', color: column === c ? 'var(--blue)' : undefined }} onClick={() => setColumn(c)}>
              {c}
            </span>
          ))}
        </Space>
      </div>
      {err && <Alert type="error" message={err} style={{ marginTop: 12 }} />}
      {res && (
        <div style={{ marginTop: 24 }}>
          {res.row_count === 0 ? (
            <Empty description="No matching products" style={{ marginTop: 48 }} />
          ) : (
            <>
              <div className="section-title" style={{ marginTop: 0 }}>
                Process history
                <small>{res.row_count} matches</small>
              </div>
              {res.row_count > 1 && (
                <div className="pill-tabs" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                  {res.rows.map((_, i) => (
                    <div key={i} className={`pill-tab ${i === sel ? 'active' : ''}`} onClick={() => setSel(i)}>
                      #{i + 1}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, alignItems: 'stretch', overflowX: 'auto', paddingBottom: 8 }}>
                {groups.map((g, gi) => (
                  <Fragment key={g.name}>
                    {gi > 0 && <RightOutlined style={{ alignSelf: 'center', color: 'var(--text-4)' }} />}
                    <div className="trace-step" style={{ minWidth: 280 }}>
                      <h4>
                        <span className="step-no">{gi + 1}</span>
                        {g.name}
                      </h4>
                      <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
                        {g.equipment != null && (
                          <div>
                            Equipment <b style={{ color: 'var(--text-1)' }}>[{String(g.equipment)}]</b>
                          </div>
                        )}
                        {g.ts != null && <div className="num">{String(g.ts)}</div>}
                        {g.equipment == null && g.ts == null && g.fields.every((f) => f.value == null) && <Typography.Text type="warning">No record for this step</Typography.Text>}
                      </div>
                      <div className="kv">
                        {g.fields.map((f) => (
                          <Fragment key={f.key}>
                            <span>{f.key}</span>
                            <span>{fmtCell(f.value, f.dtype)}</span>
                          </Fragment>
                        ))}
                      </div>
                    </div>
                  </Fragment>
                ))}
              </div>
              {graphMeta && productId && (
                <GraphInsights
                  graph={graphMeta.graph}
                  product={productId}
                  onOpen={(pid) => {
                    setQ(pid);
                    search(ds, pid);
                    window.scrollTo({ top: 0 });
                  }}
                />
              )}
              {graphMeta === undefined && gstat?.connected === false && gstat.enabled && (
                <Alert type="warning" showIcon style={{ marginTop: 24 }} message="Can't reach Neo4j, so impact analysis isn't available." description={gstat.error} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
