import { Alert, App, Button, Input, Select, Space, Tag, Typography, Upload } from 'antd';
import { CaretRightOutlined, CopyOutlined, DeleteOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';
import { api, Equipment, fmtTime, Parser } from '../api';
import CodeEditor from './CodeEditor';
import DataGrid from './DataGrid';

type Props = {
  value: Partial<Parser>;
  equipment: Equipment[];
  defaultEquipmentId?: number;
  codeHeight?: string;
  onSaved: (p: Parser) => void;
  onDeleted: (id: number) => void;
  onDuplicate?: (draft: Partial<Parser>) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

/** Parser 추가/편집/삭제/테스트 — Parser 화면과 설비 편집 화면에서 공용 */
export default function ParserEditor({ value, equipment, defaultEquipmentId, codeHeight = '380px', onSaved, onDeleted, onDuplicate, onDirtyChange }: Props) {
  const { message, modal } = App.useApp();
  const [cur, setCur] = useState<Partial<Parser>>(value);
  const [dirty, setDirtyState] = useState(!value.id);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ equipment_id?: number; server_path?: string; file?: File | null }>({});
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);

  const setDirty = (d: boolean) => {
    setDirtyState(d);
    onDirtyChange?.(d);
  };
  const users = equipment.filter((e) => cur.id && e.parser_id === cur.id);

  const pickEquipment = async (id?: number) => {
    setTest((t) => ({ ...t, equipment_id: id }));
    if (id) {
      const r = await api.get(`/api/equipment/${id}/parser-sample`);
      if (r.path) setTest((t) => ({ ...t, server_path: r.path, file: null }));
    }
  };

  useEffect(() => {
    onDirtyChange?.(!value.id);
    const eqId = defaultEquipmentId ?? equipment.find((e) => value.id && e.parser_id === value.id)?.id;
    if (eqId) pickEquipment(eqId);
  }, []);

  const save = useCallback(async () => {
    if (!cur.name?.trim()) return message.warning('Enter a parser name.');
    if (!cur.code?.includes('def parse')) return message.warning('The code needs a def parse(path, ctx) function.');
    setSaving(true);
    try {
      const body = { name: cur.name.trim(), description: cur.description ?? '', code: cur.code ?? '' };
      const saved: Parser = cur.id ? await api.put(`/api/parsers/${cur.id}`, body) : await api.post('/api/parsers', body);
      setCur(saved);
      setDirty(false);
      message.success(cur.id ? 'Saved. Equipment using this parser is re-parsed on its next capture.' : `Added parser [${saved.name}].`);
      onSaved(saved);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  }, [cur]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [save]);

  const remove = async () => {
    await api.del(`/api/parsers/${cur.id}`);
    message.success(`Deleted parser [${cur.name}].`);
    onDeleted(cur.id!);
  };

  const run = async () => {
    const fd = new FormData();
    fd.append('code', cur.code ?? '');
    if (test.equipment_id) fd.append('equipment_id', String(test.equipment_id));
    if (test.file) fd.append('file', test.file);
    else if (test.server_path) fd.append('server_path', test.server_path);
    setRunning(true);
    try {
      setResult(await api.post('/api/parsers/test', fd));
    } finally {
      setRunning(false);
    }
  };

  const upd = (patch: Partial<Parser>) => {
    setCur((c) => ({ ...c, ...patch }));
    setDirty(true);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <div className="panel">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
          <Input value={cur.name} placeholder="Parser name (required)" status={!cur.name?.trim() ? 'warning' : undefined} onChange={(e) => upd({ name: e.target.value })} style={{ width: 240, fontWeight: 600 }} />
          <Input value={cur.description} placeholder="Description" onChange={(e) => upd({ description: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
          {dirty && <Tag color="orange">Unsaved</Tag>}
          <Button type="primary" icon={<SaveOutlined />} onClick={save} loading={saving} disabled={!dirty}>
            {cur.id ? 'Save' : 'Add'}
          </Button>
          {cur.id && onDuplicate && (
            <Button icon={<CopyOutlined />} onClick={() => onDuplicate({ name: `${cur.name} (copy)`, description: cur.description, code: cur.code })}>
              Duplicate
            </Button>
          )}
          {cur.id && (
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `Delete parser [${cur.name}]?`,
                  content: users.length
                    ? `사용 중인 설비 ${users.length}대(${users.map((u) => `[${u.name}]`).join(', ')})는 Parser 미지정 상태가 되어 수집이 멈춰요.`
                    : '사용 중인 설비는 없어요.',
                  okText: 'Delete',
                  okButtonProps: { danger: true },
                  cancelText: 'Cancel',
                  onOk: remove,
                })
              }
            >
              Delete
            </Button>
          )}
        </div>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
          <code>def parse(path, ctx)</code> 가 DataFrame(또는 list[dict])을 반환하면 각 행이 레코드로 저장돼요. <code>_ts</code> 컬럼은 레코드 시각이 됩니다.
          {cur.id && (
            <>
              {' '}· Used by {users.length ? users.map((u) => `[${u.name}]`).join(', ') : 'none'} · Updated {fmtTime(cur.updated_at)} · Ctrl+S to save
            </>
          )}
        </Typography.Paragraph>
        <CodeEditor value={cur.code ?? ''} onChange={(code) => upd({ code })} height={codeHeight} />
      </div>

      <div className="panel">
        <div className="panel-title">
          <span>
            Test <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>저장하지 않고 샘플 파일로 실행</span>
          </span>
          <Button type="primary" ghost icon={<CaretRightOutlined />} onClick={run} loading={running}>
            Run
          </Button>
        </div>
        <Space wrap style={{ marginBottom: 10 }}>
          <Select
            allowClear
            placeholder="Equipment (uses its encoding, options, latest file)"
            style={{ width: 240 }}
            value={test.equipment_id}
            options={equipment.map((e) => ({ value: e.id, label: e.name }))}
            onChange={pickEquipment}
          />
          <Input
            className="mono"
            placeholder="File path on the server"
            style={{ width: 380 }}
            value={test.server_path}
            onChange={(e) => setTest((t) => ({ ...t, server_path: e.target.value, file: null }))}
          />
          <Upload
            maxCount={1}
            beforeUpload={(f) => {
              setTest((t) => ({ ...t, file: f }));
              return false;
            }}
            onRemove={() => setTest((t) => ({ ...t, file: null }))}
            fileList={test.file ? [{ uid: '1', name: test.file.name }] : []}
          >
            <Button icon={<UploadOutlined />}>Upload sample file</Button>
          </Upload>
        </Space>
        {result && !result.ok && (
          <>
            <Alert type="error" message={result.error} showIcon style={{ marginBottom: 6 }} />
            {result.detail && <pre className="err-pre">{result.detail}</pre>}
          </>
        )}
        {result?.ok && (
          <>
            <Space style={{ marginBottom: 6 }} wrap>
              <Tag color="blue">{result.preview.row_count.toLocaleString()} rows</Tag>
              <Tag>{result.preview.columns.length} columns</Tag>
              <Tag>{result.elapsed_ms} ms</Tag>
              {result.has_ts ? (
                <Tag color="green">
                  _ts: {fmtTime(result.ts_min)} ~ {fmtTime(result.ts_max)}
                </Tag>
              ) : (
                <Tag color="orange">No _ts → using file modified time</Tag>
              )}
            </Space>
            <DataGrid data={result.preview} height={280} />
          </>
        )}
      </div>
    </Space>
  );
}
