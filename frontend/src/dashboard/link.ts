import type { ColumnMeta, FramePayload } from '../api';

/** 대시보드 선택 상태: 테이블에서 클릭한 행의 값 */
export type Selection = { column: string; values: string[]; source: string; dataset: string };

/** 위젯이 선택에 반응하는 방식 */
export type LinkCfg = {
  mode?: 'auto' | 'off' | 'column';
  column?: string;
  behavior?: 'filter' | 'highlight';
};

/** 위젯에 겹쳐 그릴 추가 데이터셋. map: 위젯 기준 컬럼명 → 이 데이터셋의 컬럼명 */
export type Layer = { dataset: string; label?: string; map?: Record<string, string> };

export const DS_COL = '_dataset';
export const SEL_COL = '__sel';

/** 대시보드 파라미터 (컨트롤 위젯이 바꾸는 값): 파라미터 id → 현재 선택된 컬럼명 */
export type Params = Record<string, string>;
const PARAM_PREFIX = '$';
/** 차트/표 설정에 넣는 토큰 형태, 예) paramToken('metric') === '$metric' */
export const paramToken = (id: string) => PARAM_PREFIX + id;
/** 값이 `$id` 형태의 파라미터 토큰이면 id 를, 아니면(일반 컬럼명이면) null 을 반환 */
export function paramIdOf(v: string | undefined): string | null {
  return v && v.startsWith(PARAM_PREFIX) && v.length > 1 ? v.slice(1) : null;
}
/** 파라미터 토큰을 현재 값(실제 컬럼명)으로 바꿈. 파라미터가 아니면 그대로, 아직 값이 없으면 undefined */
export function resolveParam(v: string | undefined, params: Params): string | undefined {
  const id = paramIdOf(v);
  return id === null ? v : params[id] || undefined;
}

/** 서버(_norm_keys)와 같은 규칙: 앞뒤 공백 제거, 1.0 → 1 */
export function normKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim().replace(/^(-?\d+)\.0+$/, '$1');
}

const baseName = (c: string) => c.slice(c.lastIndexOf('.') + 1);

/**
 * 선택 컬럼(sel.column)에 대응하는 이 데이터셋의 컬럼.
 * auto: 같은 이름 → 접두어(blade./drive. 등)를 뗀 이름이 같은 컬럼 중 첫 번째
 *       (매칭 결과의 drive.VAID / eol.VAID 처럼 같은 값이 여러 공정에 있으면 앞 공정 기준).
 */
export function resolveLinkColumn(sel: Selection | null, link: LinkCfg | undefined, cols: string[], map?: Record<string, string>): string | null {
  if (!sel) return null;
  const mode = link?.mode ?? 'auto';
  if (mode === 'off') return null;
  if (mode === 'column') {
    const c = link?.column ? map?.[link.column] || link.column : '';
    return c && cols.includes(c) ? c : null;
  }
  if (cols.includes(sel.column)) return sel.column;
  const want = baseName(sel.column);
  return cols.find((c) => baseName(c) === want) ?? null;
}

/** 여러 데이터셋 결과를 컬럼명 기준으로 이어 붙임 (없는 컬럼은 null) */
export function mergeFrames(parts: { label: string; data: FramePayload }[], withLabel: boolean): FramePayload {
  const columns: ColumnMeta[] = withLabel ? [{ name: DS_COL, dtype: 'string' }] : [];
  const pos = new Map<string, number>(columns.map((c, i) => [c.name, i]));
  for (const p of parts)
    for (const c of p.data.columns)
      if (!pos.has(c.name)) {
        pos.set(c.name, columns.length);
        columns.push(c);
      }
  const rows: unknown[][] = [];
  let total = 0;
  for (const p of parts) {
    total += p.data.row_count;
    const idx = p.data.columns.map((c) => pos.get(c.name)!);
    for (const r of p.data.rows) {
      const o = new Array(columns.length).fill(null);
      if (withLabel) o[0] = p.label;
      r.forEach((v, i) => (o[idx[i]] = v));
      rows.push(o);
    }
  }
  return { columns, rows, row_count: total };
}

/** 데이터셋 하나의 컬럼명을 위젯 기준 이름으로 되돌림 (map 의 역방향) */
export function renameColumns(d: FramePayload, map: Record<string, string> | undefined): FramePayload {
  if (!map) return d;
  const back = new Map(Object.entries(map).filter(([k, v]) => v && v !== k).map(([k, v]) => [v, k]));
  if (!back.size) return d;
  return { ...d, columns: d.columns.map((c) => ({ ...c, name: back.get(c.name) ?? c.name })) };
}

/** 표시용 라벨 중복 제거: 같은 데이터셋을 두 번 쓰면 "#2" */
export function layerLabels(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return k > 1 ? `${n} #${k}` : n;
  });
}
