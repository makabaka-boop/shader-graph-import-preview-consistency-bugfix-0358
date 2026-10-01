import { Graph } from './types';
import { GraphIssue } from './validate';
import { BuildResult, BuildToken, WorkerInMessage, WorkerOutMessage } from './protocol';

export type { BuildToken };

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
  request(graph: Graph, token: BuildToken): void;
  onResult(cb: (result: BuildResult) => void): void;
}

export class WorkerBuildSink implements BuildSink {
  private worker: Worker;
  constructor(worker: Worker) {
    this.worker = worker;
  }
  request(graph: Graph, token: BuildToken) {
    const msg: WorkerInMessage = { type: 'build', token, revision: graph.revision, graph };
    this.worker.postMessage(msg);
  }
  onResult(cb: (result: BuildResult) => void) {
    const handler = (ev: MessageEvent<WorkerOutMessage>) => cb(ev.data);
    this.worker.addEventListener('message', handler);
  }
}

/** “编译某修订的 GLSL”的执行器（生产环境封装 WebGLRenderer，测试可注入）。
 *  token 随请求透传，结果按 token 认领，绝不按修订号认领；
 *  apply 把已编译的程序真正提交上屏，只在代次确认后调用。 */
export interface CompileOutcomeResult {
  token: BuildToken;
  revision: number;
  ok: boolean;
  errors: string[];
  apply(): Promise<{ ok: boolean; errors?: string[] }>;
}

export interface CompileAdapter {
  compile(
    token: BuildToken,
    revision: number,
    source: string,
  ): Promise<CompileOutcomeResult>;
}

type Listener = () => void;

/**
 * 修订流水线：编辑 → 构建（Worker 排序/生成）→ 编译 GLSL → 预览就绪。
 *
 * 陈旧判定有两个维度：
 *  - token（构建代次）：会话内单调递增、绝不重复。所有异步结果
 *    （Worker 结果、GLSL 编译结果）只有 token 与当前代次相同才会被采用。
 *    这样即使新导入的图与旧图【修订号相同】，旧图在路上的结果也无法冒充新图。
 *  - 结构签名：忽略节点坐标的图内容指纹。修订号相同但结构/参数不同的导入图
 *    必须重新构建；只拖动节点（签名不变）则只同步图引用，不重新生成/编译。
 */
export class GraphPipeline {
  private graph: Graph;
  private sink: BuildSink;
  private compileAdapter: CompileAdapter;
  private currentRevision: number;
  private tokenSeq = 0;
  private activeToken: BuildToken | null = null;
  /** 最近一次【真正发起构建】的结构签名，用于识别同修订号的不同导入图。 */
  private lastBuiltSignature: string | null = null;
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

  /**
   * 同步当前图。任何图引用变化都必须到达这里：
   *  - 结构/参数变化（结构签名变化）→ 新一代次，重新构建；
   *  - 仅移动节点（修订号、签名都不变）→ 只更新图引用并失效导出缓存，
   *    预览/GLSL 不变，但下次导出拿到的是新布局；
   *  - 导入同修订号的不同图 → 签名不同，按新内容重新构建。
   */
  submit(graph: Graph) {
    this.graph = graph;
    this.currentRevision = graph.revision;

    const signature = structureSignature(graph);
    if (signature === this.lastBuiltSignature && this.activeToken !== null) {
      // 内容（忽略坐标）与当前在用代次一致：纯视图变更，不重新生成。
      // 任何引用变化都意味着旧快照的 graph 可能已过期（节点被拖动），必须失效。
      this.invalidateSnapshot();
      return;
    }

    this.invalidateSnapshot();
    const token = ++this.tokenSeq;
    this.activeToken = token;
    this.lastBuiltSignature = signature;

    if (this.lost) {
      // 上下文丢失期间只记录最新代次，不发起构建；恢复时以当前代次统一重建
      this.status = { phase: 'context-lost', revision: graph.revision };
      this.emit();
      return;
    }
    this.status = { phase: 'building', revision: graph.revision };
    this.emit();
    this.sink.request(graph, token);
  }

