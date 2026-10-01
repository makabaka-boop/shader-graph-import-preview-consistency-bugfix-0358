import { useRef } from 'react';
import {
  DataType,
  GraphNode,
  NODE_DEFS,
  PortRef,
} from '../graph/types';

export interface DragConnection {
  from: PortRef;
  mouse: { x: number; y: number };
}

interface NodeCardProps {
  node: GraphNode;
  selected: boolean;
  reachable: boolean;
  orderIndex: number;
  resolvedTypes: Map<string, DataType>;
  onPointerDownNode: (e: React.PointerEvent, node: GraphNode) => void;
  onStartConnect: (from: PortRef, e: React.PointerEvent) => void;
  onEndConnect: (to: PortRef) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string) => void;
}

const TYPE_COLORS: Record<string, string> = {
  float: '#e0a458',
  vec3: '#58a4e0',
  'any-number': '#9b7ed6',
};

export function NodeCard({
  node,
  selected,
  reachable,
  orderIndex,
  resolvedTypes,
  onPointerDownNode,
  onStartConnect,
  onEndConnect,
  onDelete,
  onSelect,
}: NodeCardProps) {
  const def = NODE_DEFS[node.kind];
  const ref = useRef<HTMLDivElement>(null);

  const portType = (portId: string, base: DataType): DataType =>
    base === 'any-number' ? resolvedTypes.get(`${node.id}:${portId}`) ?? 'any-number' : base;

  return (
    <div
      ref={ref}
      className={`node-card node-${node.kind} ${selected ? 'selected' : ''} ${
        reachable ? 'reachable' : 'disconnected'
      }`}
      style={{ left: node.x, top: node.y }}
      onPointerDown={(e) => {
        onSelect(node.id);
        onPointerDownNode(e, node);
      }}
    >
      <div className="node-header">
        <span className="node-title">{def.label}</span>
        <button
          className="node-close"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onDelete(node.id)}
          title="删除节点"
        >
          ×
        </button>
      </div>
      {reachable && orderIndex >= 0 && (
        <span className="order-badge" title="生成顺序（拓扑序）">
          #{orderIndex}
        </span>
      )}
      {!reachable && <span className="muted-badge" title="不在颜色输出的可达子图中，不影响输出">断开</span>}

      <div className="node-body">
        {def.inputs.map((p) => (
          <div className="port-row" key={p.id}>
            <span
              className={`port port-input type-${portType(p.id, p.type)}`}
              onPointerUp={(e) => {
                e.stopPropagation();
                onEndConnect({ node: node.id, port: p.id });
              }}
              title={`输入: ${p.label} (${portType(p.id, p.type)})`}
            />
            <span className="port-label">{p.label}</span>
            <span className="port-type" style={{ color: TYPE_COLORS[portType(p.id, p.type)] }}>
              {portType(p.id, p.type)}
            </span>
          </div>
        ))}
        {def.outputs.map((p) => (
          <div className="port-row output" key={p.id}>
            <span className="port-type" style={{ color: TYPE_COLORS[portType(p.id, p.type)] }}>
              {portType(p.id, p.type)}
            </span>
            <span className="port-label">{p.label}</span>
            <span
              className={`port port-output type-${portType(p.id, p.type)}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                onStartConnect({ node: node.id, port: p.id }, e);
              }}
              title={`输出: ${p.label} (${portType(p.id, p.type)})`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
