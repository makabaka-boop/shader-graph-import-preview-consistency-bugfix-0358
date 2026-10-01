/// <reference lib="webworker" />
import { buildForRevision } from './build';
import type { BuildRequest, BuildResult } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<BuildRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'build') return;
  // 对请求的图完成排序与代码生成。token/revision 原样回传，
  // 由页面端按【会话内唯一的 token】决定是否采用——修订号可能与旧图相同，
  // 迟到的结果（哪怕修订号恰好相等）一律丢弃。
  const out = buildForRevision(msg.revision, msg.graph);
  const response: BuildResult = {
    type: 'result',
    token: msg.token,
    revision: out.revision,
    ok: out.ok,
    issues: out.issues,
    fragmentSource: out.fragmentSource,
    order: out.order,
    reachableIds: out.reachableIds,
  };
  ctx.postMessage(response);
};
