import { CompileAdapter } from '../graph/pipeline';
import { WebGLRenderer } from './renderer';

/**
 * 把 WebGLRenderer 的同步编译包装为修订感知的 Promise。
 * 编译失败时停止旧程序的渲染循环，避免画面继续播放上一修订的内容。
 */
export function createCompileAdapter(renderer: WebGLRenderer): CompileAdapter {
  return {
    compile(revision, source) {
      // 编译在主线程进行；resolve 前修订可能已变化，pipeline 会按修订号丢弃
      const outcome = renderer.compileFragment(source);
      if (outcome.ok) {
        renderer.start();
      } else {
        renderer.stop();
      }
      return Promise.resolve({
        revision,
        ok: outcome.ok,
        errors: outcome.errors,
      });
    },
  };
}
