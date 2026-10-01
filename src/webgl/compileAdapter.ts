import { BuildToken, CompileAdapter } from '../graph/pipeline';
import { WebGLRenderer } from './renderer';

export interface ApplyResult {
  /** 新程序是否成功上屏。 */
  ok: boolean;
  /** 上屏失败（如上下文恰在此时丢失）时的原因。 */
  errors?: string[];
}

/**
 * 把 WebGLRenderer 的同步编译包装为代次感知的两步：
 *  - compile：只编译到 pending，不改变正在显示的画面；token 原样透传；
 *  - apply：由 pipeline 在确认结果属于当前代次后调用，新程序此刻才上屏。
 * 因此迟到的编译（哪怕修订号恰好相同）只会静默作废，绝不会闪回旧颜色。
 */
export function createCompileAdapter(renderer: WebGLRenderer): CompileAdapter {
  return {
    compile(token: BuildToken, revision: number, source: string) {
      const outcome = renderer.compileFragment(source);
      if (!outcome.ok) {
        // 新源编译失败：旧程序不得继续播放上一版内容（错误遮罩会盖住画布）
        renderer.stop();
      }
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
              errors: ['着色器已编译但上下文已失效，未提交上屏'],
            });
          }
          renderer.start();
          return Promise.resolve({ ok: true });
        },
      });
    },
  };
}
