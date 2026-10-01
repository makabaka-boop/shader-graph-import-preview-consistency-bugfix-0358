import { Graph } from './types';
import { GraphIssue } from './validate';
import { BuildResult, WorkerInMessage, WorkerOutMessage } from './protocol';

export type RevisionStatus =
  | { phase: 'idle' }
  | { phase: 'building'; generation: number; revision: number }
  | {
      phase: 'compiling';
      generation: number;
      revision: number;
      fragmentSource: string;
      order: string[];
    }
  | {
      phase: 'ready';
      generation: number;
      revision: number;
      fragmentSource: string;
      order: string[];
    }
  | {
      phase: 'invalid-graph';
      generation: number;
      revision: number;
      issues: GraphIssue[];
    }
  | {
      phase: 'compile-error';
      generation: number;
      revision: number;
      errors: string[];
      fragmentSource: string;
    }
  | { phase: 'context-lost'; generation: number; revision: number };

export interface PreviewSnapshot {
  revision: number;
  graph: Graph;
  fragmentSource: string;
  dataUrl: string;
  exportedAt: string;
}

/** “对某代际做校验+生成”的执行器（生产环境是 Worker，测试可注入假实现）。 */
export interface BuildSink {
  request(graph: Graph, generation: number, revision: number): void;
  onResult(cb: (result: BuildResult) => void): void;
}

export class WorkerBuildSink implements BuildSink {
  private worker: Worker;
  constructor(worker: Worker) {
    this.worker = worker;
  }
  request(graph: Graph, generation: number, revision: number) {
    const msg: WorkerInMessage = { type: 'build', generation, revision, graph };
    this.worker.postMessage(msg);
  }
  onResult(cb: (result: BuildResult) => void) {
    const handler = (ev: MessageEvent<WorkerOutMessage>) => cb(ev.data);
    this.worker.addEventListener('message', handler);
  }
}

export interface CompileResult {
  generation: number;
  revision: number;
  ok: boolean;
  errors: string[];
  /** 只有流水线确认该结果为当前内容后才调用，真正切换 GL 程序。 */
  commit?: () => void;
  /** 结果过期时删除已编译但未显示的程序。 */
  discard?: () => void;
}

/** “编译某代际 GLSL”的执行器（生产环境封装 WebGLRenderer，测试可注入）。 */
export interface CompileAdapter {
  compile(
    generation: number,
    revision: number,
    source: string,
  ): Promise<CompileResult>;
  /** 新内容进入构建/旧内容失效时撤下旧画面。 */
  deactivate?: () => void;
}

type Listener = () => void;

/**
 * 内容代际流水线：编辑/导入 → 构建（Worker 排序/生成）→ 暂存 GLSL 编译 →
 * 代际校验通过后提交预览。
 *
 * revision 存在导入文件里，两份不同的图可能相同；因此异步匹配必须使用页面内
 * 单调递增的 generation。移动节点只更新实时图数据，不改变内容代际，也不会
 * 触发重建；导出时直接捕获当前页面布局。
 */
export class GraphPipeline {
  private graph: Graph;
  private sink: BuildSink;
  private compileAdapter: CompileAdapter;
  private currentRevision: number;
  private generation = 0;
  private lost = false;
  status: RevisionStatus = { phase: 'idle' };
  private listeners = new Set<Listener>();

  constructor(graph: Graph, sink: BuildSink, compileAdapter: CompileAdapter) {
    this.graph = graph;
    this.currentRevision = graph.revision;
    this.sink = sink;
    this.compileAdapter = compileAdapter;
    sink.onResult((r) => this.handleBuildResult(r));
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    this.listeners.forEach((cb) => cb());
  }

  /**
   * 提交一份图。structural=false 表示只移动节点：不重建、不改变预览，
   * 但把最新布局交给后续导出。
   */
  submit(graph: Graph, structural = true) {
    this.graph = graph;
    this.currentRevision = graph.revision;

    if (!structural) {
      if (this.status.phase !== 'idle') {
        this.status = { ...this.status, revision: graph.revision };
        this.emit();
      }
      return;
    }

    this.advanceGeneration();
    this.requestCurrentGraph();
  }

