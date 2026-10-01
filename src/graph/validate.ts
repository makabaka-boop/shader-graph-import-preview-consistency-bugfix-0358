import {
  DataType,
  Edge,
  Graph,
  GraphNode,
  NODE_DEFS,
  PortDef,
  PortRef,
  findNode,
  findPortDef,
} from './types';

export type ConnectErrorCode =
  | 'missing-endpoint'
  | 'bad-direction'
  | 'self-connection'
  | 'input-occupied'
  | 'type-mismatch'
  | 'would-cycle';

export interface ConnectCheck {
  ok: boolean;
  reason?: string;
  code?: ConnectErrorCode;
  /** 该连线需把 float 提升为 vec3（目前仅颜色输出端口）。 */
  promote?: boolean;
}

export interface GraphIssue {
  code:
    | 'missing-output'
    | 'multiple-outputs'
    | 'type-mismatch'
    | 'unresolved-type'
    | 'type-conflict'
    | 'cycle'
    | 'dangling-port';
  message: string;
  nodeIds?: string[];
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: GraphIssue[];
  outputNodeId?: string;
  /** 从颜色输出可达的节点 id。 */
  reachable: Set<string>;
  /** 可达子图的拓扑序（有环或其他错误时为空）。 */
  order: string[];
  /** 动态端口解析出的具体类型，键为 `${nodeId}:${portId}`。 */
  resolved: Map<string, DataType>;
  /** 需要做 float -> vec3 提升的边 id 集合。 */
  promotions: Set<string>;
}

const OK_VALIDATION: ValidationResult = {
  ok: true,
  issues: [],
  reachable: new Set(),
  order: [],
  resolved: new Map(),
  promotions: new Set(),
};

function edgeInto(graph: Graph, ref: PortRef): Edge | undefined {
  return graph.edges.find(
    (e) => e.to.node === ref.node && e.to.port === ref.port,
  );
}

/** 前向邻接（数据流方向）：nodeId -> 其输出流向的节点。 */
function forwardAdjacency(graph: Graph, nodeIds?: Set<string>): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (nodeIds && (!nodeIds.has(e.from.node) || !nodeIds.has(e.to.node))) continue;
    const list = adj.get(e.from.node) ?? [];
    list.push(e.to.node);
    adj.set(e.from.node, list);
  }
  return adj;
}

/** 若新增 from -> to 的边，to 是否已经能沿数据流到达 from（成环）。 */
function createsCycle(graph: Graph, fromNode: string, toNode: string): boolean {
  const adj = forwardAdjacency(graph);
  const stack = [toNode];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === fromNode) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) stack.push(next);
  }
  return false;
}

/** 连接前检查：端点、方向、输入占用、类型兼容与潜在环。 */
export function canConnect(
  graph: Graph,
  from: PortRef,
  to: PortRef,
): ConnectCheck {
  const fail = (code: ConnectErrorCode, reason: string): ConnectCheck => ({
    ok: false,
    code,
    reason,
  });

  const srcNode = findNode(graph, from.node);
  const dstNode = findNode(graph, to.node);
  if (!srcNode || !dstNode) {
    return fail('missing-endpoint', '连线端点不存在');
  }
  const srcPort = findPortDef(srcNode, from.port);
  const dstPort = findPortDef(dstNode, to.port);
  if (!srcPort || !dstPort) {
    return fail('missing-endpoint', '连线端口不存在');
  }
  if (srcPort.kind !== 'output' || dstPort.kind !== 'input') {
    return fail('bad-direction', '连线必须从输出端口连到输入端口');
  }
  if (from.node === to.node) {
    return fail('self-connection', '节点不能连接到自身');
  }
  if (edgeInto(graph, to)) {
    return fail('input-occupied', '该输入端口已有连线');
  }

  // 类型检查
  if (srcPort.type === 'float' && dstPort.type === 'vec3') {
    if (!dstPort.acceptsFloatPromotion) {
      return fail('type-mismatch', 'float 不能连接到 vec3 端口');
    }
  } else if (srcPort.type === 'vec3' && dstPort.type === 'float') {
    return fail('type-mismatch', 'vec3 不能连接到 float 端口');
  }
  // any-number 端口可接 float / vec3 / 另一个 any-number；
  // 同节点动态端口共享一个类型变量，最终解析见 validateGraph。

  if (createsCycle(graph, from.node, to.node)) {
    return fail('would-cycle', '该连线会使输出可达子图形成环');
  }
  return { ok: true, promote: dstPort.acceptsFloatPromotion && srcPort.type === 'float' };
}

