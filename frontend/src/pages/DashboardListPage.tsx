import { App, Button, Empty, Input, Modal, Popconfirm, Space, Tooltip } from 'antd';
import { BarChartOutlined, DeleteOutlined, DownloadOutlined, ExpandOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtTime } from '../api';
import StageHeader from '../components/StageHeader';
import { pickJsonFile } from '../importJson';
import { ACCENTS } from '../nav';

export default function DashboardListPage() {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [list, setList] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const load = () => api.get('/api/dashboards').then(setList);
  useEffect(() => {
    load();
  }, []);
  const create = async () => {
    const d = await api.post('/api/dashboards', { name: name || 'New dashboard', layout: { widgets: [] } });
    nav(`/dashboards/${d.id}?edit=1`);
  };
  const doImport = async () => {
    try {
      const json = await pickJsonFile();
      const d = await api.post('/api/dashboards/import', json);
      message.success(`Imported [${d.name}].`);
      load();
    } catch (e: any) {
      if (e?.message) message.error(e.message);
    }
  };
  return (
    <div className="page">
      <StageHeader
        stage="present"
        extra={
          <Space>
            <Button icon={<UploadOutlined />} onClick={doImport}>
              Import
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New dashboard
            </Button>
          </Space>
        }
      />
      {!list.length && <Empty description="No dashboards yet" style={{ marginTop: 60 }} />}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {list.map((d, i) => (
          <div key={d.id} style={{ cursor: 'pointer' }} onClick={() => nav(`/dashboards/${d.id}`)}>
            <div
              style={{
                height: 140,
                borderRadius: 16,
                background: `linear-gradient(135deg, ${ACCENTS[i % ACCENTS.length]}, ${ACCENTS[(i + 2) % ACCENTS.length]})`,
                display: 'grid',
                placeItems: 'center',
                color: '#fff',
                fontSize: 46,
                position: 'relative',
              }}
            >
              <BarChartOutlined />
              <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <Tooltip title="Full screen">
                  <Button size="small" type="text" icon={<ExpandOutlined />} style={{ color: '#fff' }} onClick={() => window.open(`/view/${d.id}`, '_blank')} />
                </Tooltip>
                <Tooltip title="Export">
                  <Button size="small" type="text" icon={<DownloadOutlined />} style={{ color: '#fff' }} href={`/api/dashboards/${d.id}/export`} />
                </Tooltip>
                <Popconfirm title="Delete this dashboard?" onConfirm={() => api.del(`/api/dashboards/${d.id}`).then(load)}>
                  <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#fff' }} />
                </Popconfirm>
              </div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>{d.name}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              {d.widget_count} widgets · {d.refresh_sec ? `Auto-refresh ${d.refresh_sec}s` : 'Manual refresh'} · {fmtTime(d.updated_at)}
            </div>
          </div>
        ))}
      </div>
      <Modal open={creating} title="New dashboard" onOk={create} onCancel={() => setCreating(false)} okText="Create">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} placeholder="Name" />
      </Modal>
    </div>
  );
}
