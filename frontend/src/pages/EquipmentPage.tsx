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
  { value: 'fs', label: '파일 경로 (로컬/UNC 공유)' },
  { value: 'ftp', label: 'FTP' },
  { value: 'sftp', label: 'SFTP' },
  { value: 'agent', label: 'Agent (별도 LAN 게이트웨이 push)' },
];
const ENCODINGS = ['utf-8', 'utf-8-sig', 'cp949', 'euc-kr', 'latin-1'];

const EMPTY: Partial<Equipment> = {
  access_method: 'fs',
  file_pattern: '*.csv',
  lookback_days: 1,
  encoding: 'utf-8',
  capture_interval_sec: 300,
  enabled: true,
  options: {},
};

export default function EquipmentPage() {
  const { message } = App.useApp();
  const [list, setList] = useState<Equipment[]>([]);
  const [parsers, setParsers] = useState<Parser[]>([]);
  const [sugg, setSugg] = useState<Record<string, string[]>>({});
  const [editing, setEditing] = useState<Partial<Equipment> | null>(null);
  const [detail, setDetail] = useState<Equipment | null>(null);
  const [filter, setFilter] = useState({ q: '', process: undefined as string | undefined });
  const [busy, setBusy] = useState<Record<number, boolean>>({});
  const [sp, setSp] = useSearchParams();

  const load = useCallback(() => {
    api.get<Equipment[]>('/api/equipment').then(setList);
  }, []);

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
      if (r.status === 'ok') message.success(`${e.name}: ${r.message}`);
      else if (r.status === 'busy') message.info(r.message);
      else message.error(`${e.name}: ${r.message.split('\n')[0]}`);
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
          (!filter.q || `${e.name} ${e.ip} ${e.factory} ${e.product} ${e.project}`.toLowerCase().includes(filter.q.toLowerCase())),
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
              {running}대 운영
            </>
          ),
        }}
        extra={
          <>
            <Input placeholder="설비명 · IP · 공장" allowClear prefix={<SearchOutlined className="muted" />} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} style={{ width: 220 }} />
            <Button icon={<ReloadOutlined />} onClick={load} />
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ ...EMPTY })}>
              설비 추가
            </Button>
          </>
        }
      />
      <div className="pill-tabs" style={{ marginBottom: 10 }}>
        {[undefined, ...(sugg.process ?? [])].map((p) => (
          <div key={p ?? 'all'} className={`pill-tab ${filter.process === p ? 'active' : ''}`} onClick={() => setFilter((f) => ({ ...f, process: p }))}>
            {p ?? '전체 공정'}
          </div>
        ))}
      </div>
      <Table
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ x: 1300 }}
        onRow={(e) => ({ onDoubleClick: () => setDetail(e) })}
        columns={[
          {
            title: '설비',
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
            title: '상태',
            width: 110,
            render: (_, e) => <StatusTag status={e.running ? 'running' : e.status} enabled={e.enabled} />,
          },
          { title: '공장', dataIndex: 'factory', width: 110 },
          { title: '제품', dataIndex: 'product', width: 90 },
          { title: '과제', dataIndex: 'project', width: 100 },
          { title: '공정', dataIndex: 'process', width: 100 },
          { title: 'IP', dataIndex: 'ip', width: 110, className: 'num' },
          { title: '방식', dataIndex: 'access_method', width: 70, render: (v) => <span className="muted">{v.toUpperCase()}</span> },
          { title: '주기', dataIndex: 'capture_interval_sec', width: 70, render: (v) => (v >= 60 ? `${Math.round(v / 60)}분` : `${v}초`) },
          { title: 'Parser', dataIndex: 'parser_name', width: 150, render: (v) => v ?? <Typography.Text type="danger">미지정</Typography.Text> },
          { title: '레코드', dataIndex: 'record_count', width: 100, align: 'right', className: 'num', render: (v) => <b>{(v ?? 0).toLocaleString()}</b> },
          {
            title: '마지막 수집',
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
            title: '운영',
            dataIndex: 'enabled',
            width: 70,
            render: (v, e) => <Switch size="small" checked={v} onChange={(c) => toggle(e, c)} />,
          },
          {
            title: '',
            width: 150,
            fixed: 'right',
            render: (_, e) => (
              <Space size={2}>
                <Tooltip title="지금 수집">
                  <Button type="text" icon={<PlayCircleOutlined />} loading={busy[e.id] || e.running} disabled={e.access_method === 'agent'} onClick={() => capture(e)} />
                </Tooltip>
                <Tooltip title="상세/데이터">
                  <Button type="text" icon={<EyeOutlined />} onClick={() => setDetail(e)} />
                </Tooltip>
                <Tooltip title="편집">
                  <Button type="text" icon={<EditOutlined />} onClick={() => setEditing(e)} />
                </Tooltip>
                <Popconfirm title={`'${e.name}' 및 수집 데이터를 삭제할까요?`} onConfirm={() => api.del(`/api/equipment/${e.id}`).then(load)}>
                  <Button type="text" danger icon={<DeleteOutlined />} />
                </Popconfirm>
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
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            api.get('/api/equipment/suggestions').then(setSugg);
          }}
        />
      )}
      {detail && <EquipmentDetail eq={detail} onClose={() => setDetail(null)} onChanged={load} />}
    </div>
  );
}

