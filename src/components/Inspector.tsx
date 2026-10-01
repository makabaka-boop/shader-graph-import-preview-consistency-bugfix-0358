import { Graph, GraphNode, NODE_DEFS } from '../graph/types';
import { GraphAction } from '../graph/reducer';

interface InspectorProps {
  graph: Graph;
  selectedId: string | null;
  dispatch: React.Dispatch<GraphAction>;
}

export function Inspector({ graph, selectedId, dispatch }: InspectorProps) {
  const node = selectedId ? graph.nodes.find((n) => n.id === selectedId) : undefined;

  return (
    <div className="inspector">
      <h3>检查器</h3>
      {!node && <p className="hint">选择一个节点以编辑参数。</p>}
      {node && <NodeParams node={node} dispatch={dispatch} />}
    </div>
  );
}

function NodeParams({
  node,
  dispatch,
}: {
  node: GraphNode;
  dispatch: React.Dispatch<GraphAction>;
}) {
  const def = NODE_DEFS[node.kind];
  return (
    <div className="inspector-body">
      <div className="inspector-row">
        <span>类型</span>
        <strong>{def.label}</strong>
      </div>
      <div className="inspector-row">
        <span>ID</span>
        <code>{node.id}</code>
      </div>
      {def.params?.map((p) => {
        if (p.type === 'float') {
          const v = node.params?.value ?? 0;
          return (
            <label className="param" key={p.key}>
              {p.label}
              <input
                type="number"
                step={0.1}
                value={v}
                onChange={(e) =>
                  dispatch({
                    type: 'set-param',
                    nodeId: node.id,
                    key: 'value',
                    value: Number(e.target.value),
                  })
                }
              />
              <input
                type="range"
                min={p.min ?? 0}
                max={p.max ?? 1}
                step={0.01}
                value={v}
                onChange={(e) =>
                  dispatch({
                    type: 'set-param',
                    nodeId: node.id,
                    key: 'value',
                    value: Number(e.target.value),
                  })
                }
              />
            </label>
          );
        }
        const rgb = node.params?.rgb ?? [0, 0, 0];
        return (
          <div className="param" key={p.key}>
            <span>{p.label}</span>
            {(['r', 'g', 'b'] as const).map((ch, i) => (
              <label key={ch} className="rgb-row">
                {ch}
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={rgb[i]}
                  onChange={(e) => {
                    const next: [number, number, number] = [...rgb] as [
                      number,
                      number,
                      number,
                    ];
                    next[i] = Number(e.target.value);
                    dispatch({
                      type: 'set-param',
                      nodeId: node.id,
                      key: 'rgb',
                      value: next,
                    });
                  }}
                />
              </label>
            ))}
          </div>
        );
      })}
    </div>
  );
}
