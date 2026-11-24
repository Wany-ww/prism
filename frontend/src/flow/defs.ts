import { createContext, useContext } from 'react';
import type { Node } from '@xyflow/react';
import type { ColumnMeta, Dataset, Equipment, NodeRunStatus, NodeType } from '../api';

export type OpKind = 'source' | 'dataset' | 'match' | 'union' | 'python' | 'output' | 'custom';

export type OpData = {
  kind: OpKind;
  label: string;
  params: Record<string, any>;
  nodeType?: string;
  disabled?: boolean;
};

export type OpNode = Node<OpData, 'op'>;

export type InputHandle = { id: string; label?: string; multi?: boolean };

export type BuiltinDef = { kind: OpKind; name: string; color: string; desc: string; group: string };

export const BUILTINS: BuiltinDef[] = [
  { kind: 'source', name: '설비 데이터', color: '#3182f6', desc: '설비(들)의 수집 레코드. 여러 대 선택 시 합쳐짐', group: '입력' },
  { kind: 'dataset', name: '데이터셋', color: '#3182f6', desc: '다른 Flow 의 출력 결과', group: '입력' },
  { kind: 'match', name: 'Match', color: '#18a5a5', desc: '키 컬럼으로 두 입력을 같은 제품으로 연결', group: '매칭/결합' },
  { kind: 'union', name: '합치기 (Union)', color: '#18a5a5', desc: '여러 입력을 위아래로 이어붙임', group: '매칭/결합' },
  { kind: 'python', name: 'Python 스크립트', color: '#a234c7', desc: '이 Flow 에서만 쓰는 즉석 코드', group: '코드' },
  { kind: 'output', name: '출력 (데이터셋 저장)', color: '#f04452', desc: '결과를 이름 붙여 저장 → 대시보드/다른 Flow 에서 사용', group: '출력' },
];

export const builtinDef = (k: OpKind) => BUILTINS.find((b) => b.kind === k);

export function inputHandles(d: OpData, nodeTypes: Record<string, NodeType>): InputHandle[] {
  switch (d.kind) {
    case 'source':
    case 'dataset':
      return [];
    case 'match':
      return [
        { id: 'left', label: '왼쪽(기준)' },
        { id: 'right', label: '오른쪽' },
      ];
    case 'union':
      return [{ id: 'in', multi: true }];
    case 'output':
      return [{ id: 'in' }];
    case 'python': {
      const n = Math.max(0, Number(d.params?.inputs ?? 1));
      return Array.from({ length: n }, (_, i) => ({ id: `in${i}`, label: n > 1 ? `#${i}` : undefined }));
    }
    case 'custom': {
      const n = nodeTypes[d.nodeType ?? '']?.inputs ?? 1;
      return Array.from({ length: n }, (_, i) => ({ id: `in${i}`, label: n > 1 ? `#${i}` : undefined }));
    }
  }
}

export function nodeColor(d: OpData, nodeTypes: Record<string, NodeType>) {
  if (d.kind === 'custom') return nodeTypes[d.nodeType ?? '']?.color ?? '#a234c7';
  return builtinDef(d.kind)?.color ?? '#888';
}

export function kindName(d: OpData, nodeTypes: Record<string, NodeType>) {
  if (d.kind === 'custom') return nodeTypes[d.nodeType ?? '']?.name ?? `(없는 노드: ${d.nodeType})`;
  return builtinDef(d.kind)?.name ?? d.kind;
}

export type FlowCtx = {
  nodeTypes: Record<string, NodeType>;
  equipment: Equipment[];
  datasets: Dataset[];
  status: Record<string, NodeRunStatus>;
  running: Record<string, boolean>;
};

export const FlowContext = createContext<FlowCtx>({ nodeTypes: {}, equipment: [], datasets: [], status: {}, running: {} });
export const useFlowCtx = () => useContext(FlowContext);

export function columnsOf(status: NodeRunStatus | undefined): ColumnMeta[] {
  return status?.columns ?? [];
}
