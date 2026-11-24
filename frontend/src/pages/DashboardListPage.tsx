import { Button, Empty, Input, Modal, Popconfirm, Tooltip } from 'antd';
import { BarChartOutlined, DeleteOutlined, ExpandOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtTime } from '../api';
import StageHeader from '../components/StageHeader';
import { ACCENTS } from '../nav';

export default function DashboardListPage() {
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
  return (
    <div className="page">
      <StageHeader
        stage="present"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            New dashboard
          </Button>
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
