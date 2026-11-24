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
    const d = await api.post('/api/dashboards', { name: name || '새 대시보드', layout: { widgets: [] } });
    nav(`/dashboards/${d.id}?edit=1`);
  };
  return (
    <div className="page">
      <StageHeader
        stage="present"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            새 대시보드
          </Button>
        }
      />
      {!list.length && <Empty description="대시보드가 없어요" style={{ marginTop: 60 }} />}
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
                <Tooltip title="전체 화면">
                  <Button size="small" type="text" icon={<ExpandOutlined />} style={{ color: '#fff' }} onClick={() => window.open(`/view/${d.id}`, '_blank')} />
                </Tooltip>
                <Popconfirm title="삭제할까요?" onConfirm={() => api.del(`/api/dashboards/${d.id}`).then(load)}>
                  <Button size="small" type="text" icon={<DeleteOutlined />} style={{ color: '#fff' }} />
                </Popconfirm>
              </div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>{d.name}</div>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              위젯 {d.widget_count} · {d.refresh_sec ? `${d.refresh_sec}초 자동 갱신` : '수동 갱신'} · {fmtTime(d.updated_at)}
            </div>
          </div>
        ))}
      </div>
      <Modal open={creating} title="새 대시보드" onOk={create} onCancel={() => setCreating(false)} okText="만들기">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} placeholder="이름" />
      </Modal>
    </div>
  );
}