function EquipmentForm({
  value,
  parsers,
  equipment,
  reloadParsers,
  sugg,
  onClose,
  onSaved,
}: {
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
    if (parserDirty && !confirm('저장하지 않은 Parser 변경 사항이 있어요. 닫을까요?')) return;
    setParserDraft(null);
    setParserDirty(false);
  };

  const collect = async () => {
    const v = await form.validateFields();
    let options = {};
    try {
      options = v.options_text ? JSON.parse(v.options_text) : {};
    } catch {
      throw new Error('옵션 JSON 형식이 올바르지 않습니다.');
    }
    const { options_text, ...rest } = v;
    return { ...rest, options };
  };

  const save = async () => {
    try {
      const body = await collect();
      if (value.id) await api.put(`/api/equipment/${value.id}`, body);
      else await api.post('/api/equipment', body);
      message.success('저장되었습니다.');
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
      title={value.id ? `설비 편집 · ${value.name}` : '설비 추가'}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>취소</Button>
          <Button type="primary" onClick={save}>
            저장
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" initialValues={{ ...value, options_text: JSON.stringify(value.options ?? {}, null, 2) }}>
        <Divider orientation="left" plain style={{ marginTop: 0 }}>
          기본 정보
        </Divider>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="name" label="설비명" rules={[{ required: true }]}>
              <Input placeholder="예) Blade 조립기 #1" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="ip" label="IP">
              <Input placeholder="10.10.1.11" />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="factory" label="공장">
              <AutoComplete options={ac('factory')} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="product" label="제품">
              <AutoComplete options={ac('product')} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="project" label="과제">
              <AutoComplete options={ac('project')} />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item name="process" label="공정">
              <AutoComplete options={ac('process')} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="description" label="설명">
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
        </Form.Item>

        <Divider orientation="left" plain>
          로그 수집
        </Divider>
        <Form.Item name="access_method" label="접근 방식">
          <Radio.Group optionType="button" options={METHODS} />
        </Form.Item>
        {method === 'agent' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="별도 LAN 설비용"
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
              <Form.Item name="port" label="포트">
                <InputNumber style={{ width: '100%' }} placeholder={method === 'ftp' ? '21' : '22'} />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="username" label="계정">
                <Input />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="password" label="비밀번호">
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </Col>
          </Row>
        )}
        <Form.Item
          name="log_path"
          label="로그 저장 경로 (폴더)"
          rules={[{ required: true }]}
          extra={
            <span>
              치환자: <code>{'{ip}'}</code> <code>{'{name}'}</code> <code>{'{process}'}</code> <code>{'{date:%Y%m%d}'}</code> · 예){' '}
              <code>{'\\\\{ip}\\Log\\{date:%Y%m%d}'}</code> , <code>{'/data/log/{date:%Y-%m}'}</code> · FS 방식은 * ** 와일드카드 가능
            </span>
          }
        >
          <Input className="mono" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={10}>
            <Form.Item name="file_pattern" label="파일명 패턴" extra={<span>예) <code>{'Result_{date:%Y%m%d}*.csv'}</code></span>}>
              <Input className="mono" />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="lookback_days" label="조회 일수" tooltip="오늘 포함 며칠 전 날짜 폴더/파일까지 확인할지">
              <InputNumber min={0} max={365} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={5}>
            <Form.Item name="capture_interval_sec" label="수집 주기(초)">
              <InputNumber min={10} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="encoding" label="인코딩">
              <AutoComplete options={ENCODINGS.map((e) => ({ value: e }))} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12} align="bottom">
          <Col span={14}>
            <Form.Item label="Parser" required style={{ marginBottom: 0 }}>
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="parser_id" noStyle rules={[{ required: true, message: 'Parser를 선택하거나 새로 만드세요' }]}>
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={parsers.map((p) => ({ value: p.id, label: p.name }))}
                    placeholder="Parser 선택"
                    style={{ width: '100%' }}
                  />
                </Form.Item>
                <Tooltip title="선택한 Parser 코드 편집">
                  <Button icon={<EditOutlined />} disabled={!parserId} onClick={() => openParser('edit')} />
                </Tooltip>
                <Tooltip title="새 Parser 만들기">
                  <Button icon={<PlusOutlined />} onClick={() => openParser('new')} />
                </Tooltip>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col span={4}>
            <Form.Item name="enabled" label="운영" valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
          <Col span={6}>
            <Form.Item>
              <Button block onClick={runProbe} loading={probing}>
                경로/파일 확인
              </Button>
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="options_text" label="설비별 옵션 (JSON, Parser에서 ctx['options'] 로 사용)">
          <Input.TextArea className="mono" autoSize={{ minRows: 2, maxRows: 8 }} />
        </Form.Item>
      </Form>
      {probe && (
        <div>
          {!probe.ok && <Alert type="error" message={probe.error} showIcon />}
          {probe.ok && (
            <>
              <Typography.Text type="secondary">조회 위치</Typography.Text>
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
                  title={() => `발견된 파일 ${probe.total}개`}
                  dataSource={probe.files}
                  pagination={{ pageSize: 8, size: 'small' }}
                  columns={[
                    { title: '파일', dataIndex: 'path', className: 'mono', ellipsis: true, render: (v: string) => <Tooltip title={v}>{v.split(/[\\/]/).slice(-2).join('/')}</Tooltip> },
                    { title: '크기', dataIndex: 'size', width: 90, align: 'right', render: (v) => `${(v / 1024).toFixed(1)} KB` },
                    { title: '수정', dataIndex: 'mtime', width: 150, render: fmtTime },
                    { title: '수집', dataIndex: 'captured', width: 70, render: (v) => (v ? <StatusTag status={v} /> : <Tag>신규</Tag>) },
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
        title={parserDraft?.id ? `Parser 편집 · ${parserDraft.name}` : parserDraft ? '새 Parser' : ''}
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

function EquipmentDetail({ eq, onClose, onChanged }: { eq: Equipment; onClose: () => void; onChanged: () => void }) {
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
      title={eq.name}
      onClose={onClose}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load} />
          <Popconfirm
            title="수집 이력과 레코드를 모두 삭제하고 다음 주기에 다시 파싱합니다."
            onConfirm={async () => {
              await api.post(`/api/equipment/${eq.id}/reset`);
              message.success('초기화되었습니다.');
              load();
              onChanged();
            }}
          >
            <Button danger>데이터 초기화</Button>
          </Popconfirm>
        </Space>
      }
    >
      <Descriptions size="small" column={4} bordered style={{ marginBottom: 12 }}>
        <Descriptions.Item label="공장">{eq.factory}</Descriptions.Item>
        <Descriptions.Item label="제품">{eq.product}</Descriptions.Item>
        <Descriptions.Item label="과제">{eq.project}</Descriptions.Item>
        <Descriptions.Item label="공정">{eq.process}</Descriptions.Item>
        <Descriptions.Item label="IP">{eq.ip}</Descriptions.Item>
        <Descriptions.Item label="Parser">{eq.parser_name}</Descriptions.Item>
        <Descriptions.Item label="경로" span={2}>
          <span className="mono">
            {eq.log_path} / {eq.file_pattern}
          </span>
        </Descriptions.Item>
      </Descriptions>
      {eq.last_error && <pre className="err-pre" style={{ marginBottom: 12 }}>{eq.last_error}</pre>}
      <Tabs
        items={[
          {
            key: 'rec',
            label: `레코드 (${(records?.row_count ?? 0).toLocaleString()})`,
            children: <DataGrid data={records} height="calc(100vh - 420px)" />,
          },
          {
            key: 'files',
            label: `수집 파일 (${files.length})`,
            children: (
              <Table
                size="small"
                rowKey="id"
                dataSource={files}
                pagination={{ pageSize: 20, size: 'small' }}
                columns={[
                  { title: '경로', dataIndex: 'path', className: 'mono', ellipsis: true },
                  { title: '행', dataIndex: 'rows', width: 80, align: 'right' },
                  { title: '크기', dataIndex: 'size', width: 90, align: 'right', render: (v) => `${(v / 1024).toFixed(1)} KB` },
                  { title: '상태', dataIndex: 'status', width: 100, render: (v, r) => (
                    <Tooltip title={r.error ? <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.error}</pre> : undefined}>
                      <span><StatusTag status={v} /></span>
                    </Tooltip>
                  ) },
                  { title: '처리 시각', dataIndex: 'captured_at', width: 160, render: fmtTime },
                ]}
              />
            ),
          },
          {
            key: 'runs',
            label: '수집 이력',
            children: (
              <Table
                size="small"
                rowKey="id"
                dataSource={runs}
                pagination={{ pageSize: 20, size: 'small' }}
                expandable={{ expandedRowRender: (r) => <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{r.message}</pre> }}
                columns={[
                  { title: '시작', dataIndex: 'started_at', width: 160, render: fmtTime },
                  { title: '트리거', dataIndex: 'trigger', width: 90 },
                  { title: '상태', dataIndex: 'status', width: 110, render: (v) => <StatusTag status={v} /> },
                  { title: '발견', dataIndex: 'files_found', width: 70, align: 'right' },
                  { title: '처리', dataIndex: 'files_parsed', width: 70, align: 'right' },
                  { title: '행', dataIndex: 'rows', width: 80, align: 'right' },
                  { title: '메시지', dataIndex: 'message', ellipsis: true },
                ]}
              />
            ),
          },
        ]}
      />
    </Drawer>
  );
}
