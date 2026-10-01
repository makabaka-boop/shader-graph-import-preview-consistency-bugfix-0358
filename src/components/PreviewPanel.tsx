import { forwardRef } from 'react';
import { RevisionStatus } from '../graph/pipeline';

interface PreviewPanelProps {
  status: RevisionStatus;
  revision: number;
  onContextLost: () => void;
  onContextRestored: () => void;
  onExport: () => void;
  onDownloadGraph: () => void;
}

export const PreviewPanel = forwardRef<
  HTMLCanvasElement,
  PreviewPanelProps
>(function PreviewPanel(
  { status, revision, onContextLost, onContextRestored, onExport, onDownloadGraph },
  canvasRef,
) {
  const lost = status.phase === 'context-lost';
  const busy = status.phase === 'building' || status.phase === 'compiling';
  return (
    <div className="preview-panel">
      <div className="preview-head">
        <h3>预览</h3>
        <span className={`status-chip status-${status.phase}`}>
          {statusLabel(status)}
        </span>
      </div>
      <div className={`canvas-stage ${lost ? 'stage-lost' : ''} ${busy ? 'stage-busy' : ''}`}>
        <canvas ref={canvasRef} width={360} height={360} className="preview-canvas" />
        {busy && (
          <div className="busy-overlay">
            <strong>正在生成预览</strong>
            <span>旧预览已撤下，等待当前画面就绪</span>
          </div>
        )}
        {lost && (
          <div className="lost-overlay">
            <strong>预览已失效</strong>
            <span>WebGL 上下文丢失</span>
          </div>
        )}
        {status.phase === 'invalid-graph' && (
          <div className="error-overlay">
            {status.issues.map((i, k) => (
              <div key={k}>⚠ {i.message}</div>
            ))}
          </div>
        )}
        {status.phase === 'compile-error' && (
          <div className="error-overlay">
            {status.errors.map((m, k) => (
              <pre key={k}>{m}</pre>
            ))}
          </div>
        )}
      </div>
      <div className="revision-line">修订 revision: {revision}</div>
      <div className="preview-actions">
        <button
          onClick={onExport}
          disabled={status.phase !== 'ready'}
          title="图数据与截图必须属于同一修订"
        >
          导出（图数据 + 截图）
        </button>
        <button onClick={onDownloadGraph}>仅下载图数据 JSON</button>
      </div>
      <div className="context-actions">
        <button onClick={onContextLost} title="模拟 webglcontextlost">
          模拟上下文丢失
        </button>
        <button onClick={onContextRestored} title="模拟 webglcontextrestored">
          模拟上下文恢复
        </button>
      </div>
    </div>
  );
});

function statusLabel(s: RevisionStatus): string {
  switch (s.phase) {
    case 'idle':
      return '空闲';
    case 'building':
      return `Worker 生成中 r${s.revision}`;
    case 'compiling':
      return `编译 GLSL r${s.revision}`;
    case 'ready':
      return `就绪 r${s.revision}`;
    case 'invalid-graph':
      return `图不合法 r${s.revision}`;
    case 'compile-error':
      return `编译失败 r${s.revision}`;
    case 'context-lost':
      return `上下文丢失 r${s.revision}`;
  }
}
