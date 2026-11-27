import { Handle, NodeProps, Position } from '@xyflow/react';
import { MinusCircleFilled } from '@ant-design/icons';
import { memo } from 'react';
import { inputHandles, kindName, nodeColor, OpNode, useFlowCtx } from './defs';
import { CheckIcon, iconKindOf, KindIcon, XIcon } from './icons';

function summary(d: OpNode['data'], ctx: ReturnType<typeof useFlowCtx>): string[] {
  const p = d.params ?? {};
  switch (d.kind) {
    case 'source': {
      const names = (p.equipment_ids ?? []).map((id: number) => ctx.equipment.find((e) => e.id === id)?.name ?? `#${id}`);
      const out = [names.length ? names.map((n: string) => `[${n}]`).join(', ') : 'No equipment selected'];
      if (p.alias) out.push(`Prefix: ${p.alias}.`);
      if (p.days) out.push(`Last ${p.days} days`);
      return out;
    }
    case 'match': {
      const keys = (p.keys ?? []).filter((k: any) => k.left && k.right).map((k: any) => `${k.left} ↔ ${k.right}`);
      const strat: Record<string, string> = { exact: 'Exact match', nearest_after: 'Nearest after', nearest_before: 'Nearest before', nearest: 'Nearest time' };
      const how: Record<string, string> = { inner: 'Both sides', left: 'Keep left', outer: 'Keep all' };
      return [...(keys.length ? keys : ['No keys set']), `${strat[p.strategy ?? 'exact']} · ${how[p.how ?? 'inner']}`];
    }
    case 'dataset':
      return [p.name ? `📦 ${p.name}` : 'No name set', ...(p.columns?.length ? [`${p.columns.length} columns`] : [])];
    case 'output':
      return [p.name ? `📦 ${p.name}` : 'No name set', ...(p.mode === 'upsert' ? [`Upsert by ${(p.keys ?? []).join(', ') || '-'}`] : [])];
    case 'python':
      return [`${(p.code ?? '').split('\n').length} lines of code`];
    case 'graph':
      return [
        p.name ? `🕸 ${p.name}` : 'No graph name set',
        `Product key: ${p.product_key || '-'}`,
        ...(p.resources ? [`Shared resources: ${String(p.resources).split('\n').filter(Boolean).length}`] : []),
        ...(p.mode === 'upsert' ? ['Upsert products'] : []),
      ];
    case 'cypher': {
      const first = String(p.query ?? '').split('\n').find((l) => l.trim()) ?? '';
      return [first.length > 60 ? first.slice(0, 60) + '…' : first || 'No query'];
    }
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
  const bodyIndent = ins.some((h) => h.label) ? 48 : 14;
  return (
    <div className={`op-card ${selected ? 'selected' : ''} ${data.disabled ? 'disabled' : ''}`} style={{ ['--c' as any]: color }}>
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
      <div className="ohead">
        <div className="oicon">
          <KindIcon kind={iconKindOf(data.kind)} />
        </div>
        <div className="otitle">
          <b>{data.label}</b>
          <span>{kindName(data, ctx.nodeTypes)}</span>
        </div>
        {running ? (
          <span className="chip run">
            <i className="spin" />
            Running
          </span>
        ) : st?.status === 'ok' ? (
          <span className="chip ok">
            <CheckIcon />
            OK
          </span>
        ) : st?.status === 'error' ? (
          <span className="chip err">
            <XIcon />
            Error
          </span>
        ) : st?.status === 'skipped' ? (
          <MinusCircleFilled style={{ color: 'var(--text-4)' }} />
        ) : null}
      </div>
      <div className="obody" style={{ paddingLeft: bodyIndent }}>
        {summary(data, ctx).map((s, i) => (
          <div key={i}>{s}</div>
        ))}
      </div>
      {st && (
        <div className={`ofoot ${st.status === 'error' ? 'err' : ''}`}>
          {st.status === 'error'
            ? (st.error ?? '').slice(0, 80)
            : st.status === 'skipped'
              ? 'Upstream node failed'
              : `${(st.rows ?? 0).toLocaleString()} rows × ${st.columns?.length ?? 0} cols${st.ms !== undefined ? ` · ${st.ms}ms` : ''}`}
        </div>
      )}
      {data.kind !== 'output' && data.kind !== 'graph' && (
        <Handle type="source" position={Position.Right} id="out" style={{ background: color, width: 10, height: 10 }} />
      )}
    </div>
  );
}

export default memo(OpNodeView);
