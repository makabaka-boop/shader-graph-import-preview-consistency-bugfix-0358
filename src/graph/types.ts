// 颜色图的核心数据模型（可序列化、可导出）

export type NodeKind =
  | 'const_float'
  | 'const_vec3'
  | 'uv'
  | 'time'
  | 'add'
  | 'multiply'
  | 'lerp'
  | 'output';

/** 数据类型：仅标量与三分量颜色/向量两种。'any-number' 表示动态数值端口，
 *  实际类型由连线另一端决定，仅允许 float↔float / vec3↔vec3。 */
export type DataType = 'float' | 'vec3' | 'any-number';

/** 常量节点携带的参数。 */
export interface NodeParams {
  value?: number;
  rgb?: [number, number, number];
}

export interface PortRef {
  node: string;
  port: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  params?: NodeParams;
}

/** 一条边：输出端口 -> 输入端口。每个输入端口至多一条边（见 reducer 保证）。 */
export interface Edge {
  id: string;
  from: PortRef;
  to: PortRef;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Edge[];
  /** 当前修订号：每次结构性编辑 / 参数修改递增，移动节点不递增。 */
  revision: number;
}

export interface ParamDef {
  key: keyof NodeParams;
  label: string;
  type: 'float' | 'rgb';
  min?: number;
  max?: number;
}

export interface PortDef {
  id: string;
  label: string;
  kind: 'input' | 'output';
  type: DataType;
  /** any-number 端口实际接受 float / vec3（同型相连）。 */
  flexible?: boolean;
  /** 标量会被自动提升为 vec3 的严格 vec3 输入（如颜色输出）。 */
  acceptsFloatPromotion?: boolean;
}

export interface NodeDef {
  kind: NodeKind;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params?: ParamDef[];
  defaultParams?: NodeParams;
}

export const MAX_NODES = 50;

export const NODE_DEFS: Record<NodeKind, NodeDef> = {
  const_float: {
    kind: 'const_float',
    label: '常量 (float)',
    inputs: [],
    outputs: [{ id: 'out', label: '值', kind: 'output', type: 'float' }],
    params: [{ key: 'value', label: '值', type: 'float' }],
    defaultParams: { value: 0.5 },
  },
  const_vec3: {
    kind: 'const_vec3',
    label: '常量 (vec3)',
    inputs: [],
    outputs: [{ id: 'out', label: 'rgb', kind: 'output', type: 'vec3' }],
    params: [{ key: 'rgb', label: '颜色', type: 'rgb' }],
    defaultParams: { rgb: [1, 1, 1] },
  },
  uv: {
    kind: 'uv',
    label: 'UV',
    inputs: [],
    outputs: [{ id: 'out', label: 'uv', kind: 'output', type: 'vec3' }],
  },
  time: {
    kind: 'time',
    label: '时间',
    inputs: [],
    outputs: [{ id: 'out', label: 't', kind: 'output', type: 'float' }],
  },
  add: {
    kind: 'add',
    label: '加',
    inputs: [
      { id: 'a', label: 'a', kind: 'input', type: 'any-number', flexible: true },
      { id: 'b', label: 'b', kind: 'input', type: 'any-number', flexible: true },
    ],
    outputs: [{ id: 'out', label: '和', kind: 'output', type: 'any-number', flexible: true }],
  },
  multiply: {
    kind: 'multiply',
    label: '乘',
    inputs: [
      { id: 'a', label: 'a', kind: 'input', type: 'any-number', flexible: true },
      { id: 'b', label: 'b', kind: 'input', type: 'any-number', flexible: true },
    ],
    outputs: [{ id: 'out', label: '积', kind: 'output', type: 'any-number', flexible: true }],
  },
  lerp: {
    kind: 'lerp',
    label: '插值',
    inputs: [
      { id: 'a', label: 'a', kind: 'input', type: 'any-number', flexible: true },
      { id: 'b', label: 'b', kind: 'input', type: 'any-number', flexible: true },
      { id: 't', label: 't', kind: 'input', type: 'float' },
    ],
    outputs: [{ id: 'out', label: '结果', kind: 'output', type: 'any-number', flexible: true }],
  },
  output: {
    kind: 'output',
    label: '颜色输出',
    inputs: [
      {
        id: 'color',
        label: '颜色',
        kind: 'input',
        type: 'vec3',
        acceptsFloatPromotion: true,
      },
    ],
    outputs: [],
  },
};

export function getNodeDef(kind: NodeKind): NodeDef {
  return NODE_DEFS[kind];
}

export function findNode(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function findPortDef(
  node: GraphNode,
  portId: string,
): PortDef | undefined {
  const def = NODE_DEFS[node.kind];
  return [...def.inputs, ...def.outputs].find((p) => p.id === portId);
}

export function isNodeKind(value: string): value is NodeKind {
  return value in NODE_DEFS;
}
