import { describe, expect, it, vi } from 'vitest';
import { BuildSink, CompileResult, GraphPipeline } from './pipeline';
import { BuildResult } from './protocol';
import { buildForRevision } from './build';
import { Graph } from './types';
import { graphReducer } from './reducer';

/** 可由测试手动投递结果的假 Worker sink。 */
class FakeSink implements BuildSink {
  requested: { generation: number; revision: number; graph: Graph }[] = [];
  private cb: ((r: BuildResult) => void) | null = null;
  request(graph: Graph, generation: number, revision: number) {
    this.requested.push({ generation, revision, graph });
  }
  onResult(cb: (r: BuildResult) => void) {
    this.cb = cb;
  }
  emit(result: BuildResult) {
    this.cb?.(result);
  }
  /** 模拟真实 Worker：按当时代际/修订的图计算并投递。 */
  emitProcessed(entryIndex = this.requested.length - 1) {
    const { generation, revision, graph } = this.requested[entryIndex];
    this.emit({ type: 'result', generation, ...buildForRevision(revision, graph) });
  }
}

function makeCompileAdapter() {
  type Control = {
    generation: number;
    revision: number;
    resolve: (v: CompileResult) => void;
    committed: boolean;
    discarded: boolean;
  };
  const controls: Control[] = [];
  const compile = vi.fn(
    (generation: number, revision: number, _source: string) =>
      new Promise<CompileResult>((resolve) => {
        const control: Control = {
          generation,
          revision,
          committed: false,
          discarded: false,
          resolve,
        };
        controls.push(control);
      }),
  );
  const succeed = (index: number) => {
    const c = controls[index];
    c.resolve({
      generation: c.generation,
      revision: c.revision,
      ok: true,
      errors: [],
      commit: () => {
        c.committed = true;
      },
      discard: () => {
        c.discarded = true;
      },
    });
  };
  const deactivate = vi.fn();
  return {
    compile,
    controls,
    succeed,
    deactivate,
    adapter: { compile, deactivate },
  };
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
    sink.emit({ type: 'result', generation: 1, ...buildForRevision(3, g1) });
    expect(pipe.status.phase).toBe('building'); // 没有被旧结果推进
    if (pipe.status.phase === 'building') expect(pipe.status.revision).toBe(4);

    // revision 4 的结果到达才进入 compiling
    sink.emit({ type: 'result', generation: 2, ...buildForRevision(4, g2) });
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);
  });

  it('迟到的编译结果不会覆盖较新修订', async () => {
    const sink = new FakeSink();
    const { compile, controls, succeed, adapter } = makeCompileAdapter();
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

    // 旧的 r3 编译迟到返回成功，但不能让暂存程序上屏
    succeed(0);
    await Promise.resolve();
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);
    expect(controls[0].committed).toBe(false);
    expect(controls[0].discarded).toBe(true);

    // r4 返回后才 ready
    succeed(1);
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

describe('导入相同 revision 的另一份图', () => {
  function otherGraphWithSameRevision(): Graph {
    return {
      revision: 3,
      nodes: [
        { id: 'c', kind: 'const_float', x: 30, y: 40, params: { value: 0.25 } },
        { id: 'o', kind: 'output', x: 10, y: 10 },
      ],
      edges: [
        {
          id: 'e',
          from: { node: 'c', port: 'out' },
          to: { node: 'o', port: 'color' },
        },
      ],
    };
  }

  it('revision 相同也用新代际拒绝旧 Worker 结果', () => {
    const sink = new FakeSink();
    const { adapter } = makeCompileAdapter();
    const oldGraph = validGraph();
    const importedGraph = otherGraphWithSameRevision();
    const pipe = new GraphPipeline(oldGraph, sink, adapter);

    pipe.submit(oldGraph);
    expect(sink.requested[sink.requested.length - 1]).toMatchObject({
      generation: 1,
      revision: 3,
    });

    pipe.submit(importedGraph);
    expect(sink.requested[sink.requested.length - 1]).toMatchObject({
      generation: 2,
      revision: 3,
    });

    // 导入前已排队的旧图 Worker 结果迟到，revision 同样是 3 也不能采用
    sink.emitProcessed(0);
    expect(pipe.status.phase).toBe('building');
    if (pipe.status.phase === 'building') {
      expect(pipe.status.generation).toBe(2);
    }

    sink.emitProcessed(1);
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') {
      expect(pipe.status.generation).toBe(2);
      expect(pipe.status.fragmentSource).toContain('0.25');
      expect(pipe.status.fragmentSource).not.toContain('= uTime');
    }
  });

  it('旧编译结果即使 revision 相同也不能提交到画布', async () => {
    const sink = new FakeSink();
    const { controls, succeed, deactivate, adapter } = makeCompileAdapter();
    const oldGraph = validGraph();
    const importedGraph = otherGraphWithSameRevision();
    const pipe = new GraphPipeline(oldGraph, sink, adapter);

    pipe.submit(oldGraph);
    sink.emitProcessed();
    expect(pipe.status.phase).toBe('compiling');

    pipe.submit(importedGraph);
    expect(deactivate).toHaveBeenCalled();
    sink.emitProcessed();

    succeed(0);
    await Promise.resolve();
    expect(controls[0].committed).toBe(false);
    expect(controls[0].discarded).toBe(true);
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') {
      expect(pipe.status.generation).toBe(2);
    }

    succeed(1);
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    expect(controls[1].committed).toBe(true);
  });
});

describe('纯布局编辑的导出一致性', () => {
  it('快照锁定 revision 与 graph，连续编辑后旧快照不变', async () => {
    const sink = new FakeSink();
    const { succeed, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1);
    sink.emitProcessed();
    succeed(0);
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

  it('移动节点不重建，但每次导出捕获最新布局', async () => {
    const sink = new FakeSink();
    const { succeed, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1);
    sink.emitProcessed();
    succeed(0);
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    const requestCountAfterReady = sink.requested.length;

    const moved: Graph = {
      ...g1,
      nodes: g1.nodes.map((n) => (n.id === 't' ? { ...n, x: 123, y: 456 } : n)),
    };
    pipe.submit(moved, false);
    expect(sink.requested.length).toBe(requestCountAfterReady);
    expect(pipe.status.phase).toBe('ready');
    if (pipe.status.phase === 'ready') expect(pipe.status.revision).toBe(3);

    const snap = pipe.captureExport(() => 'data:image/png;base64,MOVED');
    const movedNode = snap.graph.nodes.find((n) => n.id === 't');
    expect(movedNode).toMatchObject({ x: 123, y: 456 });
    expect(snap.fragmentSource).toBe(
      pipe.status.phase === 'ready' ? pipe.status.fragmentSource : '',
    );
  });
});
