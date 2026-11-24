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
          { title: 'Dataset', dataIndex: 'name', render: (v) => <b>{v}</b> },
          { title: 'Source flow', dataIndex: 'flow_name', render: (v) => <span className="muted">{v}</span> },
          { title: 'Rows', dataIndex: 'row_count', align: 'right', className: 'num', render: (v) => v.toLocaleString() },
          { title: 'Columns', dataIndex: 'columns', align: 'right', className: 'num', render: (c: any[]) => c.length },
          { title: 'Updated', dataIndex: 'updated_at', align: 'right', className: 'num', render: fmtTime },
          {
            title: '',
            width: 100,
            render: (_, d) => (
              <Space size={2} onClick={(e) => e.stopPropagation()}>
                <Button type="text" icon={<DownloadOutlined />} href={`/api/datasets/${encodeURIComponent(d.name)}/csv`} />
                <Popconfirm title="Delete this dataset?" description="Flow 를 다시 실행하면 재생성돼요." onConfirm={() => api.del(`/api/datasets/${d.id}`).then(() => { setSel(null); load(); })}>
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
            <small>Top 1,000 rows · {sel.row_count.toLocaleString()} total</small>
          </div>
          <div className="tile" style={{ padding: 8 }}>
            <DataGrid data={data} height="calc(100vh - 480px)" pageSize={100} />
          </div>
        </>
      )}
    </div>
  );
}
