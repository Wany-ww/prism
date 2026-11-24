import { App, Button, Input, Select, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, EditOutlined, ExpandOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import GridLayout, { Layout, WidthProvider } from 'react-grid-layout';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, Dataset } from '../api';
import WidgetView, { Widget } from '../dashboard/Widget';
import WidgetEditor from '../dashboard/WidgetEditor';
import { useTrackRecent } from '../recent';

const Grid = WidthProvider(GridLayout);
const REFRESH = [0, 10, 30, 60, 300, 600].map((v) => ({ value: v, label: v ? (v >= 60 ? `${v / 60}분 갱신` : `${v}초 갱신`) : '자동 갱신 끔' }));

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
    message.success('저장되었습니다.');
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
    setEditW({ i: `w${Date.now().toString(36)}`, x: 0, y, w: 6, h: 8, type: 'chart', title: '새 위젯', dataset: datasets[0]?.name, chart: { kind: 'line', y: [] } });
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
          {dirty && <Tag color="orange">저장 안 됨</Tag>}
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
                전체 화면
              </Button>
              {editing && (
                <Button icon={<PlusOutlined />} onClick={addWidget}>
                  위젯 추가
                </Button>
              )}
              <Button icon={<EditOutlined />} type={editing ? 'primary' : 'default'} ghost={editing} onClick={() => setEditing(!editing)}>
                {editing ? '편집 종료' : '편집'}
              </Button>
              <Button type="primary" icon={<SaveOutlined />} onClick={save} disabled={!dirty}>
                저장
              </Button>
            </>
          )}
        </Space>
      </div>
      {!widgets.length && (
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center', marginTop: 60 }}>
          ‘편집’ → ‘위젯 추가’ 로 차트/테이블/수치를 배치하세요. 위젯은 드래그로 이동하고 모서리로 크기를 조절합니다.
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
                onEdit={() => setEditW(w)}
                onDelete={() => {
                  setWidgets((ws) => ws.filter((x) => x.i !== w.i));
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
