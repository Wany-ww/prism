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
import { ArrowLeftOutlined, CaretRightOutlined, DownOutlined, RedoOutlined, SaveOutlined, ThunderboltOutlined, UndoOutlined, UpOutlined } from '@ant-design/icons';
import { DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, Dataset, Equipment, FlowKind, fmtTime, FramePayload, NodeRunStatus, NodeType } from '../api';
import DataGrid from '../components/DataGrid';
import StatusTag from '../components/StatusTag';
import { BUILTINS, FlowContext, inputHandles, nodeColor, OpData, OpKind, OpNode } from '../flow/defs';
import { iconKindOf, KindIcon } from '../flow/icons';
import NodeConfig from '../flow/NodeConfig';
import OpNodeView from '../flow/OpNodeView';
import { useTrackRecent } from '../recent';
import { useTheme } from '../theme';

const nodeTypesMap = { op: OpNodeView };
const PY_DEFAULT = `def run(inputs, params):\n    df = inputs[0]\n    return df\n`;
const CYPHER_DEFAULT = `// e.g. count of NG products (EOL) per Blade equipment
MATCH (p:Product {graph: 'product_trace'})-[:PASSED]->(e:Step {stage: 'eol'})
WHERE e.\`판정\` = 'NG'
MATCH (p)-[:PASSED]->(b:Step {stage: 'blade'})
RETURN b.equipment AS blade_equipment, count(p) AS ng_products
ORDER BY ng_products DESC`;
const SCHEDULES = [
  { value: 0, label: 'Manual' },
  { value: 1, label: 'Every 1 min' },
  { value: 5, label: 'Every 5 min' },
  { value: 10, label: 'Every 10 min' },
  { value: 30, label: 'Every 30 min' },
  { value: 60, label: 'Every hour' },
  { value: 1440, label: 'Every day' },
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
  const [previewH, setPreviewH] = usePreviewHeight();
  const [runningAll, setRunningAll] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  // ---- 실행 취소/다시 실행: 짧은 시간(묶음) 안의 변경은 한 단계로 합치고, 드래그는 시작 시점 스냅샷을 씀 ----
  type Snapshot = { nodes: OpNode[]; edges: Edge[] };
  const [undoStack, setUndoStack] = useState<Snapshot[]>([]);
  const [redoStack, setRedoStack] = useState<Snapshot[]>([]);
  const lastCheckpoint = useRef(0);
  const dragging = useRef(false);
  const CHECKPOINT_GAP = 600;
  const pushUndo = () => {
    const now = Date.now();
    if (now - lastCheckpoint.current > CHECKPOINT_GAP) {
      const snap: Snapshot = { nodes: rf.getNodes() as OpNode[], edges: rf.getEdges() };
      setUndoStack((s) => [...s.slice(-49), snap]);
      setRedoStack([]);
    }
    lastCheckpoint.current = now;
  };
  const undo = () => {
    if (!undoStack.length) return;
    const prev = undoStack[undoStack.length - 1];
    const cur: Snapshot = { nodes: rf.getNodes() as OpNode[], edges: rf.getEdges() };
    setRedoStack((r) => [...r, cur]);
    setUndoStack((s) => s.slice(0, -1));
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setSelectedId(null);
    setDirty(true);
    lastCheckpoint.current = 0;
  };
  const redo = () => {
    if (!redoStack.length) return;
    const next = redoStack[redoStack.length - 1];
    const cur: Snapshot = { nodes: rf.getNodes() as OpNode[], edges: rf.getEdges() };
    setUndoStack((s) => [...s, cur]);
    setRedoStack((r) => r.slice(0, -1));
    setNodes(next.nodes);
    setEdges(next.edges);
    setSelectedId(null);
    setDirty(true);
    lastCheckpoint.current = 0;
  };

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
    setUndoStack([]);
    setRedoStack([]);
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
    message.success('Saved.');
  }, [meta, id, kind, graph]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
        return;
      }
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement | null)?.isContentEditable;
      if (typing) return; // 텍스트 입력 중에는 브라우저 기본 되돌리기를 그대로 둠
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save, undo, redo]);

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
      if (r.status === 'ok') message.success('Run complete · output datasets saved.');
      else message.error('Some nodes failed.');
      loadDatasets();
    } finally {
      setRunningAll(false);
    }
  };

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      pushUndo();
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
    pushUndo();
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
              : k === 'graph'
                ? { name: '', product_key: '', resources: '' }
                : k === 'cypher'
                  ? { query: CYPHER_DEFAULT, params: {}, limit: 0 }
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
    pushUndo();
    setNodes((ns) => ns.map((n) => (n.id === nid ? { ...n, data: { ...n.data, ...patch } } : n)));
    markDirty();
  };
  const setParams = (nid: string, patch: Record<string, any>) => {
    pushUndo();
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
      { title: 'Input', items: b('Input') },
      { title: 'Match / Combine', items: b('Match / Combine') },
    ];
    const tail = [
      { title: 'Code', items: b('Code') },
      { title: 'Output', items: b('Output') },
    ];
    if (kind === 'match') return [...head, ...custom.filter((c) => c.title !== 'Analysis'), ...tail, ...custom.filter((c) => c.title === 'Analysis')];
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
        {dirty && <Tag color="orange">Unsaved</Tag>}
        <div style={{ flex: 1 }} />
        <Tooltip title={meta.last_error ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{meta.last_error}</pre> : undefined}>
          <Space size={4}>
            {meta.last_status && <StatusTag status={meta.last_status} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Last run {fmtTime(meta.last_run_at)}
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
        <Tooltip title="Undo (Ctrl+Z)">
          <Button icon={<UndoOutlined />} onClick={undo} disabled={!undoStack.length} />
        </Tooltip>
        <Tooltip title="Redo (Ctrl+Y)">
          <Button icon={<RedoOutlined />} onClick={redo} disabled={!redoStack.length} />
        </Tooltip>
        <Button icon={<SaveOutlined />} onClick={save} disabled={!dirty}>
          Save
        </Button>
        <Button type="primary" icon={<ThunderboltOutlined />} onClick={runAll} loading={runningAll}>
          Run all · save
        </Button>
      </div>
      <div className="flow-shell">
        <div className="flow-palette">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Drag or click to add
          </Typography.Text>
          {palette.map((g) => (
            <div key={g.title}>
              <h4>{g.title}</h4>
              {g.items.map((it) => (
                <div
                  key={it.nodeType ?? it.kind}
                  className="palette-card"
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/prism', JSON.stringify({ kind: it.kind, nodeType: it.nodeType }))}
                  onClick={() => addNode(it.kind, it.nodeType)}
                  title={it.desc}
                >
                  <div className="pal-icon" style={{ ['--c' as any]: it.color }}>
                    <KindIcon kind={iconKindOf(it.kind)} />
                  </div>
                  <div className="ptxt">
                    <b>{it.name}</b>
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
              const dragStart = !dragging.current && ch.some((c) => c.type === 'position' && c.dragging === true);
              const removed = ch.some((c) => c.type === 'remove');
              if (dragStart || removed) pushUndo();
              if (ch.some((c) => c.type === 'position')) dragging.current = ch.some((c) => c.type === 'position' && c.dragging === true);
              onNodesChange(ch);
              if (removed || ch.some((c) => c.type === 'position' && c.dragging === false)) setDirty(true);
              if (removed) setSelectedId(null);
            }}
            onEdgesChange={(ch) => {
              if (ch.some((c) => c.type === 'remove')) pushUndo();
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
                pushUndo();
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
        <div className={`flow-preview ${collapsed ? 'collapsed' : ''}`} style={collapsed ? undefined : { height: previewH }}>
          <div
            className="flow-preview-resize"
            title="Drag to resize · double-click to reset"
            onPointerDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = collapsed ? PREVIEW_MIN_H : previewH;
              if (collapsed) setCollapsed(false);
              const el = e.currentTarget;
              el.setPointerCapture(e.pointerId);
              document.body.classList.add('resizing-row');
              const move = (ev: PointerEvent) => setPreviewH(startH + (startY - ev.clientY));
              const up = () => {
                el.removeEventListener('pointermove', move);
                el.removeEventListener('pointerup', up);
                el.removeEventListener('pointercancel', up);
                document.body.classList.remove('resizing-row');
              };
              el.addEventListener('pointermove', move);
              el.addEventListener('pointerup', up);
              el.addEventListener('pointercancel', up);
            }}
            onDoubleClick={() => {
              setCollapsed(false);
              setPreviewH(PREVIEW_DEFAULT_H);
            }}
          />
          <div className="flow-preview-head">
            <Button size="small" type="text" icon={collapsed ? <UpOutlined /> : <DownOutlined />} onClick={() => setCollapsed(!collapsed)} />
            <b>Preview</b>
            {selected ? (
              <>
                <span>{selected.data.label}</span>
                {preview && (
                  <Tag>
                    {preview.row_count.toLocaleString()} rows × {preview.columns.length} cols (showing top {Math.min(500, preview.row_count)})
                  </Tag>
                )}
                <Button size="small" icon={<CaretRightOutlined />} onClick={() => runTo(selected.id)} loading={!!running[selected.id]}>
                  Run
                </Button>
              </>
            ) : (
              <Typography.Text type="secondary">Select a node</Typography.Text>
            )}
          </div>
          {!collapsed && (
            <div className="flow-preview-body">
              {preview ? <DataGrid data={preview} height={Math.max(60, previewH - 134)} pageSize={100} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Click ‘Run to here’ to see the result" />}
            </div>
          )}
        </div>
      </div>
      </div>
    </FlowContext.Provider>
  );
}

const PREVIEW_DEFAULT_H = 300;
const PREVIEW_MIN_H = 160;
const PREVIEW_KEY = 'prism.flowPreviewHeight';

/** 미리보기 패널 높이: 화면 높이에 맞춰 제한하고 브라우저에 기억 */
function usePreviewHeight(): [number, (h: number) => void] {
  const clamp = (h: number) => Math.round(Math.min(Math.max(h, PREVIEW_MIN_H), Math.max(PREVIEW_MIN_H, window.innerHeight - 220)));
  const [h, setH] = useState(() => {
    try {
      const v = Number(localStorage.getItem(PREVIEW_KEY));
      return v ? clamp(v) : PREVIEW_DEFAULT_H;
    } catch {
      return PREVIEW_DEFAULT_H;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_KEY, String(h));
    } catch {
      /* 저장 불가 환경은 무시 */
    }
  }, [h]);
  useEffect(() => {
    const onResize = () => setH((cur) => clamp(cur));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return [h, (v: number) => setH(clamp(v))];
}

function FlowInfo({ meta, kind, onChange }: { meta: Meta; kind: FlowKind; onChange: (m: Meta) => void }) {
  return (
    <div>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Flow info
      </Typography.Title>
      <Typography.Text type="secondary">Description</Typography.Text>
      <Input.TextArea value={meta.description} autoSize={{ minRows: 2 }} onChange={(e) => onChange({ ...meta, description: e.target.value })} style={{ marginBottom: 16 }} />
      <Typography.Title level={5}>How to use</Typography.Title>
      {kind === 'match' ? (
        <ol style={{ paddingLeft: 18, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>Equipment data</b> 노드로 공정별 설비를 불러오고 접두어(alias)를 지정합니다.
          </li>
          <li>
            <b>Match</b> 노드의 왼쪽에 앞 공정, 오른쪽에 다음 공정을 연결하고 키 컬럼 쌍을 지정합니다. 재사용되는 키(트레이 등)는 <i>Nearest after</i> 방식을 씁니다.
          </li>
          <li>Match 결과를 다시 다음 Match 의 왼쪽에 연결해 공정을 이어갑니다.</li>
          <li>
            <b>Output</b> 노드로 결과를 데이터셋으로 저장하면 Analysis Flow, 대시보드, 제품 Trace 조회에서 사용할 수 있습니다.
          </li>
        </ol>
      ) : (
        <ol style={{ paddingLeft: 18, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <b>Dataset</b> 노드로 Match 결과를 불러옵니다.
          </li>
          <li>라이브러리 노드(필터, 계산, 집계, 상관 분석 …)를 연결합니다. 노드 코드는 ‘Node Library’ 에서 Python 으로 수정/추가할 수 있습니다.</li>
          <li>
            <b>Output</b> 노드로 결과를 저장해 대시보드에서 사용합니다.
          </li>
        </ol>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        Shortcuts: Ctrl+S save · Ctrl+Z undo · Ctrl+Y (or Ctrl+Shift+Z) redo · Delete removes selection · select a node and ‘Run to here’ to check intermediate results
      </Typography.Paragraph>
    </div>
  );
}
