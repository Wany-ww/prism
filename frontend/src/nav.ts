export type StageKey = 'home' | 'capture' | 'match' | 'analysis' | 'present';
export type StageTab = { label: string; path: string };
export type Stage = { key: StageKey; label: string; tabs: StageTab[] };

export const STAGES: Stage[] = [
  { key: 'home', label: 'Home', tabs: [{ label: 'Home', path: '/' }] },
  {
    key: 'capture',
    label: 'Capture',
    tabs: [
      { label: 'Equipment', path: '/capture/equipment' },
      { label: 'Parser', path: '/capture/parsers' },
    ],
  },
  {
    key: 'match',
    label: 'Match',
    tabs: [
      { label: 'Match Flow', path: '/match' },
      { label: 'Product Trace', path: '/trace' },
    ],
  },
  {
    key: 'analysis',
    label: 'Analysis',
    tabs: [
      { label: 'Analysis Flow', path: '/analysis' },
      { label: 'Node Library', path: '/nodes' },
    ],
  },
  {
    key: 'present',
    label: 'Dashboard',
    tabs: [
      { label: 'Dashboards', path: '/dashboards' },
      { label: 'Datasets', path: '/datasets' },
    ],
  },
];

export function stageOf(path: string): Stage {
  if (path === '/') return STAGES[0];
  return STAGES.slice(1).find((s) => s.tabs.some((t) => path === t.path || path.startsWith(t.path + '/'))) ?? STAGES[0];
}

/** 회색 배경 + 흰 패널을 쓰는 작업형 화면 (토스 종목 상세 화면 톤) */
export function isWorkspace(path: string) {
  return /^\/(match|analysis|dashboards)\/\d+/.test(path) || path.startsWith('/capture/parsers') || path.startsWith('/nodes');
}

// 검증된 범주형 팔레트(토스 톤) — 아바타/공정 색 등에 동일 순서로 사용
export const ACCENTS = ['#3182f6', '#f04452', '#18a5a5', '#fe9800', '#a234c7', '#03b26c'];
export function accentOf(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
