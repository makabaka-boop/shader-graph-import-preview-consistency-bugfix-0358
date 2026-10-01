import { Graph } from './types';
import { graphReducer } from './reducer';

export interface Builder {
  graph: Graph;
  node(
    kind: import('./types').NodeKind,
    id: string,
    x?: number,
    y?: number,
  ): Builder;
  connect(fromNode: string, fromPort: string, toNode: string, toPort: string, edgeId?: string): Builder;
  param(id: string, value: number | [number, number, number], key?: 'value' | 'rgb'): Builder;
  disconnect(edgeId: string): Builder;
}

/** 测试用链式建图：每步都经过 reducer（含类型检查/环拒绝）。 */
export function builder(): Builder {
  let graph: Graph = { nodes: [], edges: [], revision: 0 };
  const b: Builder = {
    get graph() {
      return graph;
    },
    node(kind, id, x = 0, y = 0) {
      graph = graphReducer(graph, { type: 'add-node', kind, id, x, y });
      return b;
    },
    connect(fromNode, fromPort, toNode, toPort, edgeId) {
      graph = graphReducer(graph, {
        type: 'connect',
        from: { node: fromNode, port: fromPort },
        to: { node: toNode, port: toPort },
        edgeId: edgeId ?? `e_${fromNode}_${fromPort}_${toNode}_${toPort}`,
      });
      return b;
    },
    param(id, value, key) {
      const k = key ?? (typeof value === 'number' ? 'value' : 'rgb');
      graph = graphReducer(graph, {
        type: 'set-param',
        nodeId: id,
        key: k as 'value' | 'rgb',
        // 测试构建器中类型由 key 决定
        value: value as number & [number, number, number],
      });
      return b;
    },
    disconnect(edgeId) {
      graph = graphReducer(graph, { type: 'disconnect', edgeId });
      return b;
    },
  };
  return b;
}