  private handleBuildResult(result: BuildResult) {
    // 陈旧的 Worker 结果：代次落后或属于已被替换的导入图，直接丢弃。
    // 注意：不能只比对修订号——新旧图可能恰好同修订号。
    if (result.token !== this.activeToken) return;
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
    const order = result.order ?? [];
    this.status = {
      phase: 'compiling',
      revision: result.revision,
      fragmentSource: source,
      order,
    };
    this.emit();

    this.compileAdapter
      .compile(result.token, result.revision, source)
      .then(async (outcome) => {
        // 编译期间用户可能继续编辑或导入：只有发起方代次仍为当前代次才采用
        if (outcome.token !== this.activeToken) return;
        if (this.lost) return;
        // 编译成功后、上屏前再确认一次代次（apply 可能异步）：
        // 新程序只有在仍属于当前代次时才允许进入画面。
        if (!outcome.ok) {
          this.status = {
            phase: 'compile-error',
            revision: outcome.revision,
            errors: outcome.errors,
            fragmentSource: source,
          };
          this.emit();
          return;
        }
        const applied = await outcome.apply();
        if (result.token !== this.activeToken || this.lost) return;
        if (applied.ok) {
          this.status = {
            phase: 'ready',
            revision: outcome.revision,
            fragmentSource: source,
            order,
          };
        } else {
          this.status = {
            phase: 'compile-error',
            revision: outcome.revision,
            errors: applied.errors ?? ['着色器未能提交上屏'],
            fragmentSource: source,
          };
        }
        this.emit();
      })
      .catch((err: unknown) => {
        if (result.token !== this.activeToken) return;
        if (this.lost) return;
        this.status = {
          phase: 'compile-error',
          revision: result.revision,
          errors: [err instanceof Error ? err.message : String(err)],
          fragmentSource: source,
        };
        this.emit();
      });
  }

  /**
   * 预览截图 + 导出数据绑定到同一次就绪结果。
   * graph / fragmentSource / dataUrl 必须同属当前代次：图引用可能因为拖动节点
   * 而更新（布局变化但着色器不变），此时不复用旧截图包，重新打包以带上新布局。
   */
  captureExport(capture: () => string): PreviewSnapshot {
    if (this.status.phase !== 'ready') {
      throw new Error('当前修订尚未就绪，无法导出');
    }
    const status = this.status;
    // 防御：当前图修订号必须与就绪状态一致（正常流程下结构变化必已重建）。
    if (status.revision !== this.graph.revision) {
      throw new Error('页面与预览不属于同一修订，无法导出');
    }
    // 已有缓存必须同时满足：同修订、同结构、同布局（坐标指纹），才能复用。
    if (
      this.snapshot &&
      this.snapshot.revision === status.revision &&
      this.snapshot.fragmentSource === status.fragmentSource &&
      layoutSignature(this.snapshot.graph) === layoutSignature(this.graph)
    ) {
      return this.snapshot;
    }
    const dataUrl = capture();
    this.snapshot = {
      revision: status.revision,
      graph: structuredClone(toPlainGraph(this.graph)),
      fragmentSource: status.fragmentSource,
      dataUrl,
      exportedAt: new Date().toISOString(),
    };
    return this.snapshot;
  }

  invalidateSnapshot() {
    this.snapshot = null;
  }

  /** WebGL 上下文丢失：标明预览失效，旧截图包一并作废。 */
  notifyContextLost() {
    if (this.lost) return;
    this.lost = true;
    this.activeToken = null;
    this.lastBuiltSignature = null;
    this.invalidateSnapshot();
    this.status = { phase: 'context-lost', revision: this.currentRevision };
    this.emit();
  }

  /**
   * 上下文恢复：以当前图【全新代次】重建预览，而不是显示旧画面。
   * 无论之前构建结果是否回来过，都对当前图重新走一遍
   * Worker 校验/生成 → GLSL 编译 的完整流程；旧代次的迟到结果一律无法匹配。
   */
  notifyContextRestored() {
    if (!this.lost) return;
    this.lost = false;
    this.invalidateSnapshot();
    const token = ++this.tokenSeq;
    this.activeToken = token;
    this.lastBuiltSignature = structureSignature(this.graph);
    this.status = { phase: 'building', revision: this.currentRevision };
    this.emit();
    this.sink.request(this.graph, token);
  }
}

/**
 * 结构签名：忽略节点坐标的图内容指纹（节点种类/参数/连线）。
 * 移动节点不改变签名；导入一份“同修订号但内容不同”的图会改变签名。
 */
export function structureSignature(graph: Graph): string {
  const nodes = graph.nodes
    .map((n) => `${n.id}:${n.kind}:${n.params ? JSON.stringify(n.params) : ''}`)
    .sort()
    .join('|');
  const edges = graph.edges
    .map((e) => `${e.id}=${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`)
    .sort()
    .join('|');
  return `r${graph.revision}#n[${nodes}]#e[${edges}]`;
}

/** 布局指纹：连同坐标一起，用于判断导出缓存是否因拖动而过期。 */
function layoutSignature(graph: Graph): string {
  return structureSignature(graph) +
    `#x[${graph.nodes.map((n) => `${n.id}@${n.x},${n.y}`).sort().join('|')}]`;
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
