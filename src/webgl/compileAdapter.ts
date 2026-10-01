import { CompileAdapter, CompileResult } from '../graph/pipeline';
import { WebGLRenderer } from './renderer';

/**
 * 把 WebGLRenderer 的同步编译包装为代际感知的 Promise。
 * 编译只暂存程序；pipeline 确认结果仍属于当前代际后才 commit，
 * 失败或开始构建新图时撤下旧程序，避免画面继续播放上一份图的内容。
 */
export function createCompileAdapter(renderer: WebGLRenderer): CompileAdapter {
  return {
    compile(generation, revision, source) {
      const outcome = renderer.prepareFragment(source);
      if (!outcome.ok) renderer.deactivate();
      const result: CompileResult = outcome.ok
        ? {
            generation,
            revision,
            ok: true,
            errors: [],
            commit: () => outcome.prepared.commit(),
            discard: () => outcome.prepared.discard(),
          }
        : { generation, revision, ok: false, errors: outcome.errors };
      return Promise.resolve(result);
    },
    deactivate() {
      renderer.deactivate();
    },
  };
}
