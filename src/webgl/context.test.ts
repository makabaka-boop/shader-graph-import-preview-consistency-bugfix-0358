import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WebGLRenderer } from '../webgl/renderer';
import { GraphPipeline, RevisionStatus } from '../graph/pipeline';
import { BuildSink } from '../graph/pipeline';
import { BuildResult, BuildToken } from '../graph/protocol';
import { buildForRevision } from '../graph/build';
import { Graph } from '../graph/types';

// node 环境无 rAF：提供空桩（恢复路径会调用 start）
beforeEach(() => {
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
});

function rev(p: GraphPipeline): number {
  return (p.status as Extract<RevisionStatus, { revision: number }>).revision;
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

interface PendingRequest {
  token: BuildToken;
  revision: number;
  graph: Graph;
}

class ManualSink implements BuildSink {
  requested: PendingRequest[] = [];
  private cb: ((r: BuildResult) => void) | null = null;
  request(graph: Graph, token: BuildToken) {
    this.requested.push({ token, revision: graph.revision, graph });
  }
  onResult(cb: (r: BuildResult) => void) {
    this.cb = cb;
  }
  /** 回送最近一次请求的结果（带该次请求的 token）。 */
  respondLast() {
    const req = this.requested[this.requested.length - 1];
    this.respond(req.token, req.revision);
  }
  respond(token: BuildToken, revision: number) {
    const req = this.requested.find((r) => r.token === token);
    const graph = req?.graph;
    if (!graph) throw new Error(`未发出过 token=${token} 的构建`);
    this.cb?.({ type: 'result', token, ...buildForRevision(revision, graph) });
  }
}

/** 与生产 compileAdapter 同构的测试适配器：编译到 pending，apply 时才提交上屏。 */
function makeRendererAdapter(renderer: WebGLRenderer) {
  return {
    compile: vi.fn((token: BuildToken, revision: number, source: string) => {
      const outcome = renderer.compileFragment(source);
      if (!outcome.ok) renderer.stop();
      return Promise.resolve({
        token,
        revision,
        ok: outcome.ok,
        errors: outcome.errors,
        apply: () => {
          if (!outcome.ok) {
            return Promise.resolve({ ok: false, errors: outcome.errors });
          }
          const committed = renderer.commitPending();
          if (!committed) {
            return Promise.resolve({
              ok: false,
              errors: ['上下文已失效，未提交上屏'],
            });
          }
          renderer.start();
          return Promise.resolve({ ok: true });
        },
      });
    }),
  };
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

/** 与 validGraph 不同结构、但使用同一修订号的图（模拟“恢复时旧预览重现”）。 */
function otherGraphSameRevision(rev: number): Graph {
  return {
    revision: rev,
    nodes: [
      { id: 'c', kind: 'const_vec3', x: 1, y: 1, params: { rgb: [0, 1, 0] } },
      { id: 'o2', kind: 'output', x: 2, y: 2 },
    ],
    edges: [
      { id: 'x', from: { node: 'c', port: 'out' }, to: { node: 'o2', port: 'color' } },
    ],
  };
}

describe('WebGL 上下文丢失与恢复', () => {
  it('丢失时标明预览失效，恢复后重建当前合法图（重新生成并编译）', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);

    const sink = new ManualSink();
    const adapter = makeRendererAdapter(renderer);
    const pipe = new GraphPipeline(validGraph(3), sink, adapter);
    const lossSpy = vi.fn();
    renderer.onLoss(lossSpy);
    // 与 App 相同的接线：渲染器丢失/恢复事件驱动 pipeline
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());

    pipe.submit(validGraph(3));
    sink.respondLast();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
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

    // 丢失期间到达的迟到 Worker 结果不得复活预览（旧 token 已作废）
    const staleToken = sink.requested[0].token;
    sink.respond(staleToken, 3);
    expect(pipe.status.phase).toBe('context-lost');

    // 恢复：浏览器提供同一 canvas 的全新 GL 状态。
    gl.lost = false;
    gl.programCount = 0; // 只统计恢复后的程序创建
    renderer.simulateRestoreForTests();
    expect(renderer.contextLost).toBe(false);
    // 渲染器不得自行重放旧源码：恢复瞬间没有任何片段程序被创建
    expect(gl.programCount).toBe(0);
    // pipeline 必须对当前图以【全新代次】重新发起完整构建
    const restoreToken = sink.requested[sink.requested.length - 1].token;
    expect(restoreToken).not.toBe(staleToken);
    sink.respondLast();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    expect(rev(pipe)).toBe(3);
    // 恢复后重新编译并提交了程序，而非沿用旧的
    expect(gl.programCount).toBe(1);

    // 恢复后可正常导出，快照指向恢复所用修订
    const snap = pipe.captureExport(() => renderer.captureDataURL());
    expect(snap.revision).toBe(3);
  });

  it('丢失期间用户编辑：恢复后重建的是最新修订而不是旧画面', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);
    const sink = new ManualSink();
    const adapter = makeRendererAdapter(renderer);
    const pipe = new GraphPipeline(validGraph(2), sink, adapter);
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());
    pipe.submit(validGraph(2));
    sink.respondLast();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));

    renderer.simulateLossForTests();
    if (pipe.status.phase !== 'context-lost') throw new Error('expected lost');

    // 用户继续编辑到修订 5
    pipe.submit(validGraph(5));
    if (pipe.status.phase !== 'context-lost') throw new Error('still lost');
    expect(rev(pipe)).toBe(5);

    renderer.simulateRestoreForTests();
    sink.respondLast();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    expect(rev(pipe)).toBe(5);
  });

  it('恢复后同一修订号的旧代次迟到结果不得重现旧预览', async () => {
    const gl = new FakeGL2();
    const canvas = fakeCanvas(gl);
    const renderer = new WebGLRenderer(canvas);
    const sink = new ManualSink();
    const adapter = makeRendererAdapter(renderer);
    // 当前画面：revision 3 的 A 图
    const pipe = new GraphPipeline(validGraph(3), sink, adapter);
    renderer.onLoss(() => pipe.notifyContextLost());
    renderer.onRestore(() => pipe.notifyContextRestored());
    pipe.submit(validGraph(3));
    sink.respondLast();
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));

    renderer.simulateLossForTests();
    // 丢失期间画布换成同样标着 revision 3 的 B 图（结构不同）
    pipe.submit(otherGraphSameRevision(3));
    expect(rev(pipe)).toBe(3);

    renderer.simulateRestoreForTests();
    // 恢复重发的是 B 图（新代次）；先让恢复前任何旧代次迟到结果到达
    const restoreReq = sink.requested[sink.requested.length - 1];
    const oldReqs = sink.requested.filter((r) => r.token !== restoreReq.token);
    expect(oldReqs.length).toBeGreaterThan(0);
    for (const req of oldReqs) sink.respond(req.token, 3);
    expect(pipe.status.phase).toBe('building'); // 旧代次结果未复活任何画面

    sink.respondLast(); // B 图结果
    await vi.waitFor(() => expect(pipe.status.phase).toBe('ready'));
    // 就绪后导出的图数据是 B 图而非旧的 A 图
    const snap = pipe.captureExport(() => 'data:image/png;base64,B');
    expect(snap.graph.nodes.map((n) => n.id).sort()).toEqual(['c', 'o2']);
    expect(snap.dataUrl).toBe('data:image/png;base64,B');
  });
});
