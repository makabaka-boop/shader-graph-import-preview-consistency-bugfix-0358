import { VERTEX_SHADER } from '../graph/glslgen';

export interface CompileOutcome {
  ok: boolean;
  errors: string[];
}

type Listener = () => void;

/**
 * WebGL2 渲染器：负责编译页面生成的片段着色器并在全屏三角形上执行。
 * 显式处理 webglcontextlost / webglcontextrestored：
 * 丢失后停止渲染并上抛事件；恢复后只重建 GL 骨架，【绝不自行重放旧源码】，
 * 真正的着色器由 pipeline 对当前图重新生成、编译并确认代次后提交，
 * 因此恢复后不可能闪回旧修订的画面。
 *
 * 编译分两步，避免迟到编译直接换屏：
 *  - compileFragment 只把链接好的程序放进 pending，不动正在显示的程序；
 *  - commitPending 由 pipeline 在确认编译结果属于当前代次后调用，
 *    新程序此时才上屏；被丢弃的迟到编译永远不会显示。
 */
export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  /** 已编译链接、但尚未经 pipeline 代次确认的程序。 */
  private pendingProgram: WebGLProgram | null = null;
  private pendingUTimeLoc: WebGLUniformLocation | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTimeLoc: WebGLUniformLocation | null = null;
  private rafId = 0;
  private startTime = performance.now();
  private running = false;
  private lost = false;

  private lossListeners = new Set<Listener>();
  private restoreListeners = new Set<Listener>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.initResources();
    this.bindContextEvents();
  }

  get contextLost(): boolean {
    return this.lost;
  }

  onLoss(cb: Listener): () => void {
    this.lossListeners.add(cb);
    return () => this.lossListeners.delete(cb);
  }

  onRestore(cb: Listener): () => void {
    this.restoreListeners.add(cb);
    return () => this.restoreListeners.delete(cb);
  }

  private handleLoss = (e: Event) => {
    e.preventDefault(); // 请求浏览器允许恢复
    this.lost = true;
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    // 全部 GL 资源随上下文一起失效，清空引用：既不能继续显示旧画面，
    // 也不能在恢复时把旧源码/旧程序重新提交。
    this.program = null;
    this.pendingProgram = null;
    this.pendingUTimeLoc = null;
    this.vao = null;
    this.builtinVS = null;
    this.uTimeLoc = null;
    this.lossListeners.forEach((cb) => cb());
  };

  private handleRestore = () => {
    this.lost = false;
    this.startTime = performance.now();
    // 仅重建与具体着色器无关的 GL 骨架；旧片段程序引用已在丢失时清空，
    // 这里绝不重新编译旧片段着色器——pipeline 收到恢复事件后会对当前图
    // 走完整 Worker 生成 → 编译 → commit 流程，由其决定显示内容。
    this.initResources();
    this.restoreListeners.forEach((cb) => cb());
  };

  private bindContextEvents() {
    this.canvas.addEventListener('webglcontextlost', this.handleLoss);
    this.canvas.addEventListener('webglcontextrestored', this.handleRestore);
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? '未知着色器错误';
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  /** 创建 VAO/全屏三角形与顶点着色器程序骨架。 */
  private initResources() {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER);
    // 顶点着色器固定，片段着色器后续通过 compileFragment 链入。
    this.builtinVS = vs;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.vao = vao;
  }

  private builtinVS: WebGLShader | null = null;

  /** 放弃尚未上屏的 pending 程序（编译失败或被更新代次顶替时调用）。 */
  private discardPending() {
    if (this.pendingProgram) {
      this.gl.deleteProgram(this.pendingProgram);
      this.pendingProgram = null;
    }
    this.pendingUTimeLoc = null;
  }

  /**
   * 编译并链接着色器到 pending（不上屏）。失败只丢弃 pending，
   * 正在显示的旧程序不受影响（是否停循环由 pipeline 决定）。
   */
  compileFragment(source: string): CompileOutcome {
    if (this.lost) return { ok: false, errors: ['WebGL 上下文已丢失'] };
    const gl = this.gl;
    try {
      const fs = this.compileShader(gl.FRAGMENT_SHADER, source);
      const program = gl.createProgram();
      if (!program || !fs || !this.builtinVS) {
        this.discardPending();
        return { ok: false, errors: ['无法创建着色器程序'] };
      }
      gl.attachShader(program, this.builtinVS);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? '未知链接错误';
        gl.deleteProgram(program);
        this.discardPending();
        return { ok: false, errors: [log] };
      }
      // 新 pending 顶替旧 pending（迟到但未提交的编译结果直接释放）
      this.discardPending();
      this.pendingProgram = program;
      this.pendingUTimeLoc = gl.getUniformLocation(program, 'uTime');
      return { ok: true, errors: [] };
    } catch (err) {
      this.discardPending();
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
  }

  /**
   * 把 pending 程序提交上屏。仅在 pipeline 确认该编译属于当前代次后调用，
   * 因此迟到编译不可能替换正在显示的画面。
   */
  commitPending(): boolean {
    if (this.lost || !this.pendingProgram) return false;
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    this.program = this.pendingProgram;
    this.uTimeLoc = this.pendingUTimeLoc;
    this.pendingProgram = null;
    this.pendingUTimeLoc = null;
    return true;
  }

  private frame = () => {
    if (!this.running || this.lost) return;
    this.renderOnce();
    this.rafId = requestAnimationFrame(this.frame);
  };

  /** 立即绘制一帧（也供截图前调用）。 */
  renderOnce() {
    if (this.lost || !this.program || !this.vao) return;
    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform1f(this.uTimeLoc, (performance.now() - this.startTime) / 1000);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  start() {
    if (this.running || this.lost || !this.program) return;
    this.running = true;
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop() {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** 截取当前画布为 PNG data URL（preserveDrawingBuffer 保证随时可用）。 */
  captureDataURL(): string {
    this.renderOnce();
    return this.canvas.toDataURL('image/png');
  }

  /**
   * 测试用：模拟上下文丢失/恢复（jsdom/无头环境无法真正触发事件）。
   * restored=true 时按真实恢复路径重建资源（不含旧程序）。
   */
  simulateLossForTests() {
    this.handleLoss(new Event('webglcontextlost'));
  }

  simulateRestoreForTests() {
    if (!this.lost) return;
    this.handleRestore();
  }

  dispose() {
    this.stop();
    this.canvas.removeEventListener('webglcontextlost', this.handleLoss);
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestore);
    // 不主动 WEBGL_lose_context：React StrictMode 重挂时会在同一 canvas 上
    // 重新 getContext，强制丢失反而导致新渲染器拿到丢失的上下文。
  }
}
