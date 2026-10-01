import { Graph } from './types';
import { GraphIssue } from './validate';

/** 页面 -> Worker */
export interface BuildRequest {
  type: 'build';
  /**
   * 页面单调递增的内容代际。revision 来自导入文件，可能与旧图相同；
   * generation 只在当前页面生命周期内有效，用于丢弃导入前的迟到结果。
   */
  generation: number;
  revision: number;
  graph: Graph;
}

/** Worker -> 页面 */
export interface BuildResult {
  type: 'result';
  generation: number;
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
