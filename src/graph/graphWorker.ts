/// <reference lib="webworker" />
import { buildForRevision } from './build';
import type { BuildRequest, BuildResult } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<BuildRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'build') return;
  // 对“当前修订”完成排序与代码生成。修订号原样回传，
  // 由页面端决定是否采用，迟到的结果不会覆盖较新修订。
  const out = buildForRevision(msg.revision, msg.graph);
  const response: BuildResult = {
    type: 'result',
    revision: out.revision,
    ok: out.ok,
    issues: out.issues,
    fragmentSource: out.fragmentSource,
    order: out.order,
    reachableIds: out.reachableIds,
  };
  ctx.postMessage(response);
};
