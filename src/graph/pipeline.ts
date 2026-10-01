import { Graph } from './types';
import { GraphIssue } from './validate';
import { BuildResult, WorkerInMessage, WorkerOutMessage } from './protocol';

export type RevisionStatus =
  | { phase: 'idle' }
  | { phase: 'building'; revision: number }
  | {
      phase: 'compiling';
      revision: number;
      fragmentSource: string;
      order: string[];
    }
  | {
      phase: 'ready';
      revision: number;
      fragmentSource: string;
      order: string[];
    }
  | {
      phase: 'invalid-graph';
      revision: number;
      issues: GraphIssue[];
    }
  | {
      phase: 'compile-error';
      revision: number;
      errors: string[];
      fragmentSource: string;
    }
  | { phase: 'context-lost'; revision: number };

export interface PreviewSnapshot {
  revision: number;
  graph: Graph;
  fragmentSource: string;
  dataUrl: string;
  exportedAt: string;
}

/** “对某修订做校验+生成”的执行器（生产环境是 Worker，测试可注入假实现）。 */
export interface BuildSink {
  request(graph: Graph, revision: number): void;
  onResult(cb: (result: BuildResult) => void): void;
}

export class WorkerBuildSink implements BuildSink {
  private worker: Worker;
  constructor(worker: Worker) {
    this.worker = worker;
  }
  request(graph: Graph, revision: number) {
    const msg: WorkerInMessage = { type: 'build', revision, graph };
    this.worker.postMessage(msg);
  }
  onResult(cb: (result: BuildResult) => void) {
    const handler = (ev: MessageEvent<WorkerOutMessage>) => cb(ev.data);
    this.worker.addEventListener('message', handler);
  }
}

/** “编译某修订的 GLSL”的执行器（生产环境封装 WebGLRenderer，测试可注入）。 */
export interface CompileAdapter {
  compile(revision: number, source: string): Promise<{ revision: number; ok: boolean; errors: string[] }>;
}

type Listener = () => void;

/**
 * 修订流水线：编辑 → 构建（Worker 排序/生成）→ 编译 GLSL → 预览就绪。
 * 所有异步结果只在 revision === 当前修订时才被采用，
 * 迟到的 Worker 结果或编译结果一律丢弃，绝不覆盖较新修订。
 */
export class GraphPipeline {
  private graph: Graph;
  private sink: BuildSink;
  private compileAdapter: CompileAdapter;
  private currentRevision: number;
  private lastRequested = -1;
  private lost = false;
  status: RevisionStatus = { phase: 'idle' };
  private listeners = new Set<Listener>();
  private snapshot: PreviewSnapshot | null = null;

  constructor(graph: Graph, sink: BuildSink, compileAdapter: CompileAdapter) {
    this.graph = graph;
    this.currentRevision = graph.revision;
    this.sink = sink;
    this.compileAdapter = compileAdapter;
    sink.onResult((r) => this.handleBuildResult(r));
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  getSnapshot(): PreviewSnapshot | null {
    return this.snapshot;
  }

  /** 编辑后提交新修订。只对最新修订发起构建。 */
  submit(graph: Graph) {
    this.graph = graph;
    this.currentRevision = graph.revision;
    if (this.lastRequested === graph.revision && this.lastRequested !== -1) return;
    this.lastRequested = graph.revision;
    if (this.lost) {
      // 上下文丢失期间只记录最新修订，不发起构建；恢复时统一重建
      this.status = { phase: 'context-lost', revision: graph.revision };
      this.emit();
      return;
    }
    this.status = { phase: 'building', revision: graph.revision };
    this.emit();
    this.sink.request(graph, graph.revision);
  }

  private handleBuildResult(result: BuildResult) {
    // 迟到的 Worker 结果：修订号落后于当前修订，直接丢弃
    if (result.revision !== this.currentRevision) return;
    // 上下文丢失期间到达的结果不能复活预览
    if (this.lost) return;

    if (!result.ok) {
      this.status = {
        phase: 'invalid-graph',
        revision: result.revision,
        issues: result.issues,
      };
      this.emit();
      return;
    }
    const source = result.fragmentSource!;
    this.status = {
      phase: 'compiling',
      revision: result.revision,
      fragmentSource: source,
      order: result.order ?? [],
    };
    this.emit();

    this.compileAdapter
      .compile(result.revision, source)
      .then((outcome) => {
        // 编译期间用户可能继续编辑：迟到的编译结果同样丢弃
        if (outcome.revision !== this.currentRevision) return;
        if (this.lost) return;
        if (outcome.ok) {
          this.status = {
            phase: 'ready',
            revision: outcome.revision,
            fragmentSource: source,
            order: this.status.phase === 'compiling' ? this.status.order : [],
          };
        } else {
          this.status = {
            phase: 'compile-error',
            revision: outcome.revision,
            errors: outcome.errors,
            fragmentSource: source,
          };
        }
        this.emit();
      })
      .catch((err: unknown) => {
        if (result.revision !== this.currentRevision) return;
        this.status = {
          phase: 'compile-error',
          revision: result.revision,
          errors: [err instanceof Error ? err.message : String(err)],
          fragmentSource: source,
        };
        this.emit();
      });
  }

  /** 预览截图 + 导出数据绑定到同一修订。 */
  captureExport(capture: () => string): PreviewSnapshot {
    if (this.status.phase !== 'ready') {
      throw new Error('当前修订尚未就绪，无法导出');
    }
    // 使用发起捕获那一刻状态对应的修订与图，防止后续编辑串改
    const rev = this.status.revision;
    if (this.snapshot && this.snapshot.revision === rev) return this.snapshot;
    const dataUrl = capture();
    this.snapshot = {
      revision: rev,
      graph: structuredClone(toPlainGraph(this.graph)),
      fragmentSource: this.status.fragmentSource,
      dataUrl,
      exportedAt: new Date().toISOString(),
    };
    return this.snapshot;
  }

  invalidateSnapshot() {
    this.snapshot = null;
  }

  /** WebGL 上下文丢失：标明预览失效。 */
  notifyContextLost() {
    this.lost = true;
    this.status = { phase: 'context-lost', revision: this.currentRevision };
    this.emit();
  }

  /**
   * 上下文恢复：以当前修订的状态重建预览，而不是显示旧画面。
   * 无论之前构建结果是否回来过，都对当前修订重新走一遍
   * Worker 校验/生成 → GLSL 编译 的完整流程。
   */
  notifyContextRestored() {
    if (!this.lost) return;
    this.lost = false;
    const rev = this.currentRevision;
    this.lastRequested = -1; // 强制重新发起
    this.status = { phase: 'building', revision: rev };
    this.emit();
    this.sink.request(this.graph, rev);
    this.lastRequested = rev;
  }
}

/** 导出时去掉不可序列化内容（当前模型全是纯数据，这里做防御）。 */
export function toPlainGraph(graph: Graph): Graph {
  return {
    revision: graph.revision,
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      x: n.x,
      y: n.y,
      params: n.params ? structuredClone(n.params) : undefined,
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      from: { ...e.from },
      to: { ...e.to },
    })),
  };
}
