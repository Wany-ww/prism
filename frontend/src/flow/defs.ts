import { createContext, useContext } from 'react';
import type { Node } from '@xyflow/react';
import type { ColumnMeta, Dataset, Equipment, NodeRunStatus, NodeType } from '../api';

export type OpKind = 'source' | 'dataset' | 'match' | 'union' | 'python' | 'output' | 'custom' | 'graph' | 'cypher';

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
  { kind: 'source', name: 'Equipment data', color: '#3182f6', desc: '설비(들)의 수집 레코드. 여러 대 선택 시 합쳐짐', group: 'Input' },
  { kind: 'dataset', name: 'Dataset', color: '#3182f6', desc: '다른 Flow 의 출력 결과', group: 'Input' },
  { kind: 'match', name: 'Match', color: '#18a5a5', desc: '키 컬럼으로 두 입력을 같은 제품으로 연결', group: 'Match / Combine' },
  { kind: 'union', name: 'Union', color: '#18a5a5', desc: '여러 입력을 위아래로 이어붙임', group: 'Match / Combine' },
  { kind: 'python', name: 'Python script', color: '#a234c7', desc: '이 Flow 에서만 쓰는 즉석 코드', group: 'Code' },
  { kind: 'output', name: 'Output (save dataset)', color: '#f04452', desc: '결과를 이름 붙여 저장 → 대시보드/다른 Flow 에서 사용', group: 'Output' },
  { kind: 'cypher', name: 'Neo4j query (Cypher)', color: '#03b26c', desc: 'Neo4j 제품 계보 그래프를 Cypher 로 조회해 표로 받음 (읽기 전용)', group: 'Input' },
  { kind: 'graph', name: 'Neo4j graph write', color: '#03b26c', desc: 'Match 결과를 제품-공정-설비-자원 그래프로 저장 → 영향 범위 분석', group: 'Output' },
];

export const builtinDef = (k: OpKind) => BUILTINS.find((b) => b.kind === k);

export function inputHandles(d: OpData, nodeTypes: Record<string, NodeType>): InputHandle[] {
  switch (d.kind) {
    case 'source':
    case 'dataset':
      return [];
    case 'match':
      return [
        { id: 'left', label: 'Left (base)' },
        { id: 'right', label: 'Right' },
      ];
    case 'union':
      return [{ id: 'in', multi: true }];
    case 'output':
    case 'graph':
      return [{ id: 'in' }];
    case 'cypher':
      return [{ id: 'in0', label: '$rows' }];
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
  if (d.kind === 'custom') return nodeTypes[d.nodeType ?? '']?.name ?? `(missing node: ${d.nodeType})`;
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