  private advanceGeneration() {
    this.generation += 1;
  }

  private requestCurrentGraph() {
    const generation = this.generation;
    const revision = this.currentRevision;
    if (this.lost) {
      // 上下文丢失期间只记录最新内容，不发起构建；恢复时统一重建
      this.status = { phase: 'context-lost', generation, revision };
      this.emit();
      return;
    }

    // 旧 GL 程序立即撤下；Worker/编译未完成期间不得让旧颜色冒充新图。
    this.compileAdapter.deactivate?.();
    this.status = { phase: 'building', generation, revision };
    this.emit();
    this.sink.request(this.graph, generation, revision);
  }

  private isCurrentBuild(result: BuildResult) {
    return (
      result.generation === this.generation &&
      result.revision === this.currentRevision
    );
  }

  private handleBuildResult(result: BuildResult) {
    // 导入/编辑前的 Worker 结果，即使 revision 相同也必须丢弃
    if (!this.isCurrentBuild(result) || this.lost) return;

    const generation = result.generation;
    if (!result.ok) {
      this.compileAdapter.deactivate?.();
      this.status = {
        phase: 'invalid-graph',
        generation,
        revision: result.revision,
        issues: result.issues,
      };
      this.emit();
      return;
    }

    const source = result.fragmentSource!;
    const order = result.order ?? [];
    this.status = {
      phase: 'compiling',
      generation,
      revision: result.revision,
      fragmentSource: source,
      order,
    };
    this.emit();

    this.compileAdapter
      .compile(generation, result.revision, source)
      .then((outcome) => {
        if (outcome.generation !== this.generation || this.lost) {
          outcome.discard?.();
          return;
        }
        if (!outcome.ok) {
          this.compileAdapter.deactivate?.();
          this.status = {
            phase: 'compile-error',
            generation,
            revision: outcome.revision,
            errors: outcome.errors,
            fragmentSource: source,
          };
          this.emit();
          return;
        }

        // 通过最终代际检查后才让暂存程序上屏，消除同步编译的微任务窗口。
        outcome.commit?.();
        this.status = {
          phase: 'ready',
          generation,
          revision: outcome.revision,
          fragmentSource: source,
          order:
            this.status.phase === 'compiling' && this.status.generation === generation
              ? this.status.order
              : order,
        };
        this.emit();
      })
      .catch((err: unknown) => {
        if (generation !== this.generation || this.lost) return;
        this.compileAdapter.deactivate?.();
        this.status = {
          phase: 'compile-error',
          generation,
          revision: result.revision,
          errors: [err instanceof Error ? err.message : String(err)],
          fragmentSource: source,
        };
        this.emit();
      });
  }

  /**
   * 预览截图与图数据在同一次调用中捕获，且图使用发起捕获时的最新页面状态。
   * 不复用旧快照：纯移动节点不递增 revision，但导出布局必须跟随当前页面。
   */
  captureExport(capture: () => string): PreviewSnapshot {
    if (this.status.phase !== 'ready') {
      throw new Error('当前内容尚未就绪，无法导出');
    }
    const status = this.status;
    const dataUrl = capture();
    return {
      revision: status.revision,
      graph: structuredClone(toPlainGraph(this.graph)),
      fragmentSource: status.fragmentSource,
      dataUrl,
      exportedAt: new Date().toISOString(),
    };
  }

  /** WebGL 上下文丢失：标明预览失效。 */
  notifyContextLost() {
    this.lost = true;
    this.status = {
      phase: 'context-lost',
      generation: this.generation,
      revision: this.currentRevision,
    };
    this.emit();
  }

  /**
   * 上下文恢复：以当前图开启新的代际，重新走 Worker 生成 → GLSL 编译 →
   * commit 的完整流程。恢复事件前排队的旧结果代际更小，不能复活旧预览。
   */
  notifyContextRestored() {
    if (!this.lost) return;
    this.lost = false;
    this.advanceGeneration();
    this.requestCurrentGraph();
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
