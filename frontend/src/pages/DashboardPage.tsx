import { App, Button, Input, Select, Space, Tag, Typography } from 'antd';
import { AimOutlined, ArrowLeftOutlined, CloseOutlined, EditOutlined, ExpandOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import GridLayout, { Layout, WidthProvider } from 'react-grid-layout';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, Dataset } from '../api';
import WidgetView, { Widget } from '../dashboard/Widget';
import WidgetEditor from '../dashboard/WidgetEditor';
import type { Params, Selection } from '../dashboard/link';
import { useTrackRecent } from '../recent';

const Grid = WidthProvider(GridLayout);
const REFRESH = [0, 10, 30, 60, 300, 600].map((v) => ({ value: v, label: v ? (v >= 60 ? `Every ${v / 60} min` : `Every ${v}s`) : 'Auto-refresh off' }));

export default function DashboardPage({ fullscreen }: { fullscreen?: boolean }) {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { message } = App.useApp();
  const [dash, setDash] = useState<any>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [editing, setEditing] = useState(sp.get('edit') === '1' && !fullscreen);
  const [editW, setEditW] = useState<Widget | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tick, setTick] = useState(0);
  // 테이블 행 클릭으로 정한 선택 값 — 연동된 위젯들이 이 값 기준으로 바뀜
  const [selection, setSelection] = useState<Selection | null>(null);
  // 드롭다운/슬라이더 컨트롤 위젯이 정한 값 — paramId → 현재 컬럼명. 새 컨트롤 위젯은 첫 항목으로 시작
  const [params, setParams] = useState<Params>({});
  // 지금 이 대시보드에 실제로 있는 컨트롤 위젯들의 paramId — 다른 위젯이 참조하는 파라미터가 없어졌는지 확인할 때 씀
  const controlParamIds = useMemo(() => [...new Set(widgets.filter((w) => w.type === 'control' && w.control?.paramId).map((w) => w.control!.paramId!))], [widgets]);
  useEffect(() => {
    setParams((cur) => {
      let next: Params | null = null;
      for (const w of widgets) {
        const id = w.control?.paramId;
        const first = w.control?.options?.[0]?.value;
        if (w.type === 'control' && id && first && !(cur[id] ?? next?.[id])) next = { ...(next ?? cur), [id]: first };
      }
      return next ?? cur;
    });
  }, [widgets]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !editW && setSelection(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editW]);

  useEffect(() => {
    api.get(`/api/dashboards/${id}`).then((d) => {
      setDash(d);
      setWidgets(d.layout?.widgets ?? []);
    });
    api.get<Dataset[]>('/api/datasets').then(setDatasets);
  }, [id]);

  useTrackRecent(dash && !fullscreen ? { key: `dashboard:${id}`, label: dash.name, path: `/dashboards/${id}`, kind: 'dashboard' } : null);

  useEffect(() => {
    if (!dash?.refresh_sec || editing) return;
    const t = setInterval(() => setTick((x) => x + 1), dash.refresh_sec * 1000);
    return () => clearInterval(t);
  }, [dash?.refresh_sec, editing]);

  const save = async () => {
    const d = await api.put(`/api/dashboards/${id}`, { name: dash.name, description: dash.description, refresh_sec: dash.refresh_sec, layout: { widgets } });
    setDash(d);
    setDirty(false);
    message.success('Saved.');
  };

  const onLayout = (l: Layout[]) => {
    if (!editing) return;
    setWidgets((ws) =>
      ws.map((w) => {
        const p = l.find((x) => x.i === w.i);
        return p ? { ...w, x: p.x, y: p.y, w: p.w, h: p.h } : w;
      }),
    );
    setDirty(true);
  };

  const addWidget = () => {
    const y = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    setEditW({ i: `w${Date.now().toString(36)}`, x: 0, y, w: 6, h: 8, type: 'chart', title: 'New widget', dataset: datasets[0]?.name, chart: { kind: 'line', y: [] } });
  };

  if (!dash) return null;
  return (
    <div style={{ padding: fullscreen ? 16 : '20px 24px 40px', minHeight: fullscreen ? '100vh' : undefined, background: 'var(--bg-sub)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
        <Space>
          {!fullscreen && <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav('/dashboards')} />}
          {editing ? (
            <Input value={dash.name} onChange={(e) => { setDash({ ...dash, name: e.target.value }); setDirty(true); }} style={{ fontSize: 20, fontWeight: 700, width: 360 }} />
          ) : (
            <Typography.Title level={3} style={{ margin: 0, fontWeight: 700 }}>
              {dash.name}
            </Typography.Title>
          )}
          {dirty && <Tag color="orange">Unsaved</Tag>}
        </Space>
        <Space>
          <Select
            value={dash.refresh_sec}
            options={REFRESH}
            style={{ width: 130 }}
            onChange={(v) => {
              setDash({ ...dash, refresh_sec: v });
              setDirty(true);
            }}
            disabled={fullscreen}
          />
          <Button icon={<ReloadOutlined />} onClick={() => setTick((t) => t + 1)} />
          {!fullscreen && (
            <>
              <Button icon={<ExpandOutlined />} onClick={() => window.open(`/view/${id}`, '_blank')}>
                Full screen
              </Button>
              {editing && (
                <Button icon={<PlusOutlined />} onClick={addWidget}>
                  Add widget
                </Button>
              )}
              <Button icon={<EditOutlined />} type={editing ? 'primary' : 'default'} ghost={editing} onClick={() => setEditing(!editing)}>
                {editing ? 'Done' : 'Edit'}
              </Button>
              <Button type="primary" icon={<SaveOutlined />} onClick={save} disabled={!dirty}>
                Save
              </Button>
            </>
          )}
        </Space>
      </div>
      {selection && (
        <div className="dash-selection">
          <AimOutlined />
          <span>
            <b>{selection.column}</b> = {selection.values.join(', ')}
          </span>
          <span className="muted">
            · {widgets.find((x) => x.i === selection.source)?.title ?? ''} · Ctrl+click for more · Esc to clear
          </span>
          <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => setSelection(null)}>
            Clear selection
          </Button>
        </div>
      )}
      {!widgets.length && (
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 60 }}>
          ‘Edit’ → ‘Add widget’ 으로 차트/테이블/수치를 배치하세요. 위젯은 드래그로 이동하고 모서리로 크기를 조절합니다.
        </Typography.Paragraph>
      )}
      <div className={editing ? 'editing' : ''}>
        <Grid
          layout={widgets.map(({ i, x, y, w, h }) => ({ i, x, y, w, h, minW: 2, minH: 2 }))}
          cols={12}
          rowHeight={30}
          margin={[12, 12]}
          containerPadding={[0, 0]}
          isDraggable={editing}
          isResizable={editing}
          draggableHandle=".drag-handle"
          onLayoutChange={onLayout}
        >
          {widgets.map((w) => (
            <div key={w.i}>
              <WidgetView
                w={w}
                tick={tick}
                editing={editing}
                datasets={datasets}
                selection={selection}
                onSelect={setSelection}
                params={params}
                liveParamIds={controlParamIds}
                onParamChange={(id, v) => setParams((p) => ({ ...p, [id]: v }))}
                onEdit={() => setEditW(w)}
                onDelete={() => {
                  setWidgets((ws) => ws.filter((x) => x.i !== w.i));
                  if (selection?.source === w.i) setSelection(null);
                  setDirty(true);
                }}
              />
            </div>
          ))}
        </Grid>
      </div>
      {editW && (
        <WidgetEditor
          value={editW}
          datasets={datasets}
          paramIds={widgets.filter((x) => x.type === 'control' && x.control?.paramId && x.i !== editW.i).map((x) => x.control!.paramId!)}
          onCancel={() => setEditW(null)}
          onOk={(nw) => {
            setWidgets((ws) => (ws.some((x) => x.i === nw.i) ? ws.map((x) => (x.i === nw.i ? nw : x)) : [...ws, nw]));
            setEditW(null);
            setDirty(true);
          }}
        />
      )}
    </div>
  );
}
