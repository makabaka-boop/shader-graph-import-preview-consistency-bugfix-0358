import { describe, expect, it, vi } from 'vitest';
import { BuildSink, GraphPipeline } from './pipeline';
import { BuildResult } from './protocol';
import { buildForRevision } from './build';
import { Graph } from './types';
import { graphReducer } from './reducer';

/** 可由测试手动投递结果的假 Worker sink。 */
class FakeSink implements BuildSink {
  requested: { revision: number; graph: Graph }[] = [];
  private cb: ((r: BuildResult) => void) | null = null;
  request(graph: Graph, revision: number) {
    this.requested.push({ revision, graph });
  }
  onResult(cb: (r: BuildResult) => void) {
    this.cb = cb;
  }
  emit(result: BuildResult) {
    this.cb?.(result);
  }
  /** 模拟真实 Worker：按当时修订的图计算并投递。 */
  emitProcessed(entryIndex = this.requested.length - 1) {
    const { revision, graph } = this.requested[entryIndex];
    this.emit({ type: 'result', ...buildForRevision(revision, graph) });
  }
}

function makeCompileAdapter() {
  const compile = vi.fn(
    (revision: number, _source: string) =>
      new Promise<{ revision: number; ok: boolean; errors: string[] }>((resolve) => {
        // 默认立刻成功；测试通过 controls 手动控制时机
        controls.push({ revision, resolve });
      }),
  );
  const controls: { revision: number; resolve: (v: { revision: number; ok: boolean; errors: string[] }) => void }[] = [];
  return { compile, controls, adapter: { compile } };
}

function validGraph(): Graph {
  let g: Graph = { nodes: [], edges: [], revision: 0 };
  g = graphReducer(g, { type: 'add-node', kind: 'time', id: 't', x: 0, y: 0 });
  g = graphReducer(g, { type: 'add-node', kind: 'output', id: 'o', x: 0, y: 0 });
  g = graphReducer(g, {
    type: 'connect',
    from: { node: 't', port: 'out' },
    to: { node: 'o', port: 'color' },
    edgeId: 'e',
  });
  return g; // revision 3
}

describe('迟到结果防护', () => {
  it('迟到的 Worker 结果不会覆盖较新修订', () => {
    const sink = new FakeSink();
    const { adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1); // revision 3
    expect(pipe.status.phase).toBe('building');

    // 用户连续编辑：改参数产生 revision 4
    const g2 = graphReducer(g1, {
      type: 'set-param',
      nodeId: 't',
      key: 'value',
      value: 1,
    });
    pipe.submit(g2);
    expect(sink.requested[sink.requested.length - 1].revision).toBe(4);

    // revision 3 的 Worker 结果迟到
    sink.emit({ type: 'result', ...buildForRevision(3, g1) });
    expect(pipe.status.phase).toBe('building'); // 没有被旧结果推进
    if (pipe.status.phase === 'building') expect(pipe.status.revision).toBe(4);

    // revision 4 的结果到达才进入 compiling
    sink.emit({ type: 'result', ...buildForRevision(4, g2) });
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);
  });

  it('迟到的编译结果不会覆盖较新修订', async () => {
    const sink = new FakeSink();
    const { compile, controls, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1);
    sink.emitProcessed(); // r3 -> compiling, 编译 Promise 挂起

    const g2 = graphReducer(g1, {
      type: 'set-param',
      nodeId: 't',
      key: 'value',
      value: 2,
    });
    pipe.submit(g2);
    sink.emitProcessed(); // r4 -> compiling

    // 旧的 r3 编译迟到返回成功
    controls[0].resolve({ revision: 3, ok: true, errors: [] });
    await Promise.resolve();
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);

    // r4 返回后才 ready
    controls[1].resolve({ revision: 4, ok: true, errors: [] });
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    if (pipe.status.phase === 'ready') expect(pipe.status.revision).toBe(4);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('非法修订在 Worker 阶段就被拦下，不触发编译', () => {
    const sink = new FakeSink();
    const { compile, adapter } = makeCompileAdapter();
    const empty: Graph = { nodes: [], edges: [], revision: 1 };
    const pipe = new GraphPipeline(empty, sink, adapter);
    pipe.submit(empty);
    sink.emitProcessed();
    expect(pipe.status.phase).toBe('invalid-graph');
    expect(compile).not.toHaveBeenCalled();
  });
});

describe('导出数据与截图属于同一修订', () => {
  it('快照锁定 revision 与 graph，连续编辑后旧快照不变', async () => {
    const sink = new FakeSink();
    const { controls, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1);
    sink.emitProcessed();
    controls[0].resolve({ revision: 3, ok: true, errors: [] });
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));

    const snap = pipe.captureExport(() => 'data:image/png;base64,AAA');
    expect(snap.revision).toBe(3);
    expect(snap.dataUrl).toBe('data:image/png;base64,AAA');
    expect(snap.graph.revision).toBe(3);

    // 后续编辑不改变已取出的快照
    const g2 = graphReducer(g1, {
      type: 'set-param',
      nodeId: 't',
      key: 'value',
      value: 9,
    });
    pipe.submit(g2);
    expect(snap.revision).toBe(3);
    expect(snap.graph.revision).toBe(3);
  });

  it('未就绪状态不允许导出', () => {
    const sink = new FakeSink();
    const { adapter } = makeCompileAdapter();
    const pipe = new GraphPipeline(validGraph(), sink, adapter);
    expect(() => pipe.captureExport(() => '')).toThrow();
  });
});
