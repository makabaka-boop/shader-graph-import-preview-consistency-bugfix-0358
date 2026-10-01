import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WebGLRenderer } from '../webgl/renderer';
import { GraphPipeline, RevisionStatus } from '../graph/pipeline';
import { BuildSink } from '../graph/pipeline';
import { BuildResult } from '../graph/protocol';
import { buildForRevision } from '../graph/build';
import { Graph } from '../graph/types';

// node 环境无 rAF：提供空桩（恢复路径会调用 start）
beforeEach(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
});

function phase(p: GraphPipeline): RevisionStatus['phase'] {
  return p.status.phase;
}
function rev(p: GraphPipeline): number {
  return (p.status as Extract<RevisionStatus, { revision: number }>).revision;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 最小 WebGL2 模拟：编译/链接恒成功，记录程序创建次数，
 * 支持模拟上下文丢失（GL 调用全部失效）与恢复（状态归零）。
 */
class FakeGL2 {
  static instances: FakeGL2[] = [];
  programCount = 0;
  drawCount = 0;
  lost = false;
  compileFails = false;
  vertexShader: WebGLShader = { __vs: true } as unknown as WebGLShader;
  currentProgram: unknown = null;

  VERTEX_SHADER = 0x8b31;
  FRAGMENT_SHADER = 0x8b30;
  COMPILE_STATUS = 0x8b81;
  LINK_STATUS = 0x8b82;
  ARRAY_BUFFER = 0x8892;
  STATIC_DRAW = 0x88e4;
  COLOR_BUFFER_BIT = 0x4000;
  TRIANGLES = 0x0004;
  FLOAT = 0x1406;

  constructor() {
    FakeGL2.instances.push(this);
  }

  createShader() {
    return { __shader: true } as unknown as WebGLShader;
  }
  shaderSource() {}
  compileShader() {}
  getShaderParameter(_s: unknown, pname: number) {
    if (pname === this.COMPILE_STATUS) return !this.compileFails;
    return true;
  }
  getShaderInfoLog() {
    return 'fake compile error';
  }
  deleteShader() {}
  createProgram() {
    this.programCount += 1;
    return { __program: this.programCount } as unknown as WebGLProgram;
  }
  attachShader() {}
  linkProgram() {}
  getProgramParameter(_p: unknown, pname: number) {
    if (pname === this.LINK_STATUS) return true;
    return true;
  }
  getProgramInfoLog() {
    return 'fake link error';
  }
  deleteProgram(p: WebGLProgram) {
    if (this.currentProgram === p) this.currentProgram = null;
  }
  getUniformLocation() {
    return {} as WebGLUniformLocation;
  }
  createVertexArray() {
    return { __vao: true } as unknown as WebGLVertexArrayObject;
  }
  bindVertexArray() {}
  createBuffer() {
    return { __buf: true } as unknown as WebGLBuffer;
  }
  bindBuffer() {}
  bufferData() {}
  enableVertexAttribArray() {}
  vertexAttribPointer() {}
  useProgram(p: WebGLProgram) {
    this.currentProgram = p;
  }
  uniform1f() {}
  viewport() {}
  clearColor() {}
  clear() {}
  drawArrays() {
    if (this.lost) throw new Error('GL context lost');
    this.drawCount += 1;
  }
  getExtension() {
    return null;
  }
}

function fakeCanvas(gl: FakeGL2): HTMLCanvasElement {
  const listeners: Record<string, EventListener[]> = {};
  return {
    width: 320,
    height: 320,
    addEventListener: (type: string, cb: EventListener) => {
      (listeners[type] ??= []).push(cb);
    },
    removeEventListener: () => {},
    dispatch(type: string) {
      listeners[type]?.forEach((cb) =>
        cb({ type, preventDefault() {} } as unknown as Event),
      );
    },
    getContext: () => gl as unknown as WebGL2RenderingContext,
    toDataURL: () => 'data:image/png;base64,FAKE',
  } as unknown as HTMLCanvasElement;
}

class ManualSink implements BuildSink {
  requested: { generation: number; revision: number }[] = [];
  private cb: ((r: BuildResult) => void) | null = null;
  constructor(private graphs = new Map<string, Graph>()) {}
  private key(generation: number, revision: number) {
    return `${generation}:${revision}`;
  }
  remember(generation: number, rev: number, graph: Graph) {
    this.graphs.set(this.key(generation, rev), graph);
  }
  request(graph: Graph, generation: number, revision: number) {
    this.requested.push({ generation, revision });
    this.graphs.set(this.key(generation, revision), graph);
  }
  onResult(cb: (r: BuildResult) => void) {
    this.cb = cb;
  }
  respond(generation: number, rev: number) {
    const graph = this.graphs.get(this.key(generation, rev))!;
    this.cb?.({
      type: 'result',
      generation,
      ...buildForRevision(rev, graph),
    });
  }
}

function validGraph(rev: number): Graph {
  // 直接构造合法最小图
  return {
    revision: rev,
    nodes: [
      { id: 't', kind: 'time', x: 0, y: 0 },
      { id: 'o', kind: 'output', x: 10, y: 10 },
    ],
    edges: [
      { id: 'e', from: { node: 't', port: 'out' }, to: { node: 'o', port: 'color' } },
    ],
  };
}

describe('WebGL 上下文丢失与恢复', () => {
  it('丢失时标明预览失效，恢复后重建当前合法图（重新生成并编译）', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);

    const sink = new ManualSink();
    const adapter = {
      compile: vi.fn((generation: number, revision: number, source: string) => {
        const outcome = renderer.prepareFragment(source);
        if (outcome.ok) {
          return Promise.resolve({
            generation,
            revision,
            ok: true,
            errors: [],
            commit: () => outcome.prepared.commit(),
            discard: () => outcome.prepared.discard(),
          });
        }
        renderer.deactivate();
        return Promise.resolve({ generation, revision, ...outcome });
      }),
      deactivate: () => renderer.deactivate(),
    };
    const pipe = new GraphPipeline(validGraph(3), sink, adapter);
    const lossSpy = vi.fn();
    renderer.onLoss(lossSpy);
    // 与 App 相同的接线：渲染器丢失/恢复事件驱动 pipeline
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());

    pipe.submit(validGraph(3));
    sink.respond(1, 3);
    await Promise.resolve();
    expect(pipe.status.phase).toBe('ready');
    const programsAfterFirst = gl.programCount;
    expect(programsAfterFirst).toBeGreaterThan(0);

    // 上下文丢失：旧画面失效，pipeline 标明 context-lost
    renderer.simulateLossForTests();
    expect(lossSpy).toHaveBeenCalledOnce();
    expect(renderer.contextLost).toBe(true);
    if (pipe.status.phase !== 'context-lost') throw new Error('expected lost');
    expect(rev(pipe)).toBe(3);
    gl.lost = true; // 模拟真实环境中 GL 调用失败
    renderer.renderOnce(); // 不绘制、不抛错
    expect(gl.drawCount).toBe(0);

    // 丢失期间到达的迟到 Worker 结果不得复活预览
    sink.respond(1, 3);
    expect(pipe.status.phase).toBe('context-lost');

    // 恢复：浏览器提供同一 canvas 的全新 GL 状态
    gl.lost = false;
    renderer.simulateRestoreForTests();
    expect(renderer.contextLost).toBe(false);
    // pipeline 必须对当前修订重新发起完整构建；代际与 revision 都必须匹配
    expect(sink.requested).toContainEqual({ generation: 2, revision: 3 });
    sink.respond(2, 3);
    await Promise.resolve();
    if (phase(pipe) !== 'ready') throw new Error(`expected ready, got ${phase(pipe)}`);
    expect(rev(pipe)).toBe(3);
    // 恢复后重新编译了程序，而非沿用旧的
    expect(gl.programCount).toBeGreaterThan(programsAfterFirst);

    // 恢复后可正常导出，快照指向恢复所用修订
    const snap = pipe.captureExport(() => renderer.captureDataURL());
    expect(snap.revision).toBe(3);
  });

  it('丢失期间用户编辑：恢复后重建的是最新修订而不是旧画面', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);
    const sink = new ManualSink();
    const adapter = {
      compile: vi.fn((generation: number, revision: number, source: string) => {
        const outcome = renderer.prepareFragment(source);
        if (outcome.ok) {
          return Promise.resolve({
            generation,
            revision,
            ok: true,
            errors: [],
            commit: () => outcome.prepared.commit(),
            discard: () => outcome.prepared.discard(),
          });
        }
        renderer.deactivate();
        return Promise.resolve({ generation, revision, ...outcome });
      }),
      deactivate: () => renderer.deactivate(),
    };
    const pipe = new GraphPipeline(validGraph(2), sink, adapter);
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());
    pipe.submit(validGraph(2));
    sink.respond(1, 2);
    await Promise.resolve();
    expect(pipe.status.phase).toBe('ready');

    renderer.simulateLossForTests();
    if (pipe.status.phase !== 'context-lost') throw new Error('expected lost');

    // 用户继续编辑到修订 5
    pipe.submit(validGraph(5));
    if (pipe.status.phase !== 'context-lost') throw new Error('still lost');
    expect(rev(pipe)).toBe(5);

    renderer.simulateRestoreForTests();
    sink.respond(3, 5);
    await Promise.resolve();
    if (phase(pipe) !== 'ready') throw new Error('expected ready');
    expect(rev(pipe)).toBe(5);
  });

  it('恢复前排队的同修订旧编译结果不能在恢复后短暂上屏', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);
    const sink = new ManualSink();
    const oldCompile = deferred<{
      generation: number;
      revision: number;
      ok: boolean;
      errors: string[];
      commit: () => void;
      discard: () => void;
    }>();
    let oldCommitted = false;
    const adapter = {
      compile: vi.fn((generation: number, revision: number, source: string) => {
        if (generation === 1) {
          return oldCompile.promise;
        }
        const outcome = renderer.prepareFragment(source);
        if (!outcome.ok) throw new Error(outcome.errors[0]);
        return Promise.resolve({
          generation,
          revision,
          ok: true,
          errors: [],
          commit: () => outcome.prepared.commit(),
          discard: () => outcome.prepared.discard(),
        });
      }),
      deactivate: () => renderer.deactivate(),
    };
    const pipe = new GraphPipeline(validGraph(3), sink, adapter);
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());

    pipe.submit(validGraph(3)); // generation 1
    sink.respond(1, 3);
    expect(pipe.status.phase).toBe('compiling');

    renderer.simulateLossForTests();
    gl.lost = false;
    renderer.simulateRestoreForTests();
    expect(pipe.status.phase).toBe('building');

    // 恢复前 generation 1 的编译结果迟到
    oldCompile.resolve({
      generation: 1,
      revision: 3,
      ok: true,
      errors: [],
      commit: () => {
        oldCommitted = true;
      },
      discard: () => {},
    });
    await Promise.resolve();
    expect(oldCommitted).toBe(false);
    expect(pipe.status.phase).toBe('building');
    expect(gl.drawCount).toBe(0);

    // 只有恢复后 generation 2 的完整流程可以上屏
    sink.respond(2, 3);
    await Promise.resolve();
    expect(pipe.status.phase).toBe('ready');
    expect(rev(pipe)).toBe(3);
  });
});
