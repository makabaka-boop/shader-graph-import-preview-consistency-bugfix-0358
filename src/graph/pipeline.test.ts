import { describe, expect, it, vi } from 'vitest';
import { BuildSink, CompileOutcomeResult, GraphPipeline } from './pipeline';
import { BuildResult, BuildToken } from './protocol';
import { buildForRevision } from './build';
import { Graph } from './types';
import { graphReducer } from './reducer';

/** 可由测试手动投递结果的假 Worker sink。 */
class FakeSink implements BuildSink {
  requested: { token: BuildToken; revision: number; graph: Graph }[] = [];
  private cb: ((r: BuildResult) => void) | null = null;
  request(graph: Graph, token: BuildToken) {
    this.requested.push({ token, revision: graph.revision, graph });
  }
  onResult(cb: (r: BuildResult) => void) {
    this.cb = cb;
  }
  emit(result: BuildResult) {
    this.cb?.(result);
  }
  /** 模拟真实 Worker：按某次请求的图计算并带上该请求的 token 投递。 */
  emitProcessed(entryIndex = this.requested.length - 1) {
    const { token, revision, graph } = this.requested[entryIndex];
    this.emit({ type: 'result', token, ...buildForRevision(revision, graph) });
  }
}

interface CompileControl {
  token: BuildToken;
  revision: number;
  apply: ReturnType<typeof vi.fn>;
  resolve: (over?: { ok?: boolean; errors?: string[] }) => void;
}

