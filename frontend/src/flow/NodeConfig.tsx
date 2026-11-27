import { Alert, AutoComplete, Button, Divider, Form, Input, InputNumber, Popconfirm, Radio, Select, Space, Switch, Typography } from 'antd';
import { CaretRightOutlined, DeleteOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { api, GraphStatus } from '../api';
import CodeEditor from '../components/CodeEditor';
import { kindName, OpData, OpNode, useFlowCtx } from './defs';
import ParamField, { colOptions } from './ParamField';

type Props = {
  node: OpNode;
  update: (patch: Partial<OpData>) => void;
  setParams: (patch: Record<string, any>) => void;
  inputCols: (handle?: string) => string[];
  onRun: () => void;
  onDelete: () => void;
};

export default function NodeConfig({ node, update, setParams, inputCols, onRun, onDelete }: Props) {
  const ctx = useFlowCtx();
  const d = node.data;
  const st = ctx.status[node.id];
  return (
    <div>
      <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text type="secondary">{kindName(d, ctx.nodeTypes)}</Typography.Text>
        <Space size={4}>
          <Button size="small" type="primary" icon={<CaretRightOutlined />} onClick={onRun} loading={ctx.running[node.id]}>
            Run to here
          </Button>
          <Popconfirm title="Delete this node?" onConfirm={onDelete}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </Space>
      <Form layout="vertical" size="small">
        <Form.Item label="Display name">
          <Input value={d.label} onChange={(e) => update({ label: e.target.value })} />
        </Form.Item>
        {d.kind !== 'source' && d.kind !== 'dataset' && (
          <Form.Item label="Disable (pass input through)">
            <Switch checked={!!d.disabled} onChange={(v) => update({ disabled: v })} />
          </Form.Item>
        )}
        <Divider style={{ margin: '4px 0 12px' }} />
        {d.kind === 'source' && <SourceForm p={d.params} set={setParams} />}
        {d.kind === 'match' && <MatchForm p={d.params} set={setParams} left={inputCols('left')} right={inputCols('right')} />}
        {d.kind === 'dataset' && (
          <>
            <Form.Item label="Dataset" extra="Match/Analysis Flow 의 Output 노드에서 저장된 결과">
              <AutoComplete
                value={d.params.name}
                onChange={(v) => setParams({ name: v })}
                options={ctx.datasets.map((x) => ({ value: x.name, label: `${x.name}  (${x.row_count.toLocaleString()} rows · ${x.flow_name ?? '-'})` }))}
              />
            </Form.Item>
            <Form.Item label="Columns to use (empty = all)" extra="필요한 컬럼만 고르면 그 컬럼만 디스크에서 읽습니다. 컬럼이 많은 데이터셋은 꼭 지정하세요.">
              <Select
                mode="multiple"
                allowClear
                value={d.params.columns ?? []}
                onChange={(v) => setParams({ columns: v })}
                options={colOptions(ctx.datasets.find((x) => x.name === d.params.name)?.columns.map((c) => c.name) ?? [])}
                maxTagCount="responsive"
              />
            </Form.Item>
          </>
        )}
        {d.kind === 'output' && <OutputForm p={d.params} set={setParams} cols={inputCols()} />}
        {d.kind === 'union' && <Typography.Paragraph type="secondary">연결된 모든 입력을 위아래로 이어붙입니다. 컬럼이 다르면 빈 값으로 채워집니다.</Typography.Paragraph>}
        {d.kind === 'python' && <PythonForm p={d.params} set={setParams} />}
        {d.kind === 'graph' && <GraphForm p={d.params} set={setParams} cols={inputCols()} />}
        {d.kind === 'cypher' && <CypherForm p={d.params} set={setParams} />}
        {d.kind === 'custom' && <CustomForm node={node} set={setParams} cols={inputCols()} />}
      </Form>
      {st?.status === 'error' && (
        <div style={{ marginTop: 8 }}>
          <Alert type="error" showIcon message={st.error} />
          {st.detail && <pre className="err-pre" style={{ marginTop: 6 }}>{st.detail}</pre>}
        </div>
      )}
    </div>
  );
}

function SourceForm({ p, set }: { p: Record<string, any>; set: (x: Record<string, any>) => void }) {
  const { equipment } = useFlowCtx();
  const [fields, setFields] = useState<string[]>([]);
  const ids: number[] = p.equipment_ids ?? [];
  const processes = useMemo(() => [...new Set(equipment.map((e) => e.process).filter(Boolean))], [equipment]);

  useEffect(() => {
    Promise.all(ids.map((id) => api.get<string[]>(`/api/equipment/${id}/fields`).catch(() => [] as string[]))).then((all) =>
      setFields([...new Set(all.flat())]),
    );
  }, [ids.join(',')]);

  return (
    <>
      <Form.Item label="Equipment" extra="같은 공정의 여러 설비를 선택하면 하나의 테이블로 합쳐집니다 (_equipment 컬럼으로 구분).">
        <Select
          mode="multiple"
          value={ids}
          onChange={(v) => set({ equipment_ids: v })}
          optionFilterProp="label"
          options={processes.map((pr) => ({
            label: pr,
            options: equipment.filter((e) => e.process === pr).map((e) => ({ value: e.id, label: e.name })),
          })).concat(
            equipment.some((e) => !e.process)
              ? [{ label: '(no process)', options: equipment.filter((e) => !e.process).map((e) => ({ value: e.id, label: e.name })) }]
              : [],
          )}
        />
      </Form.Item>
      <Space wrap style={{ marginTop: -8, marginBottom: 12 }}>
        {processes.map((pr) => (
          <Button
            key={pr}
            size="small"
            onClick={() => set({ equipment_ids: [...new Set([...ids, ...equipment.filter((e) => e.process === pr).map((e) => e.id)])] })}
          >
            + all {pr}
          </Button>
        ))}
      </Space>
      <Form.Item label="Column prefix (alias)" extra="예) blade → 'blade.Tray No'. 여러 소스를 매칭할 때 컬럼 충돌을 막고 Trace 화면에서 공정별로 묶어 보여줍니다.">
        <Input value={p.alias} onChange={(e) => set({ alias: e.target.value })} />
      </Form.Item>
      <Form.Item label="Period (last N days, empty = all)">
        <InputNumber min={0} style={{ width: '100%' }} value={p.days} onChange={(v) => set({ days: v })} />
      </Form.Item>
      <Form.Item label="Columns to use (empty = all)">
        <Select mode="tags" value={p.columns ?? []} onChange={(v) => set({ columns: v })} options={colOptions(fields)} />
      </Form.Item>
    </>
  );
}

const STRATEGIES = [
  { value: 'exact', label: 'Exact match', desc: '키가 같은 레코드를 모두 연결 (VAID 처럼 고유한 키)' },
  { value: 'nearest_after', label: 'Nearest after', desc: '키가 같은 오른쪽 레코드 중 왼쪽 시각 이후 가장 가까운 1건 (트레이처럼 재사용되는 키)' },
  { value: 'nearest_before', label: 'Nearest before', desc: '왼쪽 시각 이전 가장 가까운 1건' },
  { value: 'nearest', label: 'Nearest time', desc: '앞뒤 상관없이 가장 가까운 1건' },
];

function MatchForm({ p, set, left, right }: { p: Record<string, any>; set: (x: Record<string, any>) => void; left: string[]; right: string[] }) {
  const keys: { left: string; right: string }[] = p.keys?.length ? p.keys : [{ left: '', right: '' }];
  const setKey = (i: number, patch: Partial<{ left: string; right: string }>) => set({ keys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const strategy = p.strategy ?? 'exact';
  const tsCols = (cols: string[]) => cols.filter((c) => c.endsWith('_ts') || /time|date|시간|일시/i.test(c));
  const filter = (i: string, o: any) => String(o?.value).toLowerCase().includes(i.toLowerCase());
  return (
    <>
      <Form.Item label="Match keys (same value = same product)" extra={!left.length && !right.length ? '입력 컬럼 목록은 상위 노드를 실행하면 나타납니다.' : undefined}>
        {keys.map((k, i) => (
          <Space.Compact key={i} style={{ width: '100%', marginBottom: 6 }}>
            <AutoComplete style={{ width: '45%' }} placeholder="Left column" value={k.left} options={colOptions(left)} filterOption={filter} onChange={(v) => setKey(i, { left: v })} />
            <Button disabled style={{ width: '10%', padding: 0 }}>
              ↔
            </Button>
            <AutoComplete style={{ width: '45%' }} placeholder="Right column" value={k.right} options={colOptions(right)} filterOption={filter} onChange={(v) => setKey(i, { right: v })} />
            <Button icon={<MinusCircleOutlined />} disabled={keys.length === 1} onClick={() => set({ keys: keys.filter((_, j) => j !== i) })} />
          </Space.Compact>
        ))}
        <Button size="small" icon={<PlusOutlined />} onClick={() => set({ keys: [...keys, { left: '', right: '' }] })}>
          Add key
        </Button>
      </Form.Item>
      <Form.Item label="Match strategy" extra={STRATEGIES.find((s) => s.value === strategy)?.desc}>
        <Select value={strategy} onChange={(v) => set({ strategy: v })} options={STRATEGIES} />
      </Form.Item>
      {strategy === 'exact' ? (
        <Form.Item label="Duplicate keys on right">
          <Radio.Group
            value={p.duplicates ?? 'all'}
            onChange={(e) => set({ duplicates: e.target.value })}
            options={[
              { value: 'all', label: 'Link all' },
              { value: 'first', label: 'First record' },
              { value: 'last', label: 'Last record' },
            ]}
          />
        </Form.Item>
      ) : (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item label="Left time column" style={{ width: '50%' }}>
              <AutoComplete allowClear placeholder="Auto (_ts)" value={p.left_time} options={colOptions(tsCols(left))} onChange={(v) => set({ left_time: v || undefined })} />
            </Form.Item>
            <Form.Item label="Right time column" style={{ width: '50%' }}>
              <AutoComplete allowClear placeholder="Auto (_ts)" value={p.right_time} options={colOptions(tsCols(right))} onChange={(v) => set({ right_time: v || undefined })} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="Max time gap (hours, 0 = no limit)">
            <InputNumber min={0} style={{ width: '100%' }} value={p.tolerance_hours} onChange={(v) => set({ tolerance_hours: v })} />
          </Form.Item>
        </>
      )}
      <Form.Item label="Rows to keep">
        <Radio.Group
          value={p.how ?? 'inner'}
          onChange={(e) => set({ how: e.target.value })}
          optionType="button"
          options={[
            { value: 'inner', label: 'Matched only' },
            { value: 'left', label: 'All left' },
            { value: 'outer', label: 'All both' },
          ]}
        />
      </Form.Item>
      <Space size="large">
        <Form.Item label="Normalize keys (trim, 1.0→1)">
          <Switch checked={p.normalize ?? true} onChange={(v) => set({ normalize: v })} />
        </Form.Item>
        <Form.Item label="Ignore case">
          <Switch checked={!!p.ignore_case} onChange={(v) => set({ ignore_case: v })} />
        </Form.Item>
      </Space>
    </>
  );
}

const PY_DEFAULT = `def run(inputs, params):
    df = inputs[0]
    return df
`;

function PythonForm({ p, set }: { p: Record<string, any>; set: (x: Record<string, any>) => void }) {
  return (
    <>
      <Form.Item label="Number of inputs">
        <InputNumber min={0} max={8} value={p.inputs ?? 1} onChange={(v) => set({ inputs: v })} />
      </Form.Item>
      <Form.Item label="Code" extra="run(inputs, params) → DataFrame. params 는 아래 변수(JSON). 재사용하려면 Node Library 에 등록하세요.">
        <CodeEditor value={p.code ?? PY_DEFAULT} onChange={(code) => set({ code })} height="320px" />
      </Form.Item>
      <Form.Item label="Variables (JSON → params)">
        <Input.TextArea
          className="mono"
          autoSize={{ minRows: 2 }}
          defaultValue={JSON.stringify(p.vars ?? {}, null, 2)}
          onBlur={(e) => {
            try {
              set({ vars: JSON.parse(e.target.value || '{}') });
            } catch {
              /* ignore */
            }
          }}
        />
      </Form.Item>
    </>
  );
}

function GraphStatusBanner() {
  const [st, setSt] = useState<GraphStatus | null>(null);
  useEffect(() => {
    api.get<GraphStatus>('/api/graph/status').then(setSt).catch(() => undefined);
  }, []);
  if (!st) return null;
  if (!st.enabled) return <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Neo4j is not configured" description="backend/.env 에 PRISM_NEO4J_URI / USER / PASSWORD 를 지정하세요." />;
  if (!st.connected) return <Alert type="error" showIcon style={{ marginBottom: 12 }} message={`Can't connect to Neo4j (${st.address})`} description={st.error} />;
  return <Alert type="success" showIcon style={{ marginBottom: 12 }} message={`Connected to ${st.version} · ${st.graphs?.length ?? 0} graphs`} />;
}

function OutputForm({ p, set, cols }: { p: Record<string, any>; set: (x: Record<string, any>) => void; cols: string[] }) {
  const { datasets } = useFlowCtx();
  const mode = p.mode ?? 'replace';
  return (
    <>
      <Form.Item label="Dataset name to save" extra="Flow 실행(저장) 시 이 이름으로 결과가 저장됩니다.">
        <AutoComplete value={p.name} onChange={(v) => set({ name: v })} options={datasets.map((x) => ({ value: x.name }))} />
      </Form.Item>
      <Form.Item
        label="Save mode"
        extra={
          mode === 'upsert'
            ? '키가 같은 기존 행은 새 결과로 바꾸고, 이번 결과에 없는 행은 그대로 둡니다. 설비 데이터 노드의 기간을 최근 며칠로 두면 매번 새로 들어온 제품만 처리해 누적할 수 있습니다.'
            : '저장할 때마다 데이터셋 전체를 이번 결과로 바꿉니다.'
        }
      >
        <Radio.Group
          optionType="button"
          value={mode}
          onChange={(e) => set({ mode: e.target.value })}
          options={[
            { value: 'replace', label: 'Replace all' },
            { value: 'upsert', label: 'Upsert by key' },
          ]}
        />
      </Form.Item>
      {mode === 'upsert' && (
        <Form.Item label="Key columns" extra="제품을 구분하는 컬럼 (예: drive.VAID). 여러 개면 모두 같아야 같은 행으로 봅니다.">
          <Select mode="multiple" value={p.keys ?? []} onChange={(v) => set({ keys: v })} options={colOptions(cols)} status={(p.keys ?? []).length ? undefined : 'warning'} />
        </Form.Item>
      )}
    </>
  );
}

function GraphForm({ p, set, cols }: { p: Record<string, any>; set: (x: Record<string, any>) => void; cols: string[] }) {
  const addResource = (c: string) => {
    const lines = String(p.resources ?? '').split('\n').filter(Boolean);
    if (!lines.some((l) => l.split('=')[0].trim() === c)) set({ resources: [...lines, c].join('\n') });
  };
  const mode = p.mode ?? 'replace';
  return (
    <>
      <GraphStatusBanner />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Flow 를 <b>Run all · save</b> 하면 결과를 제품 → 공정 단계 → 설비 / 공유 자원 그래프로 Neo4j 에 씁니다. 제품 Trace 화면의 영향 범위 분석과 그래프 보기에 쓰입니다.
      </Typography.Paragraph>
      <Form.Item
        label="Write mode"
        extra={mode === 'upsert' ? '이번 결과에 있는 제품만 지우고 다시 쓰고, 나머지 제품은 그대로 둡니다 (증분 적재).' : '저장할 때마다 그래프 전체를 지우고 다시 만듭니다.'}
      >
        <Radio.Group
          optionType="button"
          value={mode}
          onChange={(e) => set({ mode: e.target.value })}
          options={[
            { value: 'replace', label: 'Rebuild all' },
            { value: 'upsert', label: 'Upsert products' },
          ]}
        />
      </Form.Item>
      <Form.Item label="Graph name" extra="제품 Trace 에서 같은 이름의 데이터셋을 조회하면 이 그래프를 함께 사용합니다.">
        <Input value={p.name} onChange={(e) => set({ name: e.target.value })} placeholder="product_trace" />
      </Form.Item>
      <Form.Item label="Product key column" extra="제품을 구분하는 값 (예: drive.VAID). 값이 없는 행은 'unkeyed' 제품으로 저장됩니다.">
        <AutoComplete value={p.product_key} options={colOptions(cols)} onChange={(v) => set({ product_key: v })} filterOption={(i, o) => String(o?.value).toLowerCase().includes(i.toLowerCase())} />
      </Form.Item>
      <Form.Item
        label="Shared resources (one column=type per line)"
        extra="여러 제품이 함께 쓰는 자원(트레이, 지그, 자재 Lot 등). 공정마다 이름이 달라도 같은 자원종류로 묶으면 공정을 넘어 연결됩니다. 예) blade.Tray No=Tray / drive.QRCODE=Tray"
      >
        <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 8 }} value={p.resources} onChange={(e) => set({ resources: e.target.value })} />
      </Form.Item>
      {cols.length > 0 && (
        <Space wrap style={{ marginTop: -8, marginBottom: 12 }}>
          {cols
            .filter((c) => /tray|qr|jig|lot|carrier|pallet|fixture|자재|지그/i.test(c))
            .slice(0, 8)
            .map((c) => (
              <Button key={c} size="small" onClick={() => addResource(c)}>
                + {c}
              </Button>
            ))}
        </Space>
      )}
      <Form.Item
        label="Extra step fields (optional)"
        extra="판정 필드(Judge, Result, Status …)는 항상 저장됩니다. 그 밖에 그래프에서 볼 필드만 적으세요. 'drive.Torque' 는 그 컬럼만, 'Torque' 는 모든 공정의 같은 필드. 전체 컬럼을 넣지 않는 것은 적재 시간을 줄이기 위해서입니다."
      >
        <Input.TextArea className="mono" autoSize={{ minRows: 1, maxRows: 6 }} value={p.fields} onChange={(e) => set({ fields: e.target.value })} placeholder="drive.Torque" />
      </Form.Item>
    </>
  );
}

function CypherForm({ p, set }: { p: Record<string, any>; set: (x: Record<string, any>) => void }) {
  return (
    <>
      <GraphStatusBanner />
      <Form.Item label="Cypher (read-only)" extra="쓰기 쿼리는 거부됩니다. 입력을 연결하면 그 행들이 $rows 로 전달됩니다. 노드 값은 '컬럼.속성' 으로 펼쳐집니다.">
        <CodeEditor value={p.query ?? ''} onChange={(query) => set({ query })} height="260px" language="plain" />
      </Form.Item>
      <Form.Item label="Parameters (JSON → $name)">
        <Input.TextArea
          className="mono"
          autoSize={{ minRows: 2 }}
          defaultValue={JSON.stringify(p.params ?? {}, null, 2)}
          onBlur={(e) => {
            try {
              set({ params: JSON.parse(e.target.value || '{}') });
            } catch {
              /* keep previous */
            }
          }}
        />
      </Form.Item>
      <Form.Item label="Max rows (0 = no limit)">
        <InputNumber min={0} style={{ width: '100%' }} value={p.limit} onChange={(v) => set({ limit: v })} />
      </Form.Item>
    </>
  );
}

function CustomForm({ node, set, cols }: { node: OpNode; set: (x: Record<string, any>) => void; cols: string[] }) {
  const { nodeTypes } = useFlowCtx();
  const nt = nodeTypes[node.data.nodeType ?? ''];
  if (!nt) return <Alert type="warning" message={`[${node.data.nodeType}] is not in the node library.`} />;
  return (
    <>
      {nt.description && <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{nt.description}</Typography.Paragraph>}
      {nt.params.map((s) => (
        <Form.Item key={s.name} label={s.label ?? s.name} extra={s.type !== 'text' ? s.help : undefined}>
          <ParamField spec={s} value={node.data.params[s.name] ?? s.default} onChange={(v) => set({ [s.name]: v })} columns={cols} />
        </Form.Item>
      ))}
      {!nt.params.length && <Typography.Text type="secondary">No settings.</Typography.Text>}
    </>
  );
}
