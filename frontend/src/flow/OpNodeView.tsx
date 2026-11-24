import { Handle, NodeProps, Position } from '@xyflow/react';
import { Spin } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, MinusCircleFilled } from '@ant-design/icons';
import { memo } from 'react';
import { inputHandles, kindName, nodeColor, OpNode, useFlowCtx } from './defs';

function summary(d: OpNode['data'], ctx: ReturnType<typeof useFlowCtx>): string[] {
  const p = d.params ?? {};
  switch (d.kind) {
    case 'source': {
      const names = (p.equipment_ids ?? []).map((id: number) => ctx.equipment.find((e) => e.id === id)?.name ?? `#${id}`);
      const out = [names.length ? names.join(', ') : '설비 미선택'];
      if (p.alias) out.push(`접두어: ${p.alias}.`);
      if (p.days) out.push(`최근 ${p.days}일`);
      return out;
    }
    case 'match': {
      const keys = (p.keys ?? []).filter((k: any) => k.left && k.right).map((k: any) => `${k.left} ↔ ${k.right}`);
      const strat: Record<string, string> = { exact: '정확히 일치', nearest_after: '이후 최근접 시각', nearest_before: '이전 최근접 시각', nearest: '최근접 시각' };
      const how: Record<string, string> = { inner: '양쪽 모두', left: '왼쪽 기준', outer: '전체' };
      return [...(keys.length ? keys : ['키 미지정']), `${strat[p.strategy ?? 'exact']} · ${how[p.how ?? 'inner']}`];
    }
    case 'dataset':
    case 'output':
      return [p.name ? `📦 ${p.name}` : '이름 미지정'];
    case 'python':
      return [`${(p.code ?? '').split('\n').length}줄 코드`];
    case 'custom': {
      const nt = ctx.nodeTypes[d.nodeType ?? ''];
      if (!nt) return [];
      return nt.params
        .filter((s) => p[s.name] !== undefined && p[s.name] !== '' && !(Array.isArray(p[s.name]) && !p[s.name].length))
        .slice(0, 3)
        .map((s) => {
          const v = p[s.name];
          const txt = Array.isArray(v) ? v.join(', ') : String(v);
          return `${s.label ?? s.name}: ${txt.length > 60 ? txt.slice(0, 60) + '…' : txt}`;
        });
    }
    default:
      return [];
  }
}

function OpNodeView({ id, data, selected }: NodeProps<OpNode>) {
  const ctx = useFlowCtx();
  const ins = inputHandles(data, ctx.nodeTypes);
  const st = ctx.status[id];
  const running = ctx.running[id];
  const color = nodeColor(data, ctx.nodeTypes);
  return (
    <div className={`op-node ${selected ? 'selected' : ''} ${data.disabled ? 'disabled' : ''}`} style={{ ['--c' as any]: color }}>
      {ins.map((h, i) => {
        const top = `${((i + 1) / (ins.length + 1)) * 100}%`;
        return (
          <div key={h.id}>
            <Handle type="target" position={Position.Left} id={h.id} style={{ top, background: color, width: 10, height: 10 }} />
            {h.label && (
              <span className="handle-label" style={{ top }}>
                {h.label}
              </span>
            )}
          </div>
        );
      })}
      <div className="op-head">
        <span>{data.label}</span>
        <span>
          {running ? (
            <Spin size="small" />
          ) : st?.status === 'ok' ? (
            <CheckCircleFilled style={{ color: 'var(--green)' }} />
          ) : st?.status === 'error' ? (
            <CloseCircleFilled style={{ color: 'var(--red)' }} />
          ) : st?.status === 'skipped' ? (
            <MinusCircleFilled style={{ color: 'var(--text-4)' }} />
          ) : null}
        </span>
      </div>
      <div className="op-kind" style={{ paddingLeft: ins.some((h) => h.label) ? 48 : 12 }}>
        <i />
        {kindName(data, ctx.nodeTypes)}
      </div>
      <div className="op-body" style={{ paddingLeft: ins.some((h) => h.label) ? 48 : 12 }}>
        {summary(data, ctx).map((s, i) => (
          <div key={i}>{s}</div>
        ))}
      </div>
      {st && (
        <div className="op-status" style={{ color: st.status === 'error' ? 'var(--red)' : 'var(--text-2)' }}>
          {st.status === 'error'
            ? (st.error ?? '').slice(0, 80)
            : st.status === 'skipped'
              ? '상위 노드 실패'
              : `${(st.rows ?? 0).toLocaleString()}행 × ${st.columns?.length ?? 0}열${st.ms !== undefined ? ` · ${st.ms}ms` : ''}`}
        </div>
      )}
      {data.kind !== 'output' && (
        <Handle type="source" position={Position.Right} id="out" style={{ background: color, width: 10, height: 10 }} />
      )}
    </div>
  );
}

export default memo(OpNodeView);
