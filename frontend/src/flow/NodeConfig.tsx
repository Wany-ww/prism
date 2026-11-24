import { Alert, AutoComplete, Button, Divider, Form, Input, InputNumber, Popconfirm, Radio, Select, Space, Switch, Typography } from 'antd';
import { CaretRightOutlined, DeleteOutlined, MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
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
            여기까지 실행
          </Button>
          <Popconfirm title="노드를 삭제할까요?" onConfirm={onDelete}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      </Space>
      <Form layout="vertical" size="small">
        <Form.Item label="표시 이름">
          <Input value={d.label} onChange={(e) => update({ label: e.target.value })} />
        </Form.Item>
        {d.kind !== 'source' && d.kind !== 'dataset' && (
          <Form.Item label="비활성화 (입력을 그대로 통과)">
            <Switch checked={!!d.disabled} onChange={(v) => update({ disabled: v })} />
          </Form.Item>
        )}
        <Divider style={{ margin: '4px 0 12px' }} />
        {d.kind === 'source' && <SourceForm p={d.params} set={setParams} />}
        {d.kind === 'match' && <MatchForm p={d.params} set={setParams} left={inputCols('left')} right={inputCols('right')} />}
        {d.kind === 'dataset' && (
          <Form.Item label="데이터셋" extra="Match/Analysis Flow 의 출력 노드에서 저장된 결과">
            <AutoComplete
              value={d.params.name}
              onChange={(v) => setParams({ name: v })}
              options={ctx.datasets.map((x) => ({ value: x.name, label: `${x.name}  (${x.row_count.toLocaleString()}행 · ${x.flow_name ?? '-'})` }))}
            />
          </Form.Item>
        )}
        {d.kind === 'output' && (
          <Form.Item label="저장할 데이터셋 이름" extra="Flow 실행(저장) 시 이 이름으로 결과가 저장됩니다. 같은 이름은 덮어씁니다.">
            <AutoComplete value={d.params.name} onChange={(v) => setParams({ name: v })} options={ctx.datasets.map((x) => ({ value: x.name }))} />
          </Form.Item>
        )}
        {d.kind === 'union' && <Typography.Paragraph type="secondary">연결된 모든 입력을 위아래로 이어붙입니다. 컬럼이 다르면 빈 값으로 채워집니다.</Typography.Paragraph>}
        {d.kind === 'python' && <PythonForm p={d.params} set={setParams} />}
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
      <Form.Item label="설비" extra="같은 공정의 여러 설비를 선택하면 하나의 테이블로 합쳐집니다 (_equipment 컬럼으로 구분).">
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
              ? [{ label: '(공정 미지정)', options: equipment.filter((e) => !e.process).map((e) => ({ value: e.id, label: e.name })) }]
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
            + {pr} 전체
          </Button>
        ))}
      </Space>
      <Form.Item label="컬럼 접두어 (alias)" extra="예) blade → 'blade.Tray No'. 여러 소스를 매칭할 때 컬럼 충돌을 막고 Trace 화면에서 공정별로 묶어 보여줍니다.">
        <Input value={p.alias} onChange={(e) => set({ alias: e.target.value })} />
      </Form.Item>
      <Form.Item label="기간 (최근 N일, 비우면 전체)">
        <InputNumber min={0} style={{ width: '100%' }} value={p.days} onChange={(v) => set({ days: v })} />
      </Form.Item>
      <Form.Item label="사용할 컬럼 (비우면 전체)">
        <Select mode="tags" value={p.columns ?? []} onChange={(v) => set({ columns: v })} options={colOptions(fields)} />
      </Form.Item>
    </>
  );
}

const STRATEGIES = [
  { value: 'exact', label: '정확히 일치', desc: '키가 같은 레코드를 모두 연결 (VAID 처럼 고유한 키)' },
  { value: 'nearest_after', label: '이후 최근접 시각', desc: '키가 같은 오른쪽 레코드 중 왼쪽 시각 이후 가장 가까운 1건 (트레이처럼 재사용되는 키)' },
  { value: 'nearest_before', label: '이전 최근접 시각', desc: '왼쪽 시각 이전 가장 가까운 1건' },
  { value: 'nearest', label: '최근접 시각', desc: '앞뒤 상관없이 가장 가까운 1건' },
];

