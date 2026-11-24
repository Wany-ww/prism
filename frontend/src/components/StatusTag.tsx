import { LoadingOutlined } from '@ant-design/icons';

const MAP: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'st-ok', label: 'OK' },
  warning: { cls: 'st-warning', label: 'Partial errors' },
  error: { cls: 'st-error', label: 'Error' },
  running: { cls: 'st-running', label: 'Capturing' },
  idle: { cls: 'st-idle', label: 'Idle' },
  disabled: { cls: 'st-idle', label: 'Stopped' },
  skipped: { cls: 'st-idle', label: 'Skipped' },
};

const COLOR: Record<string, string> = { 'st-ok': 'var(--green)', 'st-error': 'var(--red)', 'st-warning': 'var(--orange)', 'st-running': 'var(--blue)' };

export function statusMeta(status?: string, enabled = true) {
  const m = !enabled ? MAP.disabled : MAP[status || 'idle'] ?? { cls: 'st-idle', label: status || '-' };
  return { ...m, color: COLOR[m.cls] ?? 'var(--text-3)' };
}

export default function StatusTag({ status, enabled = true }: { status?: string; enabled?: boolean }) {
  const s = statusMeta(status, enabled);
  return (
    <span className={`st ${s.cls}`}>
      {status === 'running' && enabled ? <LoadingOutlined /> : <span className="dot" style={{ background: 'currentColor', width: 6, height: 6 }} />}
      {s.label}
    </span>
  );
}
