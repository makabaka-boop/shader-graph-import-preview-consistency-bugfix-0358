import { DataType, Graph, NODE_DEFS, findNode, findPortDef } from './types';
import { ValidationResult } from './validate';

export interface GeneratedShader {
  fragmentSource: string;
  /** 代码生成所依据的节点顺序（即拓扑序），便于测试。 */
  order: string[];
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function literalFloat(v: number | undefined): string {
  const n = Number.isFinite(v) ? (v as number) : 0;
  return `${n.toFixed(6)}`;
}

function glslType(t: DataType): string {
  return t === 'float' ? 'float' : 'vec3';
}

/** 固定的全屏三角形顶点着色器。 */
export const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
out vec4 outColor;
`;

/**
 * 依据校验结果（拓扑序 + 类型解析）生成片段着色器。
 * 调用前必须保证 validation.ok === true。
 * 断开的节点不在 reachable/order 中，因此完全不影响输出。
 */
export function generateFragmentShader(
  graph: Graph,
  validation: ValidationResult,
): GeneratedShader {
  const lines: string[] = [];
  const varName = (nodeId: string) => `n_${sanitize(nodeId)}`;

  const effectiveType = (nodeId: string, portId: string): DataType =>
    validation.resolved.get(`${nodeId}:${portId}`) ?? 'float';

  /** 某输入端口对应的 GLSL 表达式（含未连接时的默认值与 float→vec3 提升）。 */
  const inputExpr = (nodeId: string, portId: string): { expr: string; type: DataType } => {
    const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === portId);
    const node = findNode(graph, nodeId)!;
    const port = findPortDef(node, portId)!;

    if (!edge) {
      if (port.flexible) {
        const t = effectiveType(nodeId, portId);
        return {
          expr: t === 'float' ? '0.0' : 'vec3(0.0)',
          type: t,
        };
      }
      // 颜色输入默认黑色，t 默认 0
      return { expr: port.type === 'vec3' ? 'vec3(0.0)' : '0.0', type: port.type };
    }

    const srcNode = findNode(graph, edge.from.node)!;
    const srcPort = findPortDef(srcNode, edge.from.port)!;
    const srcType = srcPort.flexible
      ? effectiveType(srcNode.id, srcPort.id)
      : srcPort.type;
    let expr = `${varName(srcNode.id)}`;

    const dstType = port.flexible
      ? effectiveType(nodeId, portId)
      : port.type;
    if (srcType === 'float' && dstType === 'vec3') {
      expr = `vec3(${expr}, ${expr}, ${expr})`;
    }
    return { expr, type: srcType === 'float' && dstType === 'vec3' ? 'vec3' : srcType };
  };

  for (const nodeId of validation.order) {
    const node = findNode(graph, nodeId)!;
    const def = NODE_DEFS[node.kind];
    const v = varName(node.id);

    switch (node.kind) {
      case 'const_float':
        lines.push(`float ${v} = ${literalFloat(node.params?.value)};`);
        break;
      case 'const_vec3': {
        const [r, g, b] = node.params?.rgb ?? [0, 0, 0];
        lines.push(
          `vec3 ${v} = vec3(${literalFloat(r)}, ${literalFloat(g)}, ${literalFloat(b)});`,
        );
        break;
      }
      case 'uv':
        lines.push(`vec3 ${v} = vec3(vUv, 0.0);`);
        break;
      case 'time':
        lines.push(`float ${v} = uTime;`);
        break;
      case 'add':
      case 'multiply':
      case 'lerp': {
        const t = effectiveType(node.id, def.outputs[0].id);
        const a = inputExpr(node.id, 'a');
        const b = inputExpr(node.id, 'b');
        if (node.kind === 'add') {
          lines.push(`${glslType(t)} ${v} = ${a.expr} + ${b.expr};`);
        } else if (node.kind === 'multiply') {
          lines.push(`${glslType(t)} ${v} = ${a.expr} * ${b.expr};`);
        } else {
          const tt = inputExpr(node.id, 't');
          lines.push(`${glslType(t)} ${v} = mix(${a.expr}, ${b.expr}, ${tt.expr});`);
        }
        break;
      }
      case 'output': {
        const color = inputExpr(node.id, 'color');
        lines.push(`vec3 finalColor_${sanitize(node.id)} = ${color.expr};`);
        break;
      }
    }
  }

  const outputId = validation.outputNodeId;
  const body = lines.length ? lines.join('\n  ') : '';
  const source = `${HEADER}
void main() {
  ${body}
  outColor = vec4(finalColor_${sanitize(outputId!)}, 1.0);
}
`;
  return { fragmentSource: source, order: [...validation.order] };
}