function MatchForm({ p, set, left, right }: { p: Record<string, any>; set: (x: Record<string, any>) => void; left: string[]; right: string[] }) {
  const keys: { left: string; right: string }[] = p.keys?.length ? p.keys : [{ left: '', right: '' }];
  const setKey = (i: number, patch: Partial<{ left: string; right: string }>) => set({ keys: keys.map((k, j) => (j === i ? { ...k, ...patch } : k)) });
  const strategy = p.strategy ?? 'exact';
  const tsCols = (cols: string[]) => cols.filter((c) => c.endsWith('_ts') || /time|date|시간|일시/i.test(c));
  const filter = (i: string, o: any) => String(o?.value).toLowerCase().includes(i.toLowerCase());
  return (
    <>
      <Form.Item label="매칭 키 (같은 값이면 같은 제품)" extra={!left.length && !right.length ? '입력 컬럼 목록은 상위 노드를 실행하면 나타납니다.' : undefined}>
        {keys.map((k, i) => (
          <Space.Compact key={i} style={{ width: '100%', marginBottom: 6 }}>
            <AutoComplete style={{ width: '45%' }} placeholder="왼쪽 컬럼" value={k.left} options={colOptions(left)} filterOption={filter} onChange={(v) => setKey(i, { left: v })} />
            <Button disabled style={{ width: '10%', padding: 0 }}>
              ↔
            </Button>
            <AutoComplete style={{ width: '45%' }} placeholder="오른쪽 컬럼" value={k.right} options={colOptions(right)} filterOption={filter} onChange={(v) => setKey(i, { right: v })} />
            <Button icon={<MinusCircleOutlined />} disabled={keys.length === 1} onClick={() => set({ keys: keys.filter((_, j) => j !== i) })} />
          </Space.Compact>
        ))}
        <Button size="small" icon={<PlusOutlined />} onClick={() => set({ keys: [...keys, { left: '', right: '' }] })}>
          키 추가
        </Button>
      </Form.Item>
      <Form.Item label="매칭 방식" extra={STRATEGIES.find((s) => s.value === strategy)?.desc}>
        <Select value={strategy} onChange={(v) => set({ strategy: v })} options={STRATEGIES} />
      </Form.Item>
      {strategy === 'exact' ? (
        <Form.Item label="오른쪽 중복 키 처리">
          <Radio.Group
            value={p.duplicates ?? 'all'}
            onChange={(e) => set({ duplicates: e.target.value })}
            options={[
              { value: 'all', label: '모두 연결' },
              { value: 'first', label: '첫 레코드' },
              { value: 'last', label: '마지막 레코드' },
            ]}
          />
        </Form.Item>
      ) : (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item label="왼쪽 시간 컬럼" style={{ width: '50%' }}>
              <AutoComplete allowClear placeholder="자동 (_ts)" value={p.left_time} options={colOptions(tsCols(left))} onChange={(v) => set({ left_time: v || undefined })} />
            </Form.Item>
            <Form.Item label="오른쪽 시간 컬럼" style={{ width: '50%' }}>
              <AutoComplete allowClear placeholder="자동 (_ts)" value={p.right_time} options={colOptions(tsCols(right))} onChange={(v) => set({ right_time: v || undefined })} />
            </Form.Item>
          </Space.Compact>
          <Form.Item label="최대 시간 차 (시간, 0=제한 없음)">
            <InputNumber min={0} style={{ width: '100%' }} value={p.tolerance_hours} onChange={(v) => set({ tolerance_hours: v })} />
          </Form.Item>
        </>
      )}
      <Form.Item label="결과에 남길 행">
        <Radio.Group
          value={p.how ?? 'inner'}
          onChange={(e) => set({ how: e.target.value })}
          optionType="button"
          options={[
            { value: 'inner', label: '매칭된 것만' },
            { value: 'left', label: '왼쪽 전체' },
            { value: 'outer', label: '양쪽 전체' },
          ]}
        />
      </Form.Item>
      <Space size="large">
        <Form.Item label="키 정규화 (공백·1.0→1)">
          <Switch checked={p.normalize ?? true} onChange={(v) => set({ normalize: v })} />
        </Form.Item>
        <Form.Item label="대소문자 무시">
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
      <Form.Item label="입력 개수">
        <InputNumber min={0} max={8} value={p.inputs ?? 1} onChange={(v) => set({ inputs: v })} />
      </Form.Item>
      <Form.Item label="코드" extra="run(inputs, params) → DataFrame. params 는 아래 변수(JSON). 재사용하려면 노드 라이브러리에 등록하세요.">
        <CodeEditor value={p.code ?? PY_DEFAULT} onChange={(code) => set({ code })} height="320px" />
      </Form.Item>
      <Form.Item label="변수 (JSON → params)">
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

function CustomForm({ node, set, cols }: { node: OpNode; set: (x: Record<string, any>) => void; cols: string[] }) {
  const { nodeTypes } = useFlowCtx();
  const nt = nodeTypes[node.data.nodeType ?? ''];
  if (!nt) return <Alert type="warning" message={`노드 라이브러리에 '${node.data.nodeType}' 가 없습니다.`} />;
  return (
    <>
      {nt.description && <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>{nt.description}</Typography.Paragraph>}
      {nt.params.map((s) => (
        <Form.Item key={s.name} label={s.label ?? s.name} extra={s.type !== 'text' ? s.help : undefined}>
          <ParamField spec={s} value={node.data.params[s.name] ?? s.default} onChange={(v) => set({ [s.name]: v })} columns={cols} />
        </Form.Item>
      ))}
      {!nt.params.length && <Typography.Text type="secondary">설정 항목이 없습니다.</Typography.Text>}
    </>
  );
}
