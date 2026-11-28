import { Alert, Button, Checkbox, Radio, Switch, Table, Tag, Typography, Upload } from 'antd';
import { CloudDownloadOutlined, CloudUploadOutlined, FileZipOutlined, FolderOpenOutlined, SaveOutlined, WarningFilled } from '@ant-design/icons';
import { useEffect, useRef, useState } from 'react';
import { api, ImportReport } from '../api';

const PARTS = [
  { key: 'parsers', label: 'Parsers' },
  { key: 'node_types', label: 'Node library' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'flows', label: 'Match · Analysis flows' },
  { key: 'dashboards', label: 'Dashboards' },
] as const;

const TYPE_LABEL: Record<string, string> = {
  parser: 'Parser',
  node_type: 'Node',
  equipment: 'Equipment',
  match_flow: 'Match flow',
  analysis_flow: 'Analysis flow',
  dashboard: 'Dashboard',
};
const ACTION: Record<string, { color: string; label: string }> = {
  create: { color: 'green', label: 'New' },
  overwrite: { color: 'orange', label: 'Overwrite' },
  skip: { color: 'default', label: 'Skip (exists)' },
};

type Manifest = { exported_at: string; includes_secrets: boolean; counts: Record<string, number> };
type FolderInfo = { path: string; manifest: Manifest | null };
type Summary = Record<(typeof PARTS)[number]['key'], number> & { equipment_with_password: number; folder: FolderInfo };
type Uploaded = { token: string; manifest: Manifest; label: string };

const when = (s?: string) => String(s ?? '').replace('T', ' ');
const countsText = (c?: Record<string, number>) => (c ? PARTS.map((p) => `${p.label} ${c[p.key] ?? 0}`).join(' · ') : '');

// 설정 폴더 구조 (화면 설명용)
const TREE = `settings\\
  prism-settings.json        목록 (내보낸 시각, 항목 수)
  parsers\\<이름>.json, .py    Parser 설명 + 코드
  node-library\\<key>.json, .py
  equipment\\<설비명>.json     Parser 는 이름으로 참조
  flows\\match\\<이름>.json     설비는 이름으로 참조
  flows\\analysis\\<이름>.json
  dashboards\\<이름>.json
  secrets\\equipment-passwords.json   (비밀번호 포함을 선택했을 때만)`;

