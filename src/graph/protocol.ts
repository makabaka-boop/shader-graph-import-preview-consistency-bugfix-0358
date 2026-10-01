import { Graph } from './types';
import { GraphIssue } from './validate';

/**
 * 构建代次（token）：主线程每次发起一次新构建时单调递增。
 * 修订号（revision）是图自身携带的、可重复的（导入的图可能与旧图修订号相同），
 * 因此“是否迟到”只能由会话内唯一的 token 判定，不能用修订号判定。
 */
export type BuildToken = number;

/** 页面 -> Worker */
export interface BuildRequest {
  type: 'build';
  token: BuildToken;
  revision: number;
  graph: Graph;
}

/** Worker -> 页面 */
export interface BuildResult {
  type: 'result';
  token: BuildToken;
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
