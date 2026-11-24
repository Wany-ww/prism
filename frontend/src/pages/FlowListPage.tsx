import { App, Button, Input, Modal, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, FlowKind, FlowSummary, fmtTime } from '../api';
import StageHeader from '../components/StageHeader';
import StatusTag from '../components/StatusTag';

export default function FlowListPage({ kind }: { kind: FlowKind }) {
  const { message } = App.useApp();
  const nav = useNavigate();
  const [list, setList] = useState<FlowSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [running, setRunning] = useState<number | null>(null);
  const load = () => api.get<FlowSummary[]>(`/api/flows?kind=${kind}`).then(setList);
  useEffect(() => {
    load();
  }, [kind]);

  const create = async () => {
    const f = await api.post('/api/flows', { name: name || 'New flow', kind });
    nav(`/${kind}/${f.id}`);
  };
  const run = async (f: FlowSummary) => {
    setRunning(f.id);
    try {
      const r = await api.post(`/api/flows/${f.id}/run`);
      if (r.status === 'ok') message.success(`[${f.name}] run complete`);
      else message.error(r.error.split('\n')[0]);
      load();
    } finally {
      setRunning(null);
    }
  };

  const isMatch = kind === 'match';
  return (
    <div className="page">
      <StageHeader
        stage={isMatch ? 'match' : 'analysis'}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            New flow
          </Button>
        }
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: -8, marginBottom: 20 }}>
        {isMatch
          ? '여러 설비의 키 항목을 연결해, 공정을 차례로 거친 제품의 이력을 하나로 모읍니다.'
          : '매칭 결과를 Python 노드로 가공 · 계산하고 결과를 데이터셋으로 저장합니다.'}
      </Typography.Paragraph>
      <Table
        rowKey="id"
        dataSource={list}
        pagination={false}
        onRow={(f) => ({ onClick: () => nav(`/${kind}/${f.id}`), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: 'Name',
            dataIndex: 'name',
            render: (v) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontWeight: 600 }}>
                <span className="avatar" style={{ background: isMatch ? '#18a5a5' : '#a234c7', width: 30, height: 30 }}>
                  {isMatch ? 'M' : 'A'}
                </span>
                {v}
              </span>
            ),
          },
          { title: 'Description', dataIndex: 'description', ellipsis: true, render: (v) => <span className="muted">{v}</span> },
          { title: 'Nodes', dataIndex: 'node_count', width: 70, align: 'right', className: 'num' },
          { title: 'Output datasets', dataIndex: 'outputs', render: (v: string[]) => v.map((o) => <Tag key={o}>{o}</Tag>) },
          { title: 'Schedule', dataIndex: 'schedule_minutes', width: 100, render: (v) => (v ? `Every ${v} min` : 'Manual') },
          {
            title: 'Last run',
            width: 230,
            render: (_, f) => (
              <Tooltip title={f.last_error ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{f.last_error}</pre> : undefined}>
                <Space>
                  {f.last_status && <StatusTag status={f.last_status} />}
                  {fmtTime(f.last_run_at)}
                </Space>
              </Tooltip>
            ),
          },
          {
            title: '',
            width: 130,
            render: (_, f) => (
              <Space size={2} onClick={(e) => e.stopPropagation()}>
                <Tooltip title="Run · save outputs">
                  <Button type="text" icon={<ThunderboltOutlined />} loading={running === f.id} onClick={() => run(f)} />
                </Tooltip>
                <Tooltip title="Duplicate">
                  <Button type="text" icon={<CopyOutlined />} onClick={() => api.post(`/api/flows/${f.id}/duplicate`).then(load)} />
                </Tooltip>
                <Popconfirm title="Delete this flow?" onConfirm={() => api.del(`/api/flows/${f.id}`).then(load)}>
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal open={creating} title="New flow" onOk={create} onCancel={() => setCreating(false)} okText="Create">
        <Input autoFocus placeholder="Flow name" value={name} onChange={(e) => setName(e.target.value)} onPressEnter={create} />
      </Modal>
    </div>
  );
}
