import { LoadingOutlined } from '@ant-design/icons';

const MAP: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'st-ok', label: '정상' },
  warning: { cls: 'st-warning', label: '일부 오류' },
  error: { cls: 'st-error', label: '오류' },
  running: { cls: 'st-running', label: '수집 중' },
  idle: { cls: 'st-idle', label: '대기' },
  disabled: { cls: 'st-idle', label: '중지' },
  skipped: { cls: 'st-idle', label: '건너뜀' },
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
