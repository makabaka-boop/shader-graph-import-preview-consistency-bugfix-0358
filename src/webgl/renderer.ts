import { VERTEX_SHADER } from '../graph/glslgen';

export interface CompileOutcome {
  ok: boolean;
  errors: string[];
}

type Listener = () => void;

/**
 * WebGL2 渲染器：负责编译页面生成的片段着色器并在全屏三角形上执行。
 * 显式处理 webglcontextlost / webglcontextrestored：
 * 丢失后停止渲染并上抛事件；恢复后重建全部 GL 资源并重放当前着色器，
 * 绝不沿用旧画面。
 */
export class WebGLRenderer {
  private canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uTimeLoc: WebGLUniformLocation | null = null;
  private currentSource: string | null = null;
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
    // 旧的 GL 资源随上下文一起失效，清空引用避免误用旧画面
    this.program = null;
    this.vao = null;
    this.builtinVS = null;
    this.uTimeLoc = null;
    this.lossListeners.forEach((cb) => cb());
  };

  private handleRestore = () => {
    this.lost = false;
    this.startTime = performance.now();
    // 恢复后重建当前合法图对应的资源与程序，而非显示旧画面
    this.initResources();
    if (this.currentSource) {
      const result = this.compileFragment(this.currentSource);
      if (result.ok) this.start();
    }
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
    // 顶点着色器固定，片段着色器后续通过 setFragmentSource 链入。
    // 这里先保存 vs，编译片段时再链接。
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

  /** 编译并链接着色器；失败保留旧程序（若有）并返回错误信息。 */
  compileFragment(source: string): CompileOutcome {
    if (this.lost) return { ok: false, errors: ['WebGL 上下文已丢失'] };
    const gl = this.gl;
    try {
      const fs = this.compileShader(gl.FRAGMENT_SHADER, source);
      const program = gl.createProgram();
      if (!program || !fs || !this.builtinVS) {
        return { ok: false, errors: ['无法创建着色器程序'] };
      }
      gl.attachShader(program, this.builtinVS);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? '未知链接错误';
        gl.deleteProgram(program);
        return { ok: false, errors: [log] };
      }
      if (this.program) gl.deleteProgram(this.program);
      this.program = program;
      this.uTimeLoc = gl.getUniformLocation(program, 'uTime');
      this.currentSource = source;
      return { ok: true, errors: [] };
    } catch (err) {
      return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
    }
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
   * restored=true 时按真实恢复路径重建资源。
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
