import {
  Alert,
  App,
  AutoComplete,
  Button,
  Col,
  Descriptions,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Equipment, fmtTime, FramePayload, Parser } from '../api';
import DataGrid from '../components/DataGrid';
import ParserEditor from '../components/ParserEditor';
import StageHeader from '../components/StageHeader';
import StatusTag from '../components/StatusTag';
import { accentOf } from '../nav';

const METHODS = [
  { value: 'fs', label: 'File path (local / UNC share)' },
  { value: 'ftp', label: 'FTP' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'agent', label: 'Agent (push from a gateway on another LAN)' },
];
/** 설비 정보 표시 순서 (편집 폼 · 목록 · 상세 공통) */
const INFO_FIELDS = [
  ['factory', 'Factory'],
  ['product', 'Product'],
  ['customer', 'Customer'],
  ['project', 'Project'],
  ['process', 'Process'],
] as const;

const ENCODINGS =['utf-8', 'utf-8-sig', 'cp949', 'euc-kr', 'latin-1'];

const EMPTY: Partial<Equipment> = {
  access_method: 'fs',
  folder_mode: 'flat',
  file_pattern: '*.csv',
  lookback_days: 1,
  encoding: 'utf-8',
  capture_interval_sec: 300,
  enabled: true,
  options: {},
};

/** 삭제 전에 함께 지워질 데이터와 영향받는 Flow 를 보여주고 확인받는다. */
function useDeleteEquipment(onDone: (deleted: number[]) => void) {
  const { modal, message } = App.useApp();
  return async (targets: Equipment[]) => {
    if (!targets.length) return;
    const usages = await Promise.all(targets.map((t) => api.get<{ files: number; records: number; flows: { id: number; name: string }[] }>(`/api/equipment/${t.id}/usage`)));
    const files = usages.reduce((s, u) => s + u.files, 0);
    const records = usages.reduce((s, u) => s + u.records, 0);
    const flows = [...new Map(usages.flatMap((u) => u.flows).map((f) => [f.id, f.name])).values()];
    modal.confirm({
      title: targets.length === 1 ? `Delete equipment [${targets[0].name}]?` : `Delete ${targets.length} equipment?`,
      width: 460,
      content: (
        <div style={{ lineHeight: 1.7 }}>
          {targets.length > 1 && <div className="muted">{targets.map((t) => `[${t.name}]`).join(', ')}</div>}
          <div>
            수집 파일 <b>{files.toLocaleString()}</b>개 · 레코드 <b>{records.toLocaleString()}</b>행이 함께 삭제되며 되돌릴 수 없어요.
          </div>
          <div className="muted" style={{ fontSize: 12 }}>로그 원본 파일은 설비에 그대로 남아 있어요.</div>
          {flows.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message={`${flows.length} flow(s) use this equipment`}
              description={<span>{flows.join(', ')} — 설비 데이터 노드에서 선택이 해제돼요.</span>}
            />
          )}
        </div>
      ),
      okText: 'Delete',
      okButtonProps: { danger: true },
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const r = await api.post('/api/equipment/delete', { ids: targets.map((t) => t.id) });
          message.success(`Deleted ${r.deleted.length} equipment.`);
          onDone(r.deleted);
        } catch (e: any) {
          message.error(e.message);
          throw e;
        }
      },
    });
  };
}