/** 并查集，用于动态端口类型推断。 */
class UnionFind {
  private parent = new Map<string, string>();
  add(x: string) {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = x;
    while (this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string) {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function collectReachable(graph: Graph, outputId: string): Set<string> {
  const reachable = new Set<string>([outputId]);
  const stack = [outputId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.to.node === cur && !reachable.has(e.from.node)) {
        reachable.add(e.from.node);
        stack.push(e.from.node);
      }
    }
  }
  return reachable;
}

/** 找环：返回环上的节点（前向 DFS 三色标记）。 */
function findCycleNodes(
  nodeIds: Set<string>,
  adj: Map<string, string[]>,
): string[] {
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 在栈中 2 完成
  const cycle: string[] = [];
  const visit = (id: string, path: string[]): boolean => {
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) {
      if (!nodeIds.has(next)) continue;
      const s = state.get(next) ?? 0;
      if (s === 1) {
        cycle.push(...path.slice(path.indexOf(next)), next);
        return true;
      }
      if (s === 0 && visit(next, [...path, next])) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of nodeIds) {
    if ((state.get(id) ?? 0) === 0 && visit(id, [id])) return cycle;
  }
  return [];
}

/**
 * 整体校验：
 * 1. 恰好一个颜色输出节点；
 * 2. 求其可达子图（断开的节点一律忽略，不影响输出）；
 * 3. 可达子图内做类型推断与冲突检查；
 * 4. 可达子图不得有环；
 * 5. 输出拓扑序。
 */
export function validateGraph(graph: Graph): ValidationResult {
  const issues: GraphIssue[] = [];
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  if (outputs.length === 0) {
    return { ...OK_VALIDATION, ok: false, issues: [{ code: 'missing-output', message: '图中缺少颜色输出节点' }] };
  }
  if (outputs.length > 1) {
    issues.push({
      code: 'multiple-outputs',
      message: `图中有 ${outputs.length} 个颜色输出节点，必须恰好为 1 个`,
      nodeIds: outputs.map((n) => n.id),
    });
    return { ...OK_VALIDATION, ok: false, issues };
  }

  const outputNode = outputs[0];
  const reachable = collectReachable(graph, outputNode.id);

  // 可达边与节点的端口健全性（reducer 已保证，这里做防御式检查）
  const reachableEdges = graph.edges.filter(
    (e) => reachable.has(e.from.node) && reachable.has(e.to.node),
  );
  for (const e of reachableEdges) {
    const srcNode = findNode(graph, e.from.node)!;
    const dstNode = findNode(graph, e.to.node)!;
    const srcPort = findPortDef(srcNode, e.from.port);
    const dstPort = findPortDef(dstNode, e.to.port);
    if (!srcPort || !dstPort) continue;
    if (srcPort.type === 'vec3' && dstPort.type === 'float') {
      issues.push({
        code: 'type-mismatch',
        message: `vec3 不能连接到 float 端口（${srcNode.id} → ${dstNode.id}）`,
        edgeId: e.id,
        nodeIds: [srcNode.id, dstNode.id],
      });
    }
  }

  // 动态类型推断：每个含动态端口的节点一个类型变量，
  // 同一条边两端的动态端口共享类型变量（并查集）。
  const uf = new UnionFind();
  const varOfNode = new Map<string, string>();
  for (const id of reachable) {
    const node = findNode(graph, id)!;
    const def = NODE_DEFS[node.kind];
    if ([...def.inputs, ...def.outputs].some((p) => p.flexible)) {
      const v = `T:${id}`;
      uf.add(v);
      varOfNode.set(id, v);
    }
  }

  // 硬锚点：连接具体类型端口后对类型变量的强约束。
  // 软锚点：颜色输出接受 float（提升）或 vec3，不构成约束，仅在无硬锚点时定默认。
  const hard = new Map<string, Set<DataType>>();
  const softVars = new Set<string>();
  const promotions = new Set<string>();
  const anchorHard = (v: string, t: DataType) => {
    const root = uf.find(v);
    const set = hard.get(root) ?? new Set<DataType>();
    set.add(t);
    hard.set(root, set);
  };

  for (const e of reachableEdges) {
    const srcNode = findNode(graph, e.from.node)!;
    const dstNode = findNode(graph, e.to.node)!;
    const srcPort = findPortDef(srcNode, e.from.port)!;
    const dstPort = findPortDef(dstNode, e.to.port)!;
    const srcVar = varOfNode.get(srcNode.id);
    const dstVar = varOfNode.get(dstNode.id);

    if (srcPort.flexible && dstPort.flexible) {
      uf.union(srcVar!, dstVar!);
    } else if (srcPort.flexible && !dstPort.flexible) {
      if (dstPort.type === 'vec3' && dstPort.acceptsFloatPromotion) {
        softVars.add(uf.find(srcVar!));
      } else {
        anchorHard(srcVar!, dstPort.type);
      }
    } else if (!srcPort.flexible && dstPort.flexible) {
      anchorHard(dstVar!, srcPort.type);
    } else if (
      srcPort.type === 'float' &&
      dstPort.type === 'vec3' &&
      dstPort.acceptsFloatPromotion
    ) {
      // 静态 float 源直连颜色输出
      promotions.add(e.id);
    }
  }

  const resolved = new Map<string, DataType>();
  for (const id of reachable) {
    const v = varOfNode.get(id);
    if (!v) continue;
    const root = uf.find(v);
    const types = hard.get(root);
    let chosen: DataType;
    if (types && types.size > 1) {
      issues.push({
        code: 'type-conflict',
        message: `节点 ${id} 的输入同时要求 float 与 vec3，类型冲突`,
        nodeIds: [id],
      });
      continue;
    } else if (types && types.size === 1) {
      chosen = [...types][0];
    } else if (softVars.has(root)) {
      // 只有颜色输出这一个出口：默认按 vec3 生成，代码生成端对该边做提升
      chosen = 'vec3';
    } else {
      issues.push({
        code: 'unresolved-type',
        message: `节点 ${NODE_DEFS[findNode(graph, id)!.kind].label}(${id}) 的类型无法确定，请连接 float 或 vec3 数据源`,
        nodeIds: [id],
      });
      continue;
    }
    const node = findNode(graph, id)!;
    const def = NODE_DEFS[node.kind];
    for (const p of [...def.inputs, ...def.outputs]) {
      if (p.flexible) resolved.set(`${id}:${p.id}`, chosen);
    }
  }

  // 实际选择 float 的动态节点直连颜色输出时，该边也需要提升
  for (const e of reachableEdges) {
    const srcNode = findNode(graph, e.from.node)!;
    const dstNode = findNode(graph, e.to.node)!;
    const srcPort = findPortDef(srcNode, e.from.port)!;
    const dstPort = findPortDef(dstNode, e.to.port)!;
    if (!dstPort.acceptsFloatPromotion) continue;
    const srcType = srcPort.flexible
      ? resolved.get(`${srcNode.id}:${srcPort.id}`)
      : srcPort.type;
    if (srcType === 'float') promotions.add(e.id);
  }

  // 环检测（仅可达子图；断开部分的环与输出无关）
  const adj = forwardAdjacency(graph, reachable);
  const cycleNodes = findCycleNodes(reachable, adj);
  if (cycleNodes.length > 0) {
    issues.push({
      code: 'cycle',
      message: '输出可达子图存在环',
      nodeIds: cycleNodes,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues, outputNodeId: outputNode.id, reachable, order: [], resolved, promotions };
  }

  // Kahn 拓扑排序
  const indegree = new Map<string, number>();
  for (const id of reachable) indegree.set(id, 0);
  for (const e of reachableEdges) {
    indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
  }
  const queue = [...reachable].filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== reachable.size) {
    // 理论上前面已检出环，防御式处理
    issues.push({ code: 'cycle', message: '拓扑排序失败：图中存在环' });
    return { ok: false, issues, outputNodeId: outputNode.id, reachable, order: [], resolved, promotions };
  }

  return {
    ok: true,
    issues: [],
    outputNodeId: outputNode.id,
    reachable,
    order,
    resolved,
    promotions,
  };
}

/** 取端口在给定解析结果下的具体类型。 */
export function effectivePortType(
  node: GraphNode,
  port: PortDef,
  resolved: Map<string, DataType>,
): DataType {
  if (!port.flexible) return port.type;
  return resolved.get(`${node.id}:${port.id}`) ?? 'any-number';
}