function makeCompileAdapter() {
  const controls: CompileControl[] = [];
  const compile = vi.fn(
    (token: BuildToken, revision: number, _source: string) =>
      new Promise<CompileOutcomeResult>((outcome) => {
        const apply = vi.fn(() => Promise.resolve({ ok: true }));
        const control: CompileControl = {
          token,
          revision,
          apply,
          resolve: (over = {}) => {
            outcome({
              token,
              revision,
              ok: over.ok ?? true,
              errors: over.errors ?? [],
              apply,
            });
          },
        };
        controls.push(control);
      }),
  );
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

/** 与 validGraph 结构不同、但恰好也是 revision 3 的图（红色常量直连输出）。 */
function differentGraphSameRevision(): Graph {
  return {
    revision: 3,
    nodes: [
      { id: 'c', kind: 'const_vec3', x: 0, y: 0, params: { rgb: [1, 0, 0] } },
      { id: 'o2', kind: 'output', x: 10, y: 10 },
    ],
    edges: [
      {
        id: 'e2',
        from: { node: 'c', port: 'out' },
        to: { node: 'o2', port: 'color' },
      },
    ],
  };
}

describe('迟到结果防护', () => {
  it('迟到的 Worker 结果不会覆盖较新修订', () => {
    const sink = new FakeSink();
    const { adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1); // revision 3 / token 1
    expect(pipe.status.phase).toBe('building');

    // 用户连续编辑：改参数产生 revision 4 / token 2
    const g2 = graphReducer(g1, {
      type: 'set-param',
      nodeId: 't',
      key: 'value',
      value: 1,
    });
    pipe.submit(g2);
    expect(sink.requested[sink.requested.length - 1].revision).toBe(4);

    // revision 3（token 1）的 Worker 结果迟到
    sink.emit({ type: 'result', token: 1, ...buildForRevision(3, g1) });
    expect(pipe.status.phase).toBe('building'); // 没有被旧结果推进
    if (pipe.status.phase === 'building') expect(pipe.status.revision).toBe(4);

    // revision 4 的结果到达才进入 compiling
    sink.emitProcessed();
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);
  });

  it('迟到的编译结果不会覆盖较新修订', async () => {
    const sink = new FakeSink();
    const { controls, adapter } = makeCompileAdapter();
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

    // 旧的 r3（token 1）编译迟到返回成功
    controls[0].resolve();
    await Promise.resolve();
    expect(controls[0].apply).not.toHaveBeenCalled(); // 迟到结果不允许上屏
    expect(pipe.status.phase).toBe('compiling');
    if (pipe.status.phase === 'compiling') expect(pipe.status.revision).toBe(4);

    // r4 返回后才 ready
    controls[1].resolve();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    if (pipe.status.phase === 'ready') expect(pipe.status.revision).toBe(4);
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

describe('导入同修订号的另一份图', () => {
  it('修订号相同但内容不同必须重新构建，旧代次的迟到结果一律丢弃', async () => {
    const sink = new FakeSink();
    const { controls, compile, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1); // token 1, revision 3；Worker 结果尚未返回

    // 构建还在路上时，导入另一份恰好也是 revision 3 的图：画布内容已切换
    const imported = differentGraphSameRevision();
    pipe.submit(imported);
    // 不能因为修订号相同就跳过重发
    expect(sink.requested).toHaveLength(2);
    expect(sink.requested[1].token).toBe(2);
    expect(sink.requested[1].revision).toBe(3);
    expect(pipe.status.phase).toBe('building');

    // 旧图（token 1, revision 3）的 Worker 结果迟到：修订号相等也必须丢弃
    sink.emit({ type: 'result', token: 1, ...buildForRevision(3, g1) });
    expect(pipe.status.phase).toBe('building');
    expect(compile).not.toHaveBeenCalled(); // 被丢弃的结果不触发编译

    // 新图（token 2）结果到达，进入编译（唯一一次编译）
    sink.emitProcessed(1);
    expect(pipe.status.phase).toBe('compiling');
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile.mock.calls[0][0]).toBe(2);

    // 新图编译完成：ready 的内容属于新图（红色常量直连输出）
    controls[0].resolve();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    if (pipe.status.phase !== 'ready') throw new Error('expected ready');
    expect(pipe.status.revision).toBe(3);

    const snap = pipe.captureExport(() => 'data:image/png;base64,NEW');
    expect(snap.revision).toBe(3);
    expect(snap.graph.nodes.map((n) => n.id).sort()).toEqual(['c', 'o2']);
    expect(snap.dataUrl).toBe('data:image/png;base64,NEW');
  });

  it('旧图挂起的编译在导入同修订号新图后返回，也不得上屏', async () => {
    const sink = new FakeSink();
    const { controls, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1); // token 1
    sink.emitProcessed(); // 旧 Worker 结果先到 -> compiling，编译挂起
    expect(pipe.status.phase).toBe('compiling');

    // 编译还没返回时导入同修订号新图 -> token 2，重新构建
    pipe.submit(differentGraphSameRevision());
    sink.emitProcessed(1); // 新图 Worker 结果 -> compiling
    expect(pipe.status.phase).toBe('compiling');

    // 旧编译此时才迟到成功：禁止上屏
    controls[0].resolve();
    await Promise.resolve();
    expect(controls[0].apply).not.toHaveBeenCalled();
    expect(pipe.status.phase).toBe('compiling');

    // 新图编译完成后才就绪
    controls[1].resolve();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    if (pipe.status.phase !== 'ready') throw new Error('expected ready');
    expect(pipe.status.revision).toBe(3);
  });
});

describe('只移动节点（修订号不变）', () => {
  it('不重新构建/编译，但导出快照必须带上最新布局并重新截图', async () => {
    const sink = new FakeSink();
    const { controls, adapter } = makeCompileAdapter();
    const g1 = validGraph();
    const pipe = new GraphPipeline(g1, sink, adapter);
    pipe.submit(g1);
    sink.emitProcessed();
    controls[0].resolve();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));

    const capture = vi.fn(() => 'data:image/png;base64,AAA');
    const snap1 = pipe.captureExport(capture);
    expect(snap1.graph.nodes.find((n) => n.id === 't')!.x).toBe(0);

    // 用户只拖动节点：revision 仍为 3，结构签名不变
    const moved = graphReducer(g1, { type: 'move-node', id: 't', x: 999, y: 7 });
    expect(moved.revision).toBe(3);
    pipe.submit(moved);
    expect(sink.requested).toHaveLength(1); // 没有重新发起构建
    expect(pipe.status.phase).toBe('ready'); // 预览保持就绪

    // 旧截图包因布局变化作废：再次导出拿到新布局、新截图
    const snap2 = pipe.captureExport(capture);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(snap2.graph.nodes.find((n) => n.id === 't')!.x).toBe(999);
    expect(snap2.graph.nodes.find((n) => n.id === 't')!.y).toBe(7);
    expect(snap2.fragmentSource).toBe(snap1.fragmentSource); // 着色器结果不变
    // 已取出的旧快照对象不被回溯修改
    expect(snap1.graph.nodes.find((n) => n.id === 't')!.x).toBe(0);
  });

  it('布局未再变化时复用同一截图包，不重复截图', async () => {
    const sink = new FakeSink();
    const { controls, adapter } = makeCompileAdapter();
    const pipe = new GraphPipeline(validGraph(), sink, adapter);
    pipe.submit(validGraph());
    sink.emitProcessed();
    controls[0].resolve();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));

    const capture = vi.fn(() => 'data:image/png;base64,AAA');
    const a = pipe.captureExport(capture);
    const b = pipe.captureExport(capture);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
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
    controls[0].resolve();
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