export default function EquipmentPage() {
  const { message } = App.useApp();
  const [list, setList] = useState<Equipment[]>([]);
  const [parsers, setParsers] = useState<Parser[]>([]);
  const [sugg, setSugg] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [detail, setDetail] = useState<Equipment | null>(null);
  const [filter, setFilter] = useState({ q: '', process: undefined as string | undefined });
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [sp, setSp] = useSearchParams();

  const load = useCallback(() => {
    api.get<Equipment[]>('/api/equipment').then(setList);
  }, []);
  const removeEquipment = useDeleteEquipment((deleted) => {
    setSelected((s) => s.filter((id) => !deleted.includes(id)));
    if (detail && deleted.includes(detail.id)) setDetail(null);
    if (editing?.id && deleted.includes(editing.id)) setEditing(null);
    load();
    api.get('/api/equipment/suggestions').then(setSugg);
  });

  // 통합 검색 / 수집 현황 티커 / 레일에서 들어온 링크 처리
  useEffect(() => {
    const eqId = Number(sp.get('eq'));
    if (sp.get('new') === '1') {
      setEditing({ ...EMPTY });
      setSp({}, { replace: true });
    } else if (eqId && list.length) {
      const e = list.find((x) => x.id === eqId);
      if (e) setDetail(e);
      setSp({}, { replace: true });
    }
  }, [sp, list]);
  useEffect(() => {
    load();
    api.get<Parser[]>('/api/parsers').then(setParsers);
    api.get('/api/equipment/suggestions').then(setSugg);
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const capture = async (e: Equipment) => {
    setBusy((b) => ({ ...b, [e.id]: true }));
    try {
      const r = await api.post(`/api/equipment/${e.id}/capture`);
      if (r.status === 'ok') message.success(`[${e.name}] ${r.message}`);
      else if (r.status === 'busy') message.info(r.message);
      else message.error(`[${e.name}] ${r.message.split('\n')[0]}`);
    } finally {
      setBusy((b) => ({ ...b, [e.id]: false }));
      load();
    }
  };

  const toggle = async (e: Equipment, enabled: boolean) => {
    await api.put(`/api/equipment/${e.id}`, { ...e, enabled });
    load();
  };

  const rows = useMemo(
    () =>
      list.filter(
        (e) =>
          (!filter.process || e.process === filter.process) &&
          (!filter.q || `${e.name} ${e.ip} ${e.factory} ${e.customer} ${e.product} ${e.project}`.toLowerCase().includes(filter.q.toLowerCase())),
      ),
    [list, filter],
  );

  const running = list.filter((e) => e.enabled).length;
  return (
    <div className="page">
      <StageHeader
        stage="capture"
        hints={{
          '/capture/equipment': (
            <>
              <span className="dot" style={{ background: list.some((e) => e.enabled && e.status === 'error') ? 'var(--red)' : 'var(--green)' }} />
              {running} active
            </>
          ),
        }}
        extra={
          <>
            {selected.length > 0 && (
              <Button danger icon={<DeleteOutlined />} onClick={() => removeEquipment(list.filter((e) => selected.includes(e.id)))}>
                Delete selected ({selected.length})
              </Button>
            )}
            <Input placeholder="Name · IP · factory · customer" allowClear prefix={<SearchOutlined className="muted" />} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ width: 240 }} />
            <Button icon={<ReloadOutlined />} onClick={load} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ ...EMPTY })}>
              Add equipment
            </Button>
          </>
        }
      />
      <div className="pill-tabs" style={{ marginBottom: 10 }}>
        {[undefined, ...(sugg.process ?? [])].map((p) => (
          <div key={p ?? 'all'} className={`pill-tab ${filter.process === p ? 'active' : ''}`} onClick={() => setFilter((f) => ({ ...f, process: p }))}>
            {p ?? 'All processes'}
          </div>
        ))}
      </div>
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1520 }}
        rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as number[]), columnWidth: 44, fixed: true }}
        onRow={(e) => ({ onDoubleClick: () => setDetail(e) })}
        columns={[
          {
            title: 'Equipment',
            dataIndex: 'name',
            width: 210,
            fixed: 'left',
            render: (v, e) => (
              <a onClick={() => setDetail(e)} style={{ display: 'inline-flex', alignItems: 'center', gap: 10, color: 'var(--text-1)', fontWeight: 600 }}>
                <span className="avatar" style={{ background: accentOf(e.process || v), width: 30, height: 30 }}>
                  {(e.process || v).slice(0, 1)}
                </span>
                {v}
              </a>
            ),
          },
          {
            title: 'Status',
            width: 110,
            render: (_, e) => <StatusTag status={e.running ? 'running' : e.status} enabled={e.enabled} />,
          },
          ...INFO_FIELDS.map(([k, title]) => ({ title, dataIndex: k, width: k === 'factory' ? 110 : 100 })),
          { title: 'IP', dataIndex: 'ip', width: 110, className: 'num' },
          { title: 'Method', dataIndex: 'access_method', width: 90, render: (v) => <span className="muted">{v.toUpperCase()}</span> },
          { title: 'Interval', dataIndex: 'capture_interval_sec', width: 90, render: (v) => (v >= 60 ? `${Math.round(v / 60)} min` : `${v}s`) },
          { title: 'Parser', dataIndex: 'parser_name', width: 150, render: (v) => v ?? <Typography.Text type="danger">Not set</Typography.Text> },
          { title: 'Records', dataIndex: 'record_count', width: 100, align: 'right', className: 'num', render: (v) => <b>{(v ?? 0).toLocaleString()}</b> },
          {
            title: 'Last capture',
            dataIndex: 'last_capture_at',
            width: 160,
            render: (v, e) =>
              e.last_error ? (
                <Tooltip title={<pre style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 300, overflow: 'auto' }}>{e.last_error}</pre>}>
                  <Typography.Text type="danger">{fmtTime(v)}</Typography.Text>
                </Tooltip>
              ) : (
                fmtTime(v)
              ),
          },
          {
            title: 'Active',
            dataIndex: 'enabled',
            width: 70,
            render: (v, e) => <Switch size="small" checked={v} onChange={(c) => toggle(e, c)} />,
          },
          {
            title: '',
            width: 176,
            fixed: 'right',
            render: (_, e) => (
              <Space size={2} onDoubleClick={(ev) => ev.stopPropagation()}>
                <Tooltip title="Capture now">
                  <Button type="text" icon={<PlayCircleOutlined />} loading={busy[e.id] || e.running} disabled={e.access_method === 'agent'} onClick={() => capture(e)} />
                </Tooltip>
                <Tooltip title="Details / data">
                  <Button type="text" icon={<EyeOutlined />} onClick={() => setDetail(e)} />
                </Tooltip>
                <Tooltip title="Edit">
                  <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(e)} />
                </Tooltip>
                <Tooltip title="Delete">
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => removeEquipment([e])} />
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <EquipmentForm
          value={editing}
          parsers={parsers}
          equipment={list}
          reloadParsers={() => api.get<Parser[]>('/api/parsers').then(setParsers)}
          sugg={sugg}
          onDelete={editing.id ? () => removeEquipment([editing as Equipment]) : undefined}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            api.get('/api/equipment/suggestions').then(setSugg);
          }}
        />
      )}
      {detail && <EquipmentDetail eq={detail} onClose={() => setDetail(null)} onChanged={load} onDelete={() => removeEquipment([detail])} />}
    </div>
  );
}

