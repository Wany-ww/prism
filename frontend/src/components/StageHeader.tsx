import { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { STAGES, StageKey } from '../nav';

/** 토스증권 '전체 · 국내 · 해외' 형태의 큰 텍스트 탭 헤더 */
export default function StageHeader({ stage, hints, extra }: { stage: StageKey; hints?: Record<string, ReactNode>; extra?: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  const tabs = STAGES.find((s) => s.key === stage)!.tabs;
  return (
    <div className="stage-header">
      <div className="big-tabs">
        {tabs.map((t) => (
          <div key={t.path} className={`big-tab ${loc.pathname === t.path ? 'active' : ''}`} onClick={() => nav(t.path)}>
            {t.label}
            {hints?.[t.path] && <span className="hint">{hints[t.path]}</span>}
          </div>
        ))}
      </div>
      {extra && <div style={{ paddingBottom: 8, display: 'flex', gap: 8, alignItems: 'center' }}>{extra}</div>}
    </div>
  );
}
