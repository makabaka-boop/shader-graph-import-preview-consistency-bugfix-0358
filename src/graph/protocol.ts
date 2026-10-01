import { Graph } from './types';
import { GraphIssue } from './validate';

/** 页面 -> Worker */
export interface BuildRequest {
  type: 'build';
  revision: number;
  graph: Graph;
}

/** Worker -> 页面 */
export interface BuildResult {
  type: 'result';
  revision: number;
  ok: boolean;
  issues: GraphIssue[];
  fragmentSource?: string;
  /** 拓扑序，供 UI 高亮与测试验证生成顺序。 */
  order?: string[];
  reachableIds?: string[];
}

export type WorkerInMessage = BuildRequest;
export type WorkerOutMessage = BuildResult;
