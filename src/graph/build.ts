import { Graph } from './types';
import { GraphIssue, validateGraph } from './validate';
import { generateFragmentShader } from './glslgen';

export interface BuildOutput {
  revision: number;
  ok: boolean;
  issues: GraphIssue[];
  fragmentSource?: string;
  /** 拓扑序（ok 时非空），供 UI 高亮与测试验证生成顺序。 */
  order: string[];
  reachableIds: string[];
}

/** 对单个修订执行校验 + 排序 + GLSL 代码生成。纯函数，Worker 与测试共用。 */
export function buildForRevision(revision: number, graph: Graph): BuildOutput {
  const validation = validateGraph(graph);
  if (!validation.ok) {
    return {
      revision,
      ok: false,
      issues: validation.issues,
      order: [],
      reachableIds: [...validation.reachable],
    };
  }
  const generated = generateFragmentShader(graph, validation);
  return {
    revision,
    ok: true,
    issues: [],
    fragmentSource: generated.fragmentSource,
    order: generated.order,
    reachableIds: [...validation.reachable],
  };
}
