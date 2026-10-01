import { useEffect, useMemo, useRef, useState } from 'react';
import { GraphCanvas } from './components/GraphCanvas';
import { PreviewPanel } from './components/PreviewPanel';
import { Inspector } from './components/Inspector';
import { useGraphPipeline } from './hooks/useGraphPipeline';
import {
  CompileAdapter,
  WorkerBuildSink,
  toPlainGraph,
} from './graph/pipeline';
import { createCompileAdapter } from './webgl/compileAdapter';
import { WebGLRenderer } from './webgl/renderer';
import { validateGraph } from './graph/validate';
import { Graph } from './graph/types';

function createBuildSink() {
  const worker = new Worker(new URL('./graph/graphWorker.ts', import.meta.url), {
    type: 'module',
  });
  return new WorkerBuildSink(worker);
}

type PipelineStatus = ReturnType<typeof useGraphPipeline>['status'];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adapter, setAdapter] = useState<CompileAdapter | null>(null);

  // Worker 只创建一次
  const sink = useMemo(() => createBuildSink(), []);

  // canvas 首帧挂载后再创建 WebGL2 渲染器
  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = new WebGLRenderer(canvasRef.current);
    rendererRef.current = renderer;
    setAdapter(createCompileAdapter(renderer));
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  return (
    <Shell
      sink={sink}
      adapter={adapter}
      canvasRef={canvasRef}
      rendererRef={rendererRef}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
    />
  );
}

function Shell({
  sink,
  adapter,
  canvasRef,
  rendererRef,
  selectedId,
  setSelectedId,
}: {
  sink: WorkerBuildSink;
  adapter: CompileAdapter | null;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  rendererRef: React.MutableRefObject<WebGLRenderer | null>;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
}) {
  // adapter 未就绪前先用一个委托适配器，渲染器创建后切换其目标
  const adapterRef = useRef<CompileAdapter | null>(null);
  const delegatingAdapter = useMemo<CompileAdapter>(
    () => ({
      compile: (revision, source) => {
        const target = adapterRef.current;
        // 渲染器尚未就绪：挂起等待（初始修订为非法图，不会产生编译）
        if (!target) return new Promise(() => {});
        return target.compile(revision, source);
      },
    }),
    [],
  );
  useEffect(() => {
    adapterRef.current = adapter;
  }, [adapter]);

  const {
    graph,
    dispatch,
    status,
    exportSnapshot,
    notifyContextLost,
    notifyContextRestored,
  } = useGraphPipeline(sink, delegatingAdapter);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const offLoss = renderer.onLoss(() => notifyContextLost());
    const offRestore = renderer.onRestore(() => notifyContextRestored());
    return () => {
      offLoss();
      offRestore();
    };
  }, [rendererRef, notifyContextLost, notifyContextRestored]);

  // UI 需要的可达集合/类型解析：直接对当前图跑纯校验（成本低，≤50 节点）
  const validation = useMemo(() => validateGraph(graph), [graph]);

  const handleExport = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // 截图与图数据在 exportSnapshot 内按同一修订原子绑定
    const snapshot = exportSnapshot(() => renderer.captureDataURL());
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `colorgraph-r${snapshot.revision}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownloadGraph = () => {
    const plain = toPlainGraph(graph);
    downloadJson(plain, `graph-r${graph.revision}.json`);
  };

  const handleImport = (file: File) => {
    file.text().then((t) => {
      const parsed = JSON.parse(t) as Graph;
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        dispatch({ type: 'load', graph: parsed });
      }
    });
  };
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1>颜色图编辑器</h1>
        <span className="header-rev">revision {graph.revision}</span>
        <button className="link-btn" onClick={() => fileRef.current?.click()}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept="application/json"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleImport(f);
            e.target.value = '';
          }}
        />
      </header>
      <div className="main">
        <div className="left-col">
          <GraphCanvas
            graph={graph}
            reachableIds={[...validation.reachable]}
            order={status.phase === 'ready' || status.phase === 'compiling' ? status.order : []}
            resolvedTypes={validation.resolved}
            dispatch={(a) => {
              if (a.type === 'remove-node' && selectedId === a.id) setSelectedId(null);
              dispatch(a);
            }}
          />
          <StatusBar status={status} />
        </div>
        <div className="right-col">
          <PreviewPanel
            ref={canvasRef as React.Ref<HTMLCanvasElement>}
            status={status}
            revision={graph.revision}
            onContextLost={() => rendererRef.current?.simulateLossForTests()}
            onContextRestored={() => rendererRef.current?.simulateRestoreForTests()}
            onExport={handleExport}
            onDownloadGraph={handleDownloadGraph}
          />
          <Inspector
            graph={graph}
            selectedId={selectedId}
            dispatch={(a) => {
              if (a.type === 'remove-node' && selectedId === a.id) setSelectedId(null);
              dispatch(a);
            }}
          />
        </div>
      </div>
    </div>
  );
}

function downloadJson(data: unknown, name: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function StatusBar({ status }: { status: PipelineStatus }) {
  if (status.phase === 'invalid-graph') {
    return (
      <div className="statusbar statusbar-error">
        {status.issues.map((i, k) => (
          <span key={k}>⛔ {i.message}</span>
        ))}
      </div>
    );
  }
  if (status.phase === 'compile-error') {
    return (
      <div className="statusbar statusbar-error">
        ⛔ GLSL 编译失败（r{status.revision}）：{status.errors.join('；')}
      </div>
    );
  }
  if (status.phase === 'context-lost') {
    return (
      <div className="statusbar statusbar-warn">
        ⚠ WebGL 上下文丢失，预览已失效；恢复后将重建当前合法图。
      </div>
    );
  }
  return (
    <div className="statusbar">
      {status.phase === 'ready' && <>✅ 修订 r{status.revision} 已编译并显示</>}
      {status.phase === 'building' && <>⏳ Worker 正在对修订 r{status.revision} 排序并生成代码…</>}
      {status.phase === 'compiling' && <>⏳ 正在编译修订 r{status.revision} 的 GLSL…</>}
      {status.phase === 'idle' && <>添加一个“颜色输出”节点开始。</>}
    </div>
  );
}
