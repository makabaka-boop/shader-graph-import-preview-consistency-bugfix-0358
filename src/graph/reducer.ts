import {
  Edge,
  Graph,
  GraphNode,
  MAX_NODES,
  NodeKind,
  PortRef,
  getNodeDef,
} from './types';
import { canConnect } from './validate';

export type GraphAction =
  | { type: 'add-node'; kind: NodeKind; x: number; y: number; id?: string }
  | { type: 'move-node'; id: string; x: number; y: number }
  | { type: 'remove-node'; id: string }
  | { type: 'connect'; from: PortRef; to: PortRef; edgeId?: string }
  | { type: 'disconnect'; edgeId: string }
  | {
      type: 'set-param';
      nodeId: string;
      key: 'value' | 'rgb';
      value: number | [number, number, number];
    }
  | { type: 'load'; graph: Graph };

let idCounter = 0;
export function makeId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

export function createInitialGraph(): Graph {
  return { nodes: [], edges: [], revision: 0 };
}

/** 打开即合法的演示图：常量颜色与 UV 按时间插值后送入颜色输出。 */
export function createDemoGraph(): Graph {
  let g = createInitialGraph();
  g = graphReducer(g, { type: 'add-node', kind: 'uv', x: 40, y: 40, id: 'uv' });
  g = graphReducer(g, { type: 'add-node', kind: 'time', x: 40, y: 160, id: 'time' });
  g = graphReducer(g, { type: 'add-node', kind: 'const_vec3', x: 40, y: 280, id: 'base' });
  g = graphReducer(g, { type: 'add-node', kind: 'lerp', x: 290, y: 120, id: 'lerp1' });
  g = graphReducer(g, { type: 'add-node', kind: 'output', x: 540, y: 140, id: 'out' });
  g = graphReducer(g, {
    type: 'connect',
    from: { node: 'base', port: 'out' },
    to: { node: 'lerp1', port: 'a' },
    edgeId: 'e1',
  });
  g = graphReducer(g, {
    type: 'connect',
    from: { node: 'uv', port: 'out' },
    to: { node: 'lerp1', port: 'b' },
    edgeId: 'e2',
  });
  g = graphReducer(g, {
    type: 'connect',
    from: { node: 'time', port: 'out' },
    to: { node: 'lerp1', port: 't' },
    edgeId: 'e3',
  });
  g = graphReducer(g, {
    type: 'connect',
    from: { node: 'lerp1', port: 'out' },
    to: { node: 'out', port: 'color' },
    edgeId: 'e4',
  });
  return g;
}

export function graphReducer(prev: Graph, action: GraphAction): Graph {
  switch (action.type) {
    case 'add-node': {
      if (prev.nodes.length >= MAX_NODES) return prev;
      const def = getNodeDef(action.kind);
      const node: GraphNode = {
        id: action.id ?? makeId(action.kind),
        kind: action.kind,
        x: action.x,
        y: action.y,
        params: def.defaultParams ? { ...def.defaultParams } : undefined,
      };
      return {
        ...prev,
        nodes: [...prev.nodes, node],
        revision: prev.revision + 1,
      };
    }

    case 'move-node': {
      // 纯视图变更，不递增修订号（不触发重新生成/编译）
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === action.id ? { ...n, x: action.x, y: action.y } : n,
        ),
      };
    }

    case 'remove-node': {
      const nodes = prev.nodes.filter((n) => n.id !== action.id);
      const edges = prev.edges.filter(
        (e) => e.from.node !== action.id && e.to.node !== action.id,
      );
      return { nodes, edges, revision: prev.revision + 1 };
    }

    case 'connect': {
      const check = canConnect(prev, action.from, action.to);
      if (!check.ok) return prev; // 未通过类型/环检查的连线被拒绝
      const edge: Edge = {
        id: action.edgeId ?? makeId('edge'),
        from: action.from,
        to: action.to,
      };
      return { ...prev, edges: [...prev.edges, edge], revision: prev.revision + 1 };
    }

    case 'disconnect': {
      const edges = prev.edges.filter((e) => e.id !== action.edgeId);
      if (edges.length === prev.edges.length) return prev;
      return { ...prev, edges, revision: prev.revision + 1 };
    }

    case 'set-param': {
      const nodes = prev.nodes.map((n) => {
        if (n.id !== action.nodeId) return n;
        return {
          ...n,
          params: { ...(n.params ?? {}), [action.key]: action.value },
        };
      });
      return { ...prev, nodes, revision: prev.revision + 1 };
    }

    case 'load':
      return action.graph;
  }
}
