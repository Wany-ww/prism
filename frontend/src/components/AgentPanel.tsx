import { Alert, Button, Input, Spin, Tooltip, Typography } from 'antd';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  CloudDownloadOutlined,
  DashboardOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  PoweroffOutlined,
  ReloadOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AiAgent, AiEvent, AiJob, api, fmtTime } from '../api';

const EXAMPLES = [
  '구동 검사기와 EOL 설비 데이터를 VAID 로 매칭해서 F14 Area 와 F1440 Area 의 관계를 대시보드로 보여줘',
  'Blade 조립기의 base pin 위치가 F14 Area 에 주는 영향을 설비별로 분석해줘',
  '공정별 시간대 생산량 추이 대시보드를 만들어줘',
];

const STATUS: Record<AiJob['status'], { label: string; cls: string }> = {
  queued: { label: 'Queued', cls: 'st-idle' },
  running: { label: 'Working', cls: 'st-running' },
  done: { label: 'Done', cls: 'st-ok' },
  error: { label: 'Failed', cls: 'st-error' },
  cancelled: { label: 'Cancelled', cls: 'st-idle' },
};

/** 다운로드 → 실행 → 실행 확인: 에이전트 한 개의 준비 단계 */
function AgentCard({ a, selected, onSelect, onChange }: { a: AiAgent; selected: boolean; onSelect: () => void; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (step: string, fn: () => Promise<any>, okText?: (r: any) => string) => {
    setBusy(step);
    setMsg(null);
    try {
      const r = await fn();
      if (okText) setMsg({ ok: true, text: okText(r) });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(null);
      onChange();
    }
  };
  const steps = [
    { key: 'download', label: 'Download', done: a.installed },
    { key: 'start', label: 'Start', done: a.started },
    { key: 'check', label: 'Check', done: a.started && a.installed },
  ];
  const state = !a.installed ? (a.available ? 'Not installed' : 'Coming soon') : a.started ? 'Running' : 'Installed';
  return (
    <div className={`agent-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="agent-card-head">
        <span className="agent-ico" style={{ background: a.kind === 'local-cli' ? '#d97757' : 'var(--blue)' }}>
          <RobotOutlined />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 6 }}>
            {a.name}
            {a.temporary && <span className="st st-warning" style={{ padding: '0 6px', fontSize: 11 }}>Temporary</span>}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {a.vendor}
            {a.version ? ` · ${a.version}` : ''}
          </div>
        </div>
        <span className={`st ${a.started ? 'st-ok' : a.installed ? 'st-idle' : 'st-idle'}`}>{state}</span>
      </div>
      <div className="agent-steps">
        {steps.map((s, i) => (
          <div key={s.key} className={`agent-step ${s.done ? 'done' : ''}`}>
            <span className="agent-step-no">{s.done ? <CheckCircleFilled /> : i + 1}</span>
            {s.label}
          </div>
        ))}
      </div>
      <div className="agent-actions" onClick={(e) => e.stopPropagation()}>
        <Tooltip title={a.downloadable ? undefined : 'Uses the CLI already installed on this server'}>
          <Button
            size="small"
            icon={<CloudDownloadOutlined />}
            disabled={a.installed || !a.downloadable}
            loading={busy === 'download'}
            onClick={() => run('download', () => api.post(`/api/ai/agents/${a.id}/download`))}
          >
            Download
          </Button>
        </Tooltip>
        {a.started ? (
          <Button size="small" icon={<PoweroffOutlined />} loading={busy === 'start'} disabled={a.busy} onClick={() => run('start', () => api.post(`/api/ai/agents/${a.id}/stop`))}>
            Stop
          </Button>
        ) : (
          <Button size="small" type={a.installed ? 'primary' : 'default'} icon={<PlayCircleOutlined />} disabled={!a.installed} loading={busy === 'start'} onClick={() => run('start', () => api.post(`/api/ai/agents/${a.id}/start`), () => 'Started')}>
            Start
          </Button>
        )}
        <Button
          size="small"
          icon={<ReloadOutlined />}
          disabled={!a.installed}
          loading={busy === 'check'}
          onClick={() => run('check', () => api.get(`/api/ai/agents/${a.id}/check`), (r) => (r.ok ? `Ready · ${r.version}` : r.message))}
        >
          Check
        </Button>
      </div>
      {(msg || (a.error && !a.installed && a.available)) && (
        <div className={`agent-msg ${msg?.ok ? 'ok' : 'bad'}`}>{msg ? msg.text : a.error}</div>
      )}
    </div>
  );
}

function EventLine({ e }: { e: AiEvent }) {
  if (e.kind === 'text') return <div className="agent-ev text">{e.text}</div>;
  if (e.kind === 'created')
    return (
      <div className="agent-ev created">
        <CheckCircleFilled /> {e.text}
      </div>
    );
  if (e.kind === 'error')
    return (
      <div className="agent-ev error">
        <CloseCircleFilled /> {e.text}
      </div>
    );
  return <div className={`agent-ev ${e.kind}`}>{e.text}</div>;
}

export default function AgentPanel() {
  const nav = useNavigate();
  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [agentId, setAgentId] = useState('claude-code');
  const [prompt, setPrompt] = useState('');
  const [jobs, setJobs] = useState<AiJob[]>([]);
  const [job, setJob] = useState<AiJob | null>(null);
  const [events, setEvents] = useState<AiEvent[]>([]);
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const seen = useRef(0);

  const loadAgents = () => api.get<AiAgent[]>('/api/ai/agents').then(setAgents).catch((e) => setErr(e.message));
  const loadJobs = () =>
    api.get<AiJob[]>('/api/ai/jobs?limit=15').then((l) => {
      setJobs(l);
      return l;
    });

  const open = async (id: number) => {
    seen.current = 0;
    const j = await api.get<AiJob>(`/api/ai/jobs/${id}?since=0`);
    seen.current = j.event_count ?? 0;
    setEvents(j.events ?? []);
    setJob(j);
  };

  useEffect(() => {
    loadAgents();
    // 패널을 다시 열었을 때 진행 중인 요청이 있으면 이어서 보여줌
    loadJobs().then((l) => {
      const live = l.find((j) => j.status === 'running' || j.status === 'queued');
      if (live) open(live.id);
    });
  }, []);

  // 진행 중인 요청은 1.5초마다 새 기록만 이어 받음
  useEffect(() => {
    if (!job || (job.status !== 'running' && job.status !== 'queued')) return;
    const t = setInterval(async () => {
      try {
        const j = await api.get<AiJob>(`/api/ai/jobs/${job.id}?since=${seen.current}`);
        seen.current = j.event_count ?? seen.current;
        if (j.events?.length) setEvents((cur) => [...cur, ...j.events!]);
        if (j.status !== job.status) {
          setJob(j);
          loadJobs();
          loadAgents();
        }
      } catch {
        /* 다음 주기에 다시 */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const agent = agents.find((a) => a.id === agentId);
  const running = jobs.some((j) => j.status === 'running' || j.status === 'queued');
  const canSend = !!agent?.started && !running && !!prompt.trim() && !sending;

  const send = async () => {
    setErr('');
    setSending(true);
    try {
      const j = await api.post<AiJob>('/api/ai/jobs', { prompt, agent: agentId });
      seen.current = j.event_count ?? 0;
      setEvents(j.events ?? []);
      setJob(j);
      setPrompt('');
      loadJobs();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };

  const made = useMemo(() => [...(job?.result?.flows ?? []).map((f) => ({ ...f, what: 'flow' as const })), ...(job?.result?.dashboards ?? []).map((d) => ({ ...d, what: 'dashboard' as const }))], [job]);
  const live = job && (job.status === 'running' || job.status === 'queued');

  return (
    <div className="agent-panel">
      <div className="agent-sec-title">Agent</div>
      {agents.length === 0 && !err && <Spin size="small" style={{ margin: 12 }} />}
      {agents.map((a) => (
        <AgentCard key={a.id} a={a} selected={a.id === agentId} onSelect={() => setAgentId(a.id)} onChange={loadAgents} />
      ))}

      <div className="agent-sec-title" style={{ marginTop: 14 }}>
        Request
      </div>
      <Input.TextArea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        autoSize={{ minRows: 3, maxRows: 8 }}
        placeholder="무엇을 분석할지 적어 주세요. 매칭 Flow → 분석 Flow → 대시보드까지 만들어 드립니다."
        disabled={!agent?.started}
        onPressEnter={(e) => {
          if ((e.ctrlKey || e.metaKey) && canSend) send();
        }}
      />
      {!prompt && agent?.started && !running && (
        <div className="agent-examples">
          {EXAMPLES.map((x) => (
            <span key={x} className="agent-chip" onClick={() => setPrompt(x)}>
              {x}
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, gap: 8 }}>
        <span className="muted" style={{ fontSize: 12 }}>
          {!agent?.started ? `Start ${agent?.name ?? 'an agent'} to send a request` : running ? 'Working on a request…' : 'Ctrl+Enter to send'}
        </span>
        <Button type="primary" icon={<SendOutlined />} disabled={!canSend} loading={sending} onClick={send}>
          Generate
        </Button>
      </div>
      {err && <Alert type="error" showIcon message={err} style={{ marginTop: 10 }} />}

      {job && (
        <div className="agent-job">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span className={`st ${STATUS[job.status].cls}`}>
              {live && <LoadingOutlined />}
              {STATUS[job.status].label}
            </span>
            <span className="muted num" style={{ fontSize: 12, flex: 1 }}>
              #{job.id} · {fmtTime(job.started_at)}
            </span>
            {live && (
              <Button size="small" danger icon={<StopOutlined />} onClick={() => api.post(`/api/ai/jobs/${job.id}/cancel`).catch((e) => setErr(e.message))}>
                Cancel
              </Button>
            )}
          </div>
          <div className="agent-prompt">{job.prompt}</div>
          <div className="agent-log" ref={logRef}>
            {events.map((e, i) => (
              <EventLine key={i} e={e} />
            ))}
            {live && (
              <div className="agent-ev info">
                <LoadingOutlined /> working…
              </div>
            )}
          </div>
          {made.length > 0 && (
            <div className="agent-made">
              {made.map((m) => (
                <div key={`${m.what}${m.id}`} className="side-item" onClick={() => nav(m.what === 'flow' ? `/${m.kind}/${m.id}` : `/dashboards/${m.id}`)}>
                  <span className="avatar" style={{ background: m.what === 'dashboard' ? '#3182f6' : m.kind === 'match' ? '#18a5a5' : '#a234c7' }}>
                    {m.what === 'dashboard' ? <DashboardOutlined /> : m.kind === 'match' ? 'M' : 'A'}
                  </span>
                  <div className="name">
                    {m.name}
                    <div className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                      {m.what === 'dashboard' ? 'Dashboard' : m.kind === 'match' ? 'Match Flow' : 'Analysis Flow'} · {m.action}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* 마지막 응답이 이미 기록에 보이면 같은 내용을 한 번 더 보여주지 않음 */}
          {job.result?.summary && !live && [...events].reverse().find((e) => e.kind === 'text')?.text !== job.result.summary.slice(0, 4000) && (
            <Typography.Paragraph className="agent-summary">{job.result.summary}</Typography.Paragraph>
          )}
          {job.status === 'error' && job.error && <Alert type="error" message={job.error} style={{ marginTop: 8, whiteSpace: 'pre-wrap' }} />}
        </div>
      )}

      {jobs.length > 0 && (
        <>
          <div className="agent-sec-title" style={{ marginTop: 14 }}>
            History
          </div>
          {jobs.map((j) => (
            <div key={j.id} className={`agent-hist ${job?.id === j.id ? 'active' : ''}`} onClick={() => open(j.id)}>
              <span className={`st ${STATUS[j.status].cls}`} style={{ padding: '0 6px', fontSize: 11 }}>
                {STATUS[j.status].label}
              </span>
              <span className="ellipsis" style={{ flex: 1, minWidth: 0 }}>
                {j.prompt}
              </span>
              <span className="muted num" style={{ fontSize: 11 }}>
                {fmtTime(j.started_at)}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
