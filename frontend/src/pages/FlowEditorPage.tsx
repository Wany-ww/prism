import {
  addEdge,
  Background,
  Connection,
  Controls,
  Edge,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { App, Button, Empty, Input, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { ArrowLeftOutlined, CaretRightOutlined, DownOutlined, SaveOutlined, ThunderboltOutlined, UpOutlined } from '@ant-design/icons';
import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, Dataset, Equipment, FlowKind, fmtTime, FramePayload, NodeRunStatus, NodeType } from '../api';
import DataGrid from '../components/DataGrid';
import StatusTag from '../components/StatusTag';
import { BUILTINS, FlowContext, inputHandles, nodeColor, OpData, OpKind, OpNode } from '../flow/defs';
import NodeConfig from '../flow/NodeConfig';
import OpNodeView from '../flow/OpNodeView';
import { useTrackRecent } from '../recent';
import { useTheme } from '../theme';

const nodeTypesMap = { op: OpNodeView };
const PY_DEFAULT = `def run(inputs, params):\n    df = inputs[0]\n    return df\n`;
const SCHEDULES = [
  { value: 0, label: '수동 실행' },
  { value: 1, label: '1분마다' },
  { value: 5, label: '5분마다' },
  { value: 10, label: '10분마다' },
  { value: 30, label: '30분마다' },
  { value: 60, label: '1시간마다' },
  { value: 1440, label: '하루마다' },
];

export default function FlowEditorPage({ kind }: { kind: FlowKind }) {
  return (
    <ReactFlowProvider>
      <Editor kind={kind} />
    </ReactFlowProvider>
  );
}

type Meta = { name: string; description: string; schedule_minutes: number; last_run_at?: string | null; last_status?: string; last_error?: string };

function Editor({ kind }: { kind: FlowKind }) {
  const { id } = useParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<OpNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [dirty, setDirty] = useState(false);
  const [nodeTypes, setNodeTypes] = useState<NodeType[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [status, setStatus] = useState<Record<string, NodeRunStatus>>({});
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const [previews, setPreviews] = useState<Record<string, FramePayload>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [runningAll, setRunningAll] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const ntMap = useMemo(() => Object.fromEntries(nodeTypes.map((n) => [n.key, n])), [nodeTypes]);
  const { mode } = useTheme();
  useTrackRecent(meta ? { key: `${kind}:${id}`, label: meta.name, path: `/${kind}/${id}`, kind } : null);
  const loadDatasets = () => api.get<Dataset[]>('/api/datasets').then(setDatasets);

  useEffect(() => {
    api.get<NodeType[]>('/api/node-types').then(setNodeTypes);
    api.get<Equipment[]>('/api/equipment').then(setEquipment);
    loadDatasets();
    api.get(`/api/flows/${id}`).then((f) => {
      setMeta({ name: f.name, description: f.description, schedule_minutes: f.schedule_minutes, last_run_at: f.last_run_at, last_status: f.last_status, last_error: f.last_error });
      setNodes((f.graph?.nodes ?? []).map((n: any) => ({ ...n, type: 'op' })));
      setEdges((f.graph?.edges ?? []).map((e: any) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed } })));
      setTimeout(() => rf.fitView({ padding: 0.2 }), 50);
    });
  }, [id]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const graph = useCallback(
    () => ({
      nodes: rf.getNodes().map((n) => ({ id: n.id, type: 'op', position: n.position, data: n.data })),
      edges: rf.getEdges().map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
    }),
    [rf],
  );

  const markDirty = () => {
    setDirty(true);
    setPreviews({});
  };

  const save = useCallback(async () => {
    if (!meta) return;
    await api.put(`/api/flows/${id}`, { ...meta, kind, graph: graph() });
    setDirty(false);
    message.success('저장되었습니다.');
  }, [meta, id, kind, graph]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  const ancestors = (target: string) => {
    const es = rf.getEdges();
    const seen = new Set([target]);
    const stack = [target];
    while (stack.length) {
      const t = stack.pop()!;
      es.filter((e) => e.target === t).forEach((e) => {
        if (!seen.has(e.source)) {
          seen.add(e.source);
          stack.push(e.source);
        }
      });
    }
    return seen;
  };

  const runTo = useCallback(
    async (target: string) => {
      const anc = ancestors(target);
      setRunning(Object.fromEntries([...anc].map((a) => [a, true])));
      try {
        const r = await api.post('/api/flows/preview', { graph: graph(), target, limit: 500 });
        setStatus((s) => ({ ...s, ...r.nodes }));
        if (r.preview) setPreviews((p) => ({ ...p, [target]: r.preview }));
        if (r.nodes[target]?.status === 'error') message.error(r.nodes[target].error);
        setCollapsed(false);
      } catch (e: any) {
        message.error(e.message);
      } finally {
        setRunning({});
      }
    },
    [graph],
  );

  const runAll = async () => {
    setRunningAll(true);
    try {
      await save();
      const r = await api.post(`/api/flows/${id}/run`);
      setStatus(r.nodes ?? {});
      setMeta((m) => (m ? { ...m, last_status: r.status, last_error: r.error, last_run_at: new Date().toISOString() } : m));
      if (r.status === 'ok') message.success('실행 완료 · 출력 데이터셋이 저장되었습니다.');
      else message.error('일부 노드에서 오류가 발생했습니다.');
      loadDatasets();
    } finally {
      setRunningAll(false);
    }
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      const target = rf.getNode(c.target!) as OpNode | undefined;
      const multi = target && inputHandles(target.data, ntMap).find((h) => h.id === c.targetHandle)?.multi;
      setEdges((es) =>
        addEdge(
          { ...c, id: `e_${c.source}_${c.target}_${c.targetHandle}_${Date.now() % 100000}`, markerEnd: { type: MarkerType.ArrowClosed } },
          multi ? es : es.filter((e) => !(e.target === c.target && e.targetHandle === c.targetHandle)),
        ),
      );
      markDirty();
    },
    [rf, ntMap],
  );

  const addNode = (k: OpKind, ntKey?: string, pos?: { x: number; y: number }) => {
    const nt = ntKey ? ntMap[ntKey] : undefined;
    const params: Record<string, any> =
      k === 'source'
        ? { equipment_ids: [], alias: '' }
        : k === 'match'
          ? { keys: [{ left: '', right: '' }], strategy: 'exact', how: 'inner', normalize: true }
          : k === 'python'
            ? { code: PY_DEFAULT, inputs: 1, vars: {} }
            : k === 'custom' && nt
              ? Object.fromEntries(nt.params.map((p) => [p.name, p.default]))
              : {};
    const label = nt?.name ?? BUILTINS.find((b) => b.kind === k)!.name;
    let position = pos;
    if (!position) {
      const rect = wrapper.current!.getBoundingClientRect();
      position = rf.screenToFlowPosition({ x: rect.left + rect.width / 2 - 90, y: rect.top + rect.height / 3 });
    }
    const nid = `${ntKey ?? k}_${Math.random().toString(36).slice(2, 7)}`;
    setNodes((ns) => [
      ...ns.map((n) => ({ ...n, selected: false })),
      { id: nid, type: 'op', position, selected: true, data: { kind: k, label, params, ...(ntKey ? { nodeType: ntKey } : {}) } },
    ]);
    setSelectedId(nid);
    markDirty();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/prism');
    if (!raw) return;
    const { kind: k, nodeType } = JSON.parse(raw);
    addNode(k, nodeType, rf.screenToFlowPosition({ x: e.clientX - 90, y: e.clientY - 20 }));
  };

  const updateData = (nid: string, patch: Partial<OpData>) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  };
  const setParams = (nid: string, patch: Record<string, any>) => {
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, params: { ...n.data.params, ...patch } } } : n)));
    markDirty();
  };

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  const inputCols = (handle?: string) => {
    if (!selected) return [];
    const srcs = edges.filter((e) => e.target === selected.id && (!handle || e.targetHandle === handle)).map((e) => e.source);
    return [...new Set(srcs.flatMap((s) => (status[s]?.columns ?? []).map((c) => c.name)))];
  };

  // 선택한 노드의 입력 컬럼을 모르면 자동으로 상위까지 실행해 컬럼 목록 확보
  useEffect(() => {
    if (!selectedId) return;
    const srcs = edges.filter((e) => e.target === selectedId).map((e) => e.source);
    if (srcs.length && srcs.some((s) => !status[s]) && !Object.keys(running).length) runTo(selectedId);
  }, [selectedId]);

  const palette = useMemo(() => {
    const cats = [...new Set(nodeTypes.map((n) => n.category))];
    const custom = cats.map((c) => ({ title: c, items: nodeTypes.filter((n) => n.category === c).map((n) => ({ kind: 'custom' as OpKind, nodeType: n.key, name: n.name, desc: n.description, color: n.color })) }));
    const b = (g: string) => BUILTINS.filter((x) => x.group === g).map((x) => ({ kind: x.kind, nodeType: undefined as string | undefined, name: x.name, desc: x.desc, color: x.color }));
    const head = [
      { title: '입력', items: b('입력') },
      { title: '매칭/결합', items: b('매칭/결합') },
    ];
    const tail = [
      { title: '코드', items: b('코드') },
      { title: '출력', items: b('출력') },
    ];
    if (kind === 'match') return [...head, ...custom.filter((c) => c.title !== '분석'), ...tail, ...custom.filter((c) => c.title === '분석')];
    return [head[0], ...custom, head[1], ...tail];
  }, [nodeTypes, kind]);

  if (!meta) return null;
  const preview = selectedId ? previews[selectedId] : undefined;

  return (
    <FlowContext.Provider value={{ nodeTypes: ntMap, equipment, datasets, status, running }}>
      <div className="editor-root">
      <div className="editor-bar">
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav(`/${kind}`)} />
        <span className="avatar" style={{ background: kind === 'match' ? '#18a5a5' : '#a234c7', width: 28, height: 28, fontSize: 12 }}>
          {kind === 'match' ? 'M' : 'A'}
        </span>
        <Input
          value={meta.name}
          variant="borderless"
          style={{ fontSize: 16, fontWeight: 600, width: 340 }}
          onChange={(e) => {
            setMeta({ ...meta, name: e.target.value });
            setDirty(true);
          }}
        />
        {dirty && <Tag color="orange">저장 안 됨</Tag>}
        <div style={{ flex: 1 }} />
        <Tooltip title={meta.last_error ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{meta.last_error}</pre> : undefined}>
          <Space size={4}>
            {meta.last_status && <StatusTag status={meta.last_status} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              최근 실행 {fmtTime(meta.last_run_at)}
            </Typography.Text>
          </Space>
        </Tooltip>
        <Select
          value={meta.schedule_minutes}
          options={SCHEDULES}
          style={{ width: 120 }}
          onChange={(v) => {
            setMeta({ ...meta, schedule_minutes: v });
            setDirty(true);
          }}
        />
        <Button icon={<SaveOutlined />} onClick={save} disabled={!dirty}>
          저장
        </Button>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={runAll} loading={runningAll}>
          전체 실행 · 저장
        </Button>
      </div>
      <div className="flow-shell">
        <div className="flow-palette">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            드래그하거나 클릭해서 추가
          </Typography.Text>
          {palette.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((it) => (
                <div
                  key={it.nodeType ?? it.kind}
                  className="palette-item"
                  style={{ ['--c' as any]: it.color }}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/prism', JSON.stringify({ kind: it.kind, nodeType: it.nodeType }))}
                  onClick={() => addNode(it.kind, it.nodeType)}
                  title={it.desc}
                >
                  <i />
                  <div>
                    {it.name}
                    <small>{it.desc}</small>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="flow-canvas" ref={wrapper} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypesMap}
            onNodesChange={(ch) => {
              onNodesChange(ch);
              if (ch.some((c) => c.type === 'remove' || (c.type === 'position' && c.dragging === false))) setDirty(true);
              if (ch.some((c) => c.type === 'remove')) setSelectedId(null);
            }}
            onEdgesChange={(ch) => {
              onEdgesChange(ch);
              if (ch.some((c) => c.type === 'remove')) markDirty();
            }}
            onConnect={onConnect}
            onSelectionChange={({ nodes: sel }) => setSelectedId(sel.length === 1 ? sel[0].id : null)}
            deleteKeyCode={['Delete']}
            fitView
            minZoom={0.2}
            colorMode={mode}
            defaultEdgeOptions={{ style: { strokeWidth: 2 } }}
          >
            <Background gap={18} size={1.5} color="var(--canvas-dot)" />
            <Controls />
            <MiniMap pannable zoomable nodeColor={(n) => nodeColor(n.data as OpData, ntMap)} nodeBorderRadius={6} />
          </ReactFlow>
        </div>
        <div className="flow-config">
          {selected ? (
            <NodeConfig
              key={selected.id}
              node={selected}
              update={(p) => updateData(selected.id, p)}
              setParams={(p) => setParams(selected.id, p)}
              inputCols={inputCols}
              onRun={() => runTo(selected.id)}
              onDelete={() => {
                setNodes((ns) => ns.filter((n) => n.id !== selected.id));
                setEdges((es) => es.filter((e) => e.source !== selected.id && e.target !== selected.id));
                setSelectedId(null);
                markDirty();
              }}
            />
          ) : (
            <FlowInfo meta={meta} kind={kind} onChange={(m) => { setMeta(m); setDirty(true); }} />
          )}
        </div>
        <div className={`flow-preview ${collapsed ? 'collapsed' : ''}`}>
          <div className="flow-preview-head">
            <Button size="small" type="text" icon={collapsed ? <UpOutlined /> : <DownOutlined />} onClick={() => setCollapsed(!collapsed)} />
            <b>미리보기</b>
            {selected ? (
              <>
                <span>{selected.data.label}</span>
                {preview && (
                  <Tag>
                    {preview.row_count.toLocaleString()}행 × {preview.columns.length}열 (상위 {Math.min(500, preview.row_count)}행 표시)
                  </Tag>
                )}
                <Button size="small" icon={<CaretRightOutlined />} onClick={() => runTo(selected.id)} loading={!!running[selected.id]}>
                  실행
                </Button>
              </>
            ) : (
              <Typography.Text type="secondary">노드를 선택하세요</Typography.Text>
            )}
          </div>
          {!collapsed && (
            <div className="flow-preview-body">
              {preview ? <DataGrid data={preview} height={210} pageSize={100} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="‘여기까지 실행’ 을 누르면 결과가 표시됩니다" />}
            </div>
          )}
        </div>
      </div>
      </div>
    </FlowContext.Provider>
  );
}

function FlowInfo({ meta, kind, onChange }: { meta: Meta; kind: FlowKind; onChange: (m: Meta) => void }) {
  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Flow 정보
      </Typography.Title>
      <Typography.Text type="secondary">설명</Typography.Text>
      <Input.TextArea value={meta.description} autoSize={{ minRows: 2 }} onChange={(e) => onChange({ ...meta, description: e.target.value })} style={{ marginBottom: 16 }} />
      <Typography.Title level={5}>사용 방법</Typography.Title>
      {kind === 'match' ? (
        <ol style={{ paddingLeft: 18, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>설비 데이터</b> 노드로 공정별 설비를 불러오고 접두어(alias)를 지정합니다.
          </li>
          <li>
            <b>Match</b> 노드의 왼쪽에 앞 공정, 오른쪽에 다음 공정을 연결하고 키 컬럼 쌍을 지정합니다. 재사용되는 키(트레이 등)는 <i>이후 최근접 시각</i> 방식을 씁니다.
          </li>
          <li>Match 결과를 다시 다음 Match 의 왼쪽에 연결해 공정을 이어갑니다.</li>
          <li>
            <b>출력</b> 노드로 결과를 데이터셋으로 저장하면 Analysis Flow, 대시보드, 제품 Trace 조회에서 사용할 수 있습니다.
          </li>
        </ol>
      ) : (
        <ol style={{ paddingLeft: 18, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>데이터셋</b> 노드로 Match 결과를 불러옵니다.
          </li>
          <li>라이브러리 노드(필터, 계산, 집계, 상관 분석 …)를 연결합니다. 노드 코드는 ‘노드 라이브러리’에서 Python 으로 수정/추가할 수 있습니다.</li>
          <li>
            <b>출력</b> 노드로 결과를 저장해 대시보드에서 사용합니다.
          </li>
        </ol>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        단축키: Ctrl+S 저장 · Delete 선택 삭제 · 노드 선택 후 ‘여기까지 실행’ 으로 중간 결과 확인
      </Typography.Paragraph>
    </div>
  );
}
