import { App, Button, Empty, Input, Popconfirm, Tooltip } from 'antd';
import { CopyOutlined, DeleteOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, Equipment, fmtTime, Parser } from '../api';
import ParserEditor from '../components/ParserEditor';
import StageHeader from '../components/StageHeader';
import { useTrackRecent } from '../recent';

export default function ParsersPage() {
  const { message } = App.useApp();
  const [list, setList] = useState<Parser[]>([]);
  const [eqs, setEqs] = useState<Equipment[]>([]);
  const [cur, setCur] = useState<Partial<Parser> | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [q, setQ] = useState('');
  const [sp, setSp] = useSearchParams();

  const load = () => api.get<Parser[]>('/api/parsers').then(setList);
  const loadEqs = () => api.get<Equipment[]>('/api/equipment').then(setEqs);
  useEffect(() => {
    load();
    loadEqs();
  }, []);

  const select = (p: Partial<Parser> | null) => {
    if (dirty && !confirm('You have unsaved changes. Discard them and leave?')) return false;
    setCur(p);
    setDirty(false);
    setEditorKey((k) => k + 1);
    return true;
  };

  useEffect(() => {
    const id = Number(sp.get('id'));
    const p = list.find((x) => x.id === id);
    if (p && eqs.length) {
      select(p);
      setSp({}, { replace: true });
    } else if (sp.get('new') === '1') {
      create();
      setSp({}, { replace: true });
    }
  }, [sp, list, eqs]);

  useTrackRecent(cur?.id ? { key: `parser:${cur.id}`, label: cur.name ?? '', path: `/capture/parsers?id=${cur.id}`, kind: 'parser' } : null);

  async function create(draft?: Partial<Parser>) {
    const code = draft?.code ?? (await api.get('/api/parsers/template')).code;
    select({ name: draft?.name ?? '', description: draft?.description ?? '', code });
  }

  const removeFromList = async (p: Parser) => {
    await api.del(`/api/parsers/${p.id}`);
    message.success(`Deleted parser [${p.name}].`);
    if (cur?.id === p.id) {
      setCur(null);
      setDirty(false);
    }
    load();
    loadEqs();
  };

  const shown = list.filter((p) => !q || `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <StageHeader
        stage="capture"
        hints={{ '/capture/parsers': <>{list.length}</> }}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => create()}>
            New parser
          </Button>
        }
      />
      <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', gap: 12, alignItems: 'start' }}>
        <div className="panel" style={{ padding: 8, position: 'sticky', top: 0 }}>
          <Input
            allowClear
            prefix={<SearchOutlined className="muted" />}
            placeholder="Search parsers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ marginBottom: 6, background: 'var(--tile)', border: 'none' }}
          />
          {cur && !cur.id && (
            <div className="list-item active">
              <div className="t">{cur.name || 'New parser'}</div>
              <div className="s" style={{ color: 'var(--orange)' }}>
                Draft · not saved yet
              </div>
            </div>
          )}
          {shown.map((p) => (
            <div key={p.id} className={`list-item parser-row ${cur?.id === p.id ? 'active' : ''}`} onClick={() => select(p)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{p.name}</div>
                  <div className="s">
                    {p.used_by ? <span style={{ color: 'var(--blue)' }}>Used by {p.used_by}</span> : 'Unused'} · {fmtTime(p.updated_at).slice(5, 16)}
                  </div>
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <Tooltip title="Duplicate">
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => create({ name: `${p.name} (copy)`, description: p.description, code: p.code })} />
                  </Tooltip>
                  <Popconfirm
                    title={`Delete parser [${p.name}]?`}
                    description={p.used_by ? `사용 중인 설비 ${p.used_by}대는 Parser 미지정 상태가 되어 수집이 멈춰요.` : '사용 중인 설비는 없어요.'}
                    okText="Delete"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => removeFromList(p)}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </div>
              </div>
            </div>
          ))}
          {!shown.length && !(cur && !cur.id) && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No parsers" />}
          <Button type="dashed" block icon={<PlusOutlined />} style={{ marginTop: 6 }} onClick={() => create()}>
            Add parser
          </Button>
        </div>
        {!cur ? (
          <div className="panel" style={{ padding: 48 }}>
            <Empty description="왼쪽에서 Parser를 선택하거나 새로 추가하세요">
              <Button type="primary" icon={<PlusOutlined />} onClick={() => create()}>
                New parser
              </Button>
            </Empty>
          </div>
        ) : (
          <ParserEditor
            key={editorKey}
            value={cur}
            equipment={eqs}
            onDirtyChange={setDirty}
            onSaved={(p) => {
              setCur(p);
              load();
            }}
            onDeleted={() => {
              setCur(null);
              setDirty(false);
              load();
              loadEqs();
            }}
            onDuplicate={(draft) => create(draft)}
          />
        )}
      </div>
    </div>
  );
}
