import { App, AutoComplete, Button, Card, ColorPicker, Empty, Input, InputNumber, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import StageHeader from '../components/StageHeader';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import { api, NodeType, ParamSpec } from '../api';
import CodeEditor from '../components/CodeEditor';

const TYPES = ['string', 'text', 'number', 'boolean', 'select', 'column', 'columns', 'json'];

export default function NodeTypesPage() {
  const { message } = App.useApp();
  const [list, setList] = useState<NodeType[]>([]);
  const [cur, setCur] = useState<Partial<NodeType> | null>(null);
  const [dirty, setDirty] = useState(false);
  const load = () => api.get<NodeType[]>('/api/node-types').then(setList);
  useEffect(() => {
    load();
  }, []);

  const cats = useMemo(() => [...new Set(list.map((n) => n.category))], [list]);
  const upd = (p: Partial<NodeType>) => {
    setCur((c) => ({ ...c, ...p }));
    setDirty(true);
  };

  const create = async () => {
    const { code } = await api.get('/api/node-types/template');
    setCur({ key: '', name: '', category: 'Transform', description: '', color: '#a234c7', inputs: 1, params: [], code });
    setDirty(true);
  };
  const save = async () => {
    try {
      const body = { ...cur, params: (cur?.params ?? []).filter((p) => p.name) };
      const r = cur?.id ? await api.put(`/api/node-types/${cur.id}`, body) : await api.post('/api/node-types', body);
      setCur(r);
      setDirty(false);
      message.success('Saved. Every flow using this node picks it up right away.');
      load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const params = cur?.params ?? [];
  const setParam = (i: number, p: Partial<ParamSpec>) => upd({ params: params.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  return (
    <div className="page">
      <StageHeader
        stage="analysis"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={create}>
            New node
          </Button>
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: '270px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <div className="panel" style={{ padding: 8, maxHeight: 'calc(100vh - 250px)', overflow: 'auto' }}>
          {cats.map((c) => (
            <div key={c}>
              <div style={{ padding: '12px 14px 4px', fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{c}</div>
              {list
                .filter((n) => n.category === c)
                .map((n) => (
                  <div
                    key={n.id}
                    className={`list-item ${cur?.id === n.id ? 'active' : ''}`}
                    style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
                    onClick={() => {
                      if (dirty && !confirm('You have unsaved changes. Leave anyway?')) return;
                      setCur(n);
                      setDirty(false);
                    }}
                  >
                    <i style={{ width: 10, height: 10, borderRadius: 3, background: n.color, marginTop: 5, flex: 'none' }} />
                    <div>
                      <div className="t">{n.name}</div>
                      <div className="s mono">{n.key}</div>
                    </div>
                  </div>
                ))}
            </div>
          ))}
        </div>
        {!cur ? (
          <Card>
            <Empty description="노드를 선택하거나 새로 만드세요. 노드는 Match/Analysis Flow 팔레트에 자동으로 나타납니다." />
          </Card>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Card size="small">
              <Space wrap style={{ marginBottom: 8 }}>
                <Input addonBefore="key" className="mono" value={cur.key} onChange={(e) => upd({ key: e.target.value })} style={{ width: 210 }} />
                <Input addonBefore="Name" value={cur.name} onChange={(e) => upd({ name: e.target.value })} style={{ width: 220 }} />
                <AutoComplete value={cur.category} options={cats.map((c) => ({ value: c }))} onChange={(v) => upd({ category: v })} style={{ width: 120 }} placeholder="Category" />
                <Space.Compact>
                  <Button disabled>Inputs</Button>
                  <InputNumber min={0} max={8} value={cur.inputs} onChange={(v) => upd({ inputs: v ?? 1 })} style={{ width: 64 }} />
                </Space.Compact>
                <ColorPicker value={cur.color} onChange={(c) => upd({ color: c.toHexString() })} />
                <Button type="primary" icon={<SaveOutlined />} onClick={save} disabled={!dirty}>
                  Save
                </Button>
                {cur.id && (
                  <Popconfirm title="Delete this node?" description="이 노드를 쓰는 Flow 는 실행 시 오류가 납니다." onConfirm={() => api.del(`/api/node-types/${cur.id}`).then(() => { setCur(null); load(); })}>
                    <Button danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                )}
              </Space>
              <Input.TextArea placeholder="Description" value={cur.description} autoSize onChange={(e) => upd({ description: e.target.value })} />
            </Card>
            <Card size="small" title={<span>Parameters <span className="muted" style={{ fontWeight: 400 }}>· GUI 설정 폼이 자동 생성되며 params 로 전달</span></span>} extra={<Button size="small" icon={<PlusOutlined />} onClick={() => upd({ params: [...params, { name: '', label: '', type: 'string' }] })}>Add</Button>}>
              <Table
                size="small"
                rowKey={(_, i) => String(i)}
                pagination={false}
                dataSource={params}
                locale={{ emptyText: 'No parameters' }}
                columns={[
                  { title: 'name', width: 150, render: (_, p, i) => <Input className="mono" value={p.name} onChange={(e) => setParam(i, { name: e.target.value })} /> },
                  { title: 'Label', width: 180, render: (_, p, i) => <Input value={p.label} onChange={(e) => setParam(i, { label: e.target.value })} /> },
                  { title: 'Type', width: 120, render: (_, p, i) => <Select value={p.type} options={TYPES.map((t) => ({ value: t }))} onChange={(v) => setParam(i, { type: v })} style={{ width: '100%' }} /> },
                  {
                    title: 'Default',
                    width: 160,
                    render: (_, p, i) => (
                      <Input
                        className="mono"
                        defaultValue={p.default === undefined ? '' : JSON.stringify(p.default)}
                        placeholder='JSON (e.g. "h", 3, true, [])'
                        onBlur={(e) => {
                          try {
                            setParam(i, { default: e.target.value ? JSON.parse(e.target.value) : undefined });
                          } catch {
                            setParam(i, { default: e.target.value });
                          }
                        }}
                      />
                    ),
                  },
                  {
                    title: 'Options (select) / help',
                    render: (_, p, i) =>
                      p.type === 'select' ? <Select mode="tags" value={p.options ?? []} onChange={(v) => setParam(i, { options: v })} style={{ width: '100%' }} /> : <Input value={p.help} placeholder="Help text" onChange={(e) => setParam(i, { help: e.target.value })} />,
                  },
                  { title: '', width: 40, render: (_, __, i) => <Button type="text" danger icon={<DeleteOutlined />} onClick={() => upd({ params: params.filter((_, j) => j !== i) })} /> },
                ]}
              />
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
                타입 <Tag>column</Tag>/<Tag>columns</Tag> 는 Flow 에서 입력 데이터의 컬럼 목록을 선택지로 보여줍니다.
              </Typography.Paragraph>
            </Card>
            <Card size="small" title={<span>Code · <code>def run(inputs, params)</code></span>}>
              <CodeEditor value={cur.code ?? ''} onChange={(code) => upd({ code })} height="400px" />
            </Card>
          </Space>
        )}
      </div>
    </div>
  );
}
