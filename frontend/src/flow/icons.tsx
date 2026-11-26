import type { OpKind } from './defs';

export type IconKind = 'db' | 'venn' | 'code' | 'export' | 'share' | 'grid';

/** 노드 종류 → 배지에 쓸 아이콘. */
export function iconKindOf(kind: OpKind): IconKind {
  switch (kind) {
    case 'source':
    case 'dataset':
      return 'db';
    case 'match':
    case 'union':
      return 'venn';
    case 'python':
      return 'code';
    case 'output':
      return 'export';
    case 'cypher':
    case 'graph':
      return 'share';
    default:
      return 'grid';
  }
}

export function KindIcon({ kind }: { kind: IconKind }) {
  switch (kind) {
    case 'db':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx={12} cy={5.2} rx={7} ry={2.8} />
            <path d="M5 5.2v6.1c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V5.2" />
            <path d="M5 11.3v6.1c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8v-6.1" />
          </g>
        </svg>
      );
    case 'venn':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="none" stroke="#fff" strokeWidth={1.9}>
            <circle cx={9.2} cy={12} r={5.6} />
            <circle cx={14.8} cy={12} r={5.6} />
          </g>
        </svg>
      );
    case 'code':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 7.5 4 12l5 4.5" />
            <path d="M15 7.5 20 12l-5 4.5" />
          </g>
        </svg>
      );
    case 'export':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="none" stroke="#fff" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 14.5V4.5" />
            <path d="M8.2 8.2 12 4.5l3.8 3.7" />
            <path d="M4.5 14.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3" />
          </g>
        </svg>
      );
    case 'share':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="none" stroke="#fff" strokeWidth={1.7}>
            <path d="M7.6 16.3 10.4 7.9" />
            <path d="M16.4 16.3 13.6 7.9" />
            <path d="M8 17.6h8" />
          </g>
          <g fill="#fff">
            <circle cx={6.6} cy={18} r={2.1} />
            <circle cx={17.4} cy={18} r={2.1} />
            <circle cx={12} cy={6.2} r={2.1} />
          </g>
        </svg>
      );
    case 'grid':
      return (
        <svg viewBox="0 0 24 24" width={14} height={14}>
          <g fill="#fff">
            <rect x={4} y={4} width={7} height={7} rx={1.6} />
            <rect x={13} y={4} width={7} height={7} rx={1.6} />
            <rect x={4} y={13} width={7} height={7} rx={1.6} />
            <rect x={13} y={13} width={7} height={7} rx={1.6} />
          </g>
        </svg>
      );
  }
}

export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width={9} height={9}>
      <path d="M5 12.5 10 17 19 7" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width={9} height={9}>
      <g stroke="currentColor" strokeWidth={3} strokeLinecap="round">
        <path d="M6 6l12 12" />
        <path d="M18 6 6 18" />
      </g>
    </svg>
  );
}