export default function SettingsPage() {
  const [sum, setSum] = useState<Summary | null>(null);
  const [secrets, setSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState<'folder' | 'upload'>('folder');
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const [uploading, setUploading] = useState(false);
  const [overwrite, setOverwrite] = useState(false);
  const [activate, setActivate] = useState(false);
  const [parts, setParts] = useState<string[]>(PARTS.map((p) => p.key));
  const [plan, setPlan] = useState<ImportReport | null>(null);
  const [done, setDone] = useState<ImportReport | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const dirInput = useRef<HTMLInputElement>(null);

  const loadSummary = () => api.get<Summary>('/api/workspace/summary').then(setSum);
  useEffect(() => {
    loadSummary();
  }, []);
  // 폴더 선택 창은 비표준 속성이라 직접 붙임
  useEffect(() => {
    dirInput.current?.setAttribute('webkitdirectory', '');
    dirInput.current?.setAttribute('directory', '');
  }, []);

  const folderManifest = sum?.folder.manifest ?? null;
  const ready = source === 'folder' ? !!folderManifest : !!uploaded;
  const importBody = (dry_run: boolean) => ({ source, token: uploaded?.token ?? '', overwrite, activate, parts, dry_run });

  // 가져올 곳·옵션이 바뀌면 무엇이 바뀔지 다시 계산 (저장하지 않음)
  useEffect(() => {
    setPlan(null);
    if (!ready) return;
    setDone(null);
    api
      .post<ImportReport>('/api/workspace/import', importBody(true))
      .then((r) => {
        setPlan(r);
        setErr('');
      })
      .catch((e) => setErr(e.message));
  }, [ready, source, uploaded?.token, folderManifest?.exported_at, overwrite, activate, parts.join(',')]);

  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await api.post('/api/workspace/save', { secrets });
      setSaved(true);
      await loadSummary();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const sendFiles = async (files: File[], label: string) => {
    if (!files.length) return;
    setUploading(true);
    setErr('');
    setDone(null);
    try {
      const fd = new FormData();
      // 폴더로 고른 파일은 하위 폴더 경로를 파일 이름으로 함께 보냄
      for (const f of files) fd.append('files', f, (f as any).webkitRelativePath || f.name);
      const r = await api.post<{ token: string; manifest: Manifest }>('/api/workspace/upload', fd);
      setUploaded({ ...r, label });
      setSource('upload');
    } catch (e: any) {
      setUploaded(null);
      setErr(e.message);
    } finally {
      setUploading(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.post<ImportReport>('/api/workspace/import', importBody(false));
      setDone(r);
      setPlan(null);
      if (source === 'upload') setUploaded(null);
      loadSummary();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const report = done ?? plan;
  const changes = report ? report.items.filter((i) => i.action !== 'skip').length : 0;
  // 경고 → 새로 추가 → 덮어쓰기 → 건너뜀 순으로 (확인할 것이 위로)
  const order = { create: 1, overwrite: 2, skip: 3 } as const;
  const rows = report ? [...report.items].sort((a, b) => Number(!a.warnings.length) - Number(!b.warnings.length) || order[a.action] - order[b.action]) : [];

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="stage-header" style={{ marginBottom: 8 }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0 }}>Settings</h1>
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 16 }}>
        Move to another server
        <small>설정을 폴더 하나로 정리해 두고, 새 서버에서 들여옵니다</small>
      </div>
      <Typography.Paragraph type="secondary" style={{ maxWidth: 780, fontSize: 13 }}>
        설비·Parser·노드 라이브러리·Match/Analysis Flow·대시보드를 <b>설정 폴더</b>에 항목별 하위 폴더와 파일로 저장합니다. 서버마다 달라지는 id 대신 <b>이름</b>으로 서로를
        가리키므로 새 서버에서 같은 이름으로 다시 연결됩니다. 이 폴더를 새 서버 설치 폴더의 <code>settings\</code> 에 복사하고 <code>install.bat</code> 을 실행하면
        자동으로 들여옵니다. 수집된 레코드와 데이터셋은 데이터라서 넣지 않습니다 — Flow 를 한 번 실행하면 데이터셋이 다시 만들어집니다.
      </Typography.Paragraph>

      <div className="settings-grid">
        <div className="tile">
          <div className="settings-head">
            <SaveOutlined /> Save from this server
          </div>
          <div className="settings-counts">
            {PARTS.map((p) => (
              <div key={p.key}>
                <b className="num">{sum ? sum[p.key] : '–'}</b>
                <span>{p.label}</span>
              </div>
            ))}
          </div>
          <Checkbox checked={secrets} onChange={(e) => setSecrets(e.target.checked)} disabled={!sum?.equipment_with_password}>
            Include FTP/SFTP passwords{sum ? ` (${sum.equipment_with_password} equipment)` : ''}
          </Checkbox>
          {secrets && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              message="Passwords go to secrets\equipment-passwords.json in plain text. Delete that file after moving."
            />
          )}
          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={save}>
              Save to settings folder
            </Button>
            <Button icon={<CloudDownloadOutlined />} href={`/api/workspace/export.zip${secrets ? '?secrets=true' : ''}`}>
              Download as zip
            </Button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
            <code>{sum?.folder.path ?? 'settings'}</code>
            <br />
            {folderManifest ? (
              <>
                {saved ? 'Saved' : 'Last saved'} {when(folderManifest.exported_at)} · {countsText(folderManifest.counts)}
                {folderManifest.includes_secrets ? ' · with passwords' : ''}
              </>
            ) : (
              'Not saved yet'
            )}
          </div>
        </div>

        <div className="tile">
          <div className="settings-head">
            <CloudUploadOutlined /> Import into this server
          </div>
          <Radio.Group value={source} onChange={(e) => setSource(e.target.value)} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Radio value="folder" disabled={!folderManifest}>
              This server&apos;s settings folder
              <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                {folderManifest ? `exported ${when(folderManifest.exported_at)}` : '(empty — copy a settings folder here first)'}
              </span>
            </Radio>
            <Radio value="upload" disabled={!uploaded}>
              Uploaded
              <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                {uploaded ? `${uploaded.label} · exported ${when(uploaded.manifest.exported_at)}${uploaded.manifest.includes_secrets ? ' · with passwords' : ''}` : ''}
              </span>
            </Radio>
          </Radio.Group>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <input
              ref={dirInput}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                const top = ((files[0] as any)?.webkitRelativePath || '').split('/')[0];
                sendFiles(files, top ? `folder ${top}` : 'folder');
                e.target.value = '';
              }}
            />
            <Button icon={<FolderOpenOutlined />} loading={uploading} onClick={() => dirInput.current?.click()}>
              Upload folder
            </Button>
            <Upload accept=".zip,application/zip" showUploadList={false} beforeUpload={(f) => (sendFiles([f], f.name), false)}>
              <Button icon={<FileZipOutlined />} loading={uploading}>
                Upload zip
              </Button>
            </Upload>
          </div>
          <div className="settings-opts">
            <div>
              <div className="settings-opt-label">Items to import</div>
              <Checkbox.Group value={parts} onChange={(v) => setParts(v as string[])} options={PARTS.map((p) => ({ value: p.key, label: p.label }))} />
            </div>
            <div>
              <div className="settings-opt-label">When the same name already exists</div>
              <Radio.Group
                optionType="button"
                size="small"
                value={overwrite}
                onChange={(e) => setOverwrite(e.target.value)}
                options={[
                  { value: false, label: 'Keep this server’s' },
                  { value: true, label: 'Overwrite' },
                ]}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <Switch size="small" checked={activate} onChange={setActivate} style={{ marginTop: 2 }} />
              <div style={{ fontSize: 13 }}>
                Start capture and flow schedules right away
                <div className="muted" style={{ fontSize: 12 }}>
                  끄면 설비는 수집 꺼짐, Flow 는 자동 실행 꺼짐으로 들여옵니다. 새 서버에서 경로·계정을 확인한 뒤 켜는 것을 권장합니다.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {err && <Alert type="error" showIcon message={err} style={{ marginTop: 16 }} />}

      {report && (
        <div className="tile" style={{ marginTop: 16, background: 'var(--panel)', border: '1px solid var(--line-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {done ? 'Imported' : 'What will change'}
              <span className="muted" style={{ fontWeight: 400, fontSize: 13, marginLeft: 10 }}>
                {Object.entries(report.summary)
                  .map(([k, v]) => `${ACTION[k]?.label ?? k} ${v}`)
                  .join(' · ')}
              </span>
            </div>
            {!done && (
              <Button type="primary" icon={<CloudUploadOutlined />} disabled={!changes} loading={busy} onClick={apply}>
                Import {changes} item{changes === 1 ? '' : 's'}
              </Button>
            )}
          </div>
          {report.notes.map((n) => (
            <Alert key={n} type="info" showIcon message={n} style={{ marginBottom: 8 }} />
          ))}
          <Table
            size="small"
            rowKey={(r) => `${r.type}:${r.name}`}
            dataSource={rows}
            pagination={report.items.length > 15 ? { pageSize: 15, size: 'small' } : false}
            columns={[
              { title: 'Type', dataIndex: 'type', width: 140, render: (t) => <span className="muted">{TYPE_LABEL[t] ?? t}</span> },
              { title: 'Name', dataIndex: 'name', render: (v) => <b>{v}</b> },
              { title: '', dataIndex: 'action', width: 130, render: (a) => <Tag color={ACTION[a].color}>{ACTION[a].label}</Tag> },
              {
                title: '',
                dataIndex: 'warnings',
                render: (w: string[]) =>
                  w.length ? (
                    <span style={{ color: 'var(--orange)', fontSize: 12 }}>
                      <WarningFilled /> {w.join(' ')}
                    </span>
                  ) : null,
              },
            ]}
          />
        </div>
      )}

      <div className="section-title">
        Settings folder layout
        <small>파일을 직접 열어 확인하거나 버전 관리(git 등)로 변경 이력을 남길 수 있습니다</small>
      </div>
      <pre className="settings-code">{TREE}</pre>

      <div className="section-title">
        Command line
        <small>화면 없이 서버에서 직접 옮길 때 (PRISM 설치 폴더에서)</small>
      </div>
      <pre className="settings-code">{`cd backend
..\\.runtime\\python\\python.exe -m app.workspace export            # settings\\ 에 저장  (--secrets 비밀번호 포함, --zip 파일.zip)
..\\.runtime\\python\\python.exe -m app.workspace import --dry-run  # settings\\ 를 들여오면 무엇이 바뀌는지만 확인
..\\.runtime\\python\\python.exe -m app.workspace import            # 들여오기  (--overwrite --activate, 다른 폴더나 zip 경로도 가능)`}</pre>
    </div>
  );
}
