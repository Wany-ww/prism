import { Button, Popconfirm, Space, Table } from 'antd';
import { DeleteOutlined, DownloadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Dataset, fmtTime, FramePayload } from '../api';
import DataGrid from '../components/DataGrid';
import StageHeader from '../components/StageHeader';

export default function DatasetsPage() {
  const [list, setList] = useState<Dataset[]>([]);
  const [sel, setSel] = useState<Dataset | null>(null);
  const [data, setData] = useState<FramePayload | null>(null);
  const [sp, setSp] = useSearchParams();
  const load = () => api.get<Dataset[]>('/api/datasets').then(setList);
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    const name = sp.get('name');
    const d = name ? list.find((x) => x.name === name) : undefined;
    if (d) {
      setSel(d);
      setSp({}, { replace: true });
    }
  }, [sp, list]);
  useEffect(() => {
    setData(null);
    if (sel) api.get(`/api/datasets/${encodeURIComponent(sel.name)}/data?limit=1000`).then(setData);
  }, [sel]);

  return (
    <div className="page">
      <StageHeader stage="present" />
      <Table
        rowKey="id"
        dataSource={list}
        pagination={false}
        onRow={(r) => ({ onClick: () => setSel(r), style: { cursor: 'pointer', background: sel?.id === r.id ? 'var(--blue-soft)' : undefined } })}
        columns={[
          { title: '', width: 50, render: (_, __, i) => <span className="rank">{i + 1}</span> },
          { title: '데이터셋', dataIndex: 'name', render: (v) => <b>{v}</b> },
          { title: '생성 Flow', dataIndex: 'flow_name', render: (v) => <span className="muted">{v}</span> },
          { title: '행', dataIndex: 'row_count', align: 'right', className: 'num', render: (v) => v.toLocaleString() },
          { title: '컬럼', dataIndex: 'columns', align: 'right', className: 'num', render: (c: any[]) => c.length },
          { title: '갱신', dataIndex: 'updated_at', align: 'right', className: 'num', render: fmtTime },
          {
            title: '',
            width: 100,
            render: (_, d) => (
              <Space size={2} onClick={(e) => e.stopPropagation()}>
                <Button type="text" icon={<DownloadOutlined />} href={`/api/datasets/${encodeURIComponent(d.name)}/csv`} />
                <Popconfirm title="삭제할까요? (Flow 를 다시 실행하면 재생성)" onConfirm={() => api.del(`/api/datasets/${d.id}`).then(() => { setSel(null); load(); })}>
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {sel && (
        <>
          <div className="section-title">
            {sel.name}
            <small>상위 1,000행 · 전체 {sel.row_count.toLocaleString()}행</small>
          </div>
          <div className="tile" style={{ padding: 8 }}>
            <DataGrid data={data} height="calc(100vh - 480px)" pageSize={100} />
          </div>
        </>
      )}
    </div>
  );
}
