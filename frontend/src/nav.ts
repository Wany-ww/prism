export type StageKey = 'home' | 'capture' | 'match' | 'analysis' | 'present';
export type StageTab = { label: string; path: string };
export type Stage = { key: StageKey; label: string; tabs: StageTab[] };

export const STAGES: Stage[] = [
  { key: 'home', label: '홈', tabs: [{ label: '홈', path: '/' }] },
  {
    key: 'capture',
    label: '수집',
    tabs: [
      { label: '설비', path: '/capture/equipment' },
      { label: 'Parser', path: '/capture/parsers' },
    ],
  },
  {
    key: 'match',
    label: '매칭',
    tabs: [
      { label: 'Match Flow', path: '/match' },
      { label: '제품 Trace', path: '/trace' },
    ],
  },
  {
    key: 'analysis',
    label: '분석',
    tabs: [
      { label: 'Analysis Flow', path: '/analysis' },
      { label: '노드 라이브러리', path: '/nodes' },
    ],
  },
  {
    key: 'present',
    label: '대시보드',
    tabs: [
      { label: '대시보드', path: '/dashboards' },
      { label: '데이터셋', path: '/datasets' },
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