function EquipmentForm({
  value,
  parsers,
  equipment,
  reloadParsers,
  sugg,
  onDelete,
  onClose,
  onSaved,
}: {
  onDelete?: () => void;
  value: Partial<Equipment>;
  parsers: Parser[];
  equipment: Equipment[];
  reloadParsers: () => Promise<unknown>;
  sugg: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [probe, setProbe] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  const [parserDraft, setParserDraft] = useState<Partial<Parser> | null>(null);
  const [parserDirty, setParserDirty] = useState(false);
  const method = Form.useWatch('access_method', form);
  const folderMode = Form.useWatch('folder_mode', form) ?? value.folder_mode ?? 'flat';
  const parserId = Form.useWatch('parser_id', form);

  const openParser = async (mode: 'edit' | 'new') => {
    if (mode === 'edit') {
      const p = parsers.find((x) => x.id === parserId);
      if (p) setParserDraft(p);
    } else {
      const { code } = await api.get('/api/parsers/template');
      const name = form.getFieldValue('name');
      setParserDraft({ name: name ? `${name} Parser` : '', description: '', code });
    }
  };
  const closeParser = () => {
    if (parserDirty && !confirm('You have unsaved parser changes. Close anyway?')) return;
    setParserDraft(null);
    setParserDirty(false);
  };

  const collect = async () => {
    const v = await form.validateFields();
    let options = {};
    try {
      options = v.options_text ? JSON.parse(v.options_text) : {};
    } catch {
      throw new Error('Options must be valid JSON.');
    }
    const { options_text, ...rest } = v;
    return { ...rest, options };
  };

  const save = async () => {
    try {
      const body = await collect();
      if (value.id) await api.put(`/api/equipment/${value.id}`, body);
      else await api.post('/api/equipment', body);
      message.success('Saved.');
      onSaved();
    } catch (e: any) {
      if (e?.message) message.error(e.message);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    try {
      const body = await collect();
      setProbe(await api.post('/api/equipment/probe', { ...body, id: value.id }));
    } catch (e: any) {
      if (e?.message) message.error(e.message);
    } finally {
      setProbing(false);
    }
  };

  const ac = (k: string) => (sugg[k] ?? []).map((s) => ({ value: s }));

  return (
    <Drawer
      open
      width={760}
      title={value.id ? `Edit equipment [${value.name}]` : 'Add equipment'}
      onClose={onClose}
      extra={
        <Space>
          {onDelete && (
            <Button danger icon={<DeleteOutlined />} onClick={onDelete}>
              Delete
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" onClick={save}>
            Save
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={{ ...value, options_text: JSON.stringify(value.options ?? {}, null, 2) }}>
        <Divider className="section-divider" orientation="left" plain style={{ marginTop: 0 }}>
          Basic Information
        </Divider>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="Name" rules={[{ required: true }]}>
              <Input placeholder="e.g. Blade Assembly #1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="ip" label="IP">
              <Input placeholder="10.10.1.11" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={10} wrap={false}>
          {INFO_FIELDS.map(([k, label]) => (
            <Col key={k} flex="1 1 0" style={{ minWidth: 0 }}>
              <Form.Item name={k} label={label}>
                <AutoComplete options={ac(k)} />
              </Form.Item>
            </Col>
          ))}
        </Row>
        <Form.Item name="description" label="Description">
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
        </Form.Item>

        <Divider className="section-divider" orientation="left" plain>
          Log Capture
        </Divider>
        <Form.Item name="access_method" label="Access method">
          <Radio.Group optionType="button" options={METHODS} />
        </Form.Item>
        {method === 'agent' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="For equipment on a separate LAN"
            description={
              <span>
                게이트웨이 PC(대표 설비 PC / 작업 PC)에서 <code>python prism_agent.py --server http://서버:8000 --equipment "{value.name || '설비명'}"</code> 를 실행하면
                아래 경로 설정을 서버에서 받아 변경된 파일만 전송합니다. 경로는 게이트웨이 PC 기준입니다.
              </span>
            }
          />
        )}
        {(method === 'ftp' || method === 'sftp') && (
          <Row gutter={12}>
            <Col span={6}>
              <Form.Item name="port" label="Port">
                <InputNumber style={{ width: '100%' }} placeholder={method === 'ftp' ? '21' : '22'} />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="username" label="Username">
                <Input />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="password" label="Password">
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
          </Row>
        )}
        <Form.Item name="folder_mode" label="Folder layout">
          <Radio.Group
            optionType="button"
            options={[
              { value: 'flat', label: 'Files directly in path' },
              { value: 'date', label: 'Dated folders under path' },
            ]}
          />
        </Form.Item>
        {folderMode === 'date' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="상위 폴더만 지정하면 그 아래 날짜 폴더를 자동으로 찾아요"
            description={
              <span>
                <code>20261124</code> <code>2026-11-24</code> <code>2026_11_24</code> <code>261124</code> <code>2026\11\24</code> <code>2026-11\24</code> 형식을 모두 인식하고(최대 3단계),
                오늘부터 <b>Lookback days</b> 전까지의 날짜 폴더만 확인합니다.
              </span>
            }
          />
        )}
        <Form.Item
          name="log_path"
          label={folderMode === 'date' ? 'Log root folder (contains the dated folders)' : 'Log folder'}
          rules={[{ required: true }]}
          extra={
            folderMode === 'date' ? (
              <span>
                예) <code>{'\\\\{ip}\\Log'}</code> → <code>{'\\\\10.10.1.11\\Log\\20261124\\*.csv'}</code> 를 찾음 · 치환자 <code>{'{ip}'}</code> <code>{'{name}'}</code> <code>{'{process}'}</code> 사용 가능
              </span>
            ) : (
              <span>
                치환자: <code>{'{ip}'}</code> <code>{'{name}'}</code> <code>{'{process}'}</code> <code>{'{date:%Y%m%d}'}</code> · 예){' '}
                <code>{'\\\\{ip}\\Log'}</code> , <code>{'\\\\{ip}\\Log\\{date:%Y%m%d}'}</code> · FS 방식은 * ** 와일드카드 가능
              </span>
            )
          }
        >
          <Input className="mono" placeholder={folderMode === 'date' ? '\\\\{ip}\\Log' : undefined} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={10}>
            <Form.Item name="file_pattern" label="File name pattern" extra={<span>예) <code>{'Result_{date:%Y%m%d}*.csv'}</code></span>}>
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="lookback_days" label="Lookback days" tooltip="오늘 포함 며칠 전 날짜 폴더/파일까지 확인할지">
              <InputNumber min={0} max={365} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="capture_interval_sec" label="Capture interval (s)">
              <InputNumber min={10} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="encoding" label="Encoding">
              <AutoComplete options={ENCODINGS.map((e) => ({ value: e }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12} align="bottom">
          <Col span={14}>
            <Form.Item label="Parser" required>
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="parser_id" noStyle rules={[{ required: true, message: 'Choose a parser or create one' }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={parsers.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="Select parser"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                <Tooltip title="Edit selected parser code">
                  <Button icon={<EditOutlined />} disabled={!parserId} onClick={() => openParser('edit')} />
                </Tooltip>
                <Tooltip title="New parser">
                  <Button icon={<PlusOutlined />} onClick={() => openParser('new')} />
                </Tooltip>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="enabled" label="Active" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item>
              <Button block onClick={runProbe} loading={probing}>
                Check path / files
              </Button>
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="options_text" label="Equipment options (JSON, ctx['options'] in the parser)">
          <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 8 }} />
        </Form.Item>
      </Form>
      {probe && (
        <div>
          {!probe.ok && <Alert type="error" message={probe.error} showIcon />}
          {probe.ok && (
            <>
              <Typography.Text type="secondary">Searched locations</Typography.Text>
              <ul className="mono" style={{ margin: '4px 0 8px', paddingLeft: 18 }}>
                {probe.locations.map((l: any, i: number) => (
                  <li key={i}>
                    {l.dir} / {l.pattern}
                  </li>
                ))}
              </ul>
              {probe.message && <Alert type="info" message={probe.message} />}
              {probe.total !== undefined && (
                <Table
                  size="small"
                  rowKey="path"
                  title={() => `${probe.total} files found`}
                  dataSource={probe.files}
                  pagination={{ pageSize: 8, size: 'small' }}
                  columns={[
                    { title: 'File', dataIndex: 'path', className: 'mono', ellipsis: true, render: (v: string) => <Tooltip title={v}>{v.split(/[\\/]/).slice(-2).join('/')}</Tooltip> },
                    { title: 'Size', dataIndex: 'size', width: 90, align: 'right', render: (v) => `${(v / 1024).toFixed(1)} KB` },
                    { title: 'Modified', dataIndex: 'mtime', width: 150, render: fmtTime },
                    { title: 'Captured', dataIndex: 'captured', width: 70, render: (v) => (v ? <StatusTag status={v} /> : <Tag>New</Tag>) },
                  ]}
                />
              )}
            </>
          )}
        </div>
      )}
      <Drawer
        open={!!parserDraft}
        width="min(1080px, 94vw)"
        title={parserDraft?.id ? `Edit parser [${parserDraft.name}]` : parserDraft ? 'New parser' : ''}
        onClose={closeParser}
        destroyOnClose
        styles={{ body: { background: 'var(--bg-sub)', padding: 16 } }}
      >
        {parserDraft && (
          <ParserEditor
            value={parserDraft}
            equipment={equipment}
            defaultEquipmentId={value.id}
            codeHeight="340px"
            onDirtyChange={setParserDirty}
            onSaved={async (p) => {
              await reloadParsers();
              form.setFieldValue('parser_id', p.id);
              setParserDirty(false);
              if (!parserDraft.id) setParserDraft(null);
            }}
            onDeleted={async (id) => {
              await reloadParsers();
              if (form.getFieldValue('parser_id') === id) form.setFieldValue('parser_id', undefined);
              setParserDirty(false);
              setParserDraft(null);
            }}
          />
        )}
      </Drawer>
    </Drawer>
  );
}

function EquipmentDetail({ eq, onClose, onChanged, onDelete }: { eq: Equipment; onClose: () => void; onChanged: () => void; onDelete: () => void }) {
  const { message } = App.useApp();
  const [records, setRecords] = useState<FramePayload | null>(null);
  const [files, setFiles] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const load = useCallback(() => {
    api.get(`/api/equipment/${eq.id}/records?limit=500`).then(setRecords);
    api.get(`/api/equipment/${eq.id}/files`).then(setFiles);
    api.get(`/api/equipment/${eq.id}/runs`).then(setRuns);
  }, [eq.id]);
  useEffect(load, [load]);

  return (
    <Drawer
      open
      width="min(1200px, 92vw)"
      title={`[${eq.name}]`}
      onClose={onClose}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load} />
          <Popconfirm
            title="Reset data?" description="수집 이력과 레코드를 모두 삭제하고 다음 주기에 다시 파싱합니다."
            onConfirm={async () => {
              await api.post(`/api/equipment/${eq.id}/reset`);
              message.success('Data reset.');
              load();
              onChanged();
            }}
          >
            <Button>Reset data</Button>
          </Popconfirm>
          <Button danger icon={<DeleteOutlined />} onClick={onDelete}>
            Delete equipment
          </Button>
        </Space>
      }
    >
      <Descriptions size="small" column={5} bordered style={{ marginBottom: 12 }}>
        {INFO_FIELDS.map(([k, label]) => (
          <Descriptions.Item key={k} label={label}>
            {eq[k]}
          </Descriptions.Item>
        ))}
        <Descriptions.Item label="IP">{eq.ip}</Descriptions.Item>
        <Descriptions.Item label="Parser">{eq.parser_name}</Descriptions.Item>
        <Descriptions.Item label="Path" span={3}>
          <span className="mono">
            {eq.log_path}
            {eq.folder_mode === 'date' ? ' / (dated folder) / ' : ' / '}
            {eq.file_pattern}
          </span>
        </Descriptions.Item>
      </Descriptions>
      {eq.last_error && <pre className="err-pre" style={{ marginBottom: 12 }}>{eq.last_error}</pre>}
      <Tabs
        items={[
          {
            key: 'rec',
            label: `Records (${(records?.row_count ?? 0).toLocaleString()})`,
            children: <DataGrid data={records} height="calc(100vh - 420px)" />,
          },
          {
            key: 'files',
            label: `Captured files (${files.length})`,
            children: (
              <Table
                size="small"
                rowKey="id"
                dataSource={files}
                pagination={{ pageSize: 20, size: 'small' }}
                columns={[
                  { title: 'Path', dataIndex: 'path', className: 'mono', ellipsis: true },
                  { title: 'Rows', dataIndex: 'rows', width: 80, align: 'right' },
                  { title: 'Size', dataIndex: 'size', width: 90, align: 'right', render: (v) => `${(v / 1024).toFixed(1)} KB` },
                  { title: 'Status', dataIndex: 'status', width: 100, render: (v, r) => (
                    <Tooltip title={r.error ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.error}</pre> : undefined}>
                      <span><StatusTag status={v} /></span>
                    </Tooltip>
                  ) },
                  { title: 'Processed at', dataIndex: 'captured_at', width: 160, render: fmtTime },
                ]}
              />
            ),
          },
          {
            key: 'runs',
            label: 'Capture runs',
            children: (
              <Table
                size="small"
                rowKey="id"
                dataSource={runs}
                pagination={{ pageSize: 20, size: 'small' }}
                expandable={{ expandedRowRender: (r) => <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.message}</pre> }}
                columns={[
                  { title: 'Started', dataIndex: 'started_at', width: 160, render: fmtTime },
                  { title: 'Trigger', dataIndex: 'trigger', width: 90 },
                  { title: 'Status', dataIndex: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
                  { title: 'Found', dataIndex: 'files_found', width: 70, align: 'right' },
                  { title: 'Parsed', dataIndex: 'files_parsed', width: 70, align: 'right' },
                  { title: 'Rows', dataIndex: 'rows', width: 80, align: 'right' },
                  { title: 'Message', dataIndex: 'message', ellipsis: true },
                ]}
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
}
