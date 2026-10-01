import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import {
  CompileAdapter,
  BuildSink,
  GraphPipeline,
  PreviewSnapshot,
} from '../graph/pipeline';
import { createDemoGraph, graphReducer, GraphAction } from '../graph/reducer';
import { Graph } from '../graph/types';

export function useGraphPipeline(sink: BuildSink, compileAdapter: CompileAdapter) {
  // React 可能在一次 render 前批量执行多个 action；记录这一批中是否真的发生了
  // 结构性变化（revision 增加或 load），避免“连线 + 拖动”被最后一次拖动误判。
  const batchStructuralRef = useRef(false);
  const [graph, dispatchReducer] = useReducer(
    (prev: Graph, action: GraphAction) => {
      const next = graphReducer(prev, action);
      if (action.type === 'load' || prev.revision !== next.revision) {
        batchStructuralRef.current = true;
      }
      return next;
    },
    undefined,
    createDemoGraph,
  );
  const pipelineRef = useRef<GraphPipeline | null>(null);
  if (pipelineRef.current === null) {
    pipelineRef.current = new GraphPipeline(graph, sink, compileAdapter);
  }
  const pipeline = pipelineRef.current;

  const status = useSyncExternalStore(
    (cb) => pipeline.subscribe(cb),
    () => pipeline.status,
  );

  // revision 可能因导入而重复；用对象引用区分 reducer 产生的每次状态更新。
  const lastGraphRef = useRef<Graph | null>(null);

  useEffect(() => {
    const previous = lastGraphRef.current;
    if (previous === graph) return;
    lastGraphRef.current = graph;

    const structural = batchStructuralRef.current;
    batchStructuralRef.current = false;

    if (previous === null || structural) {
      // load 即使与旧图 revision 相同也会设置 structural，开启新代际。
      pipeline.submit(graph, true);
    } else {
      // 纯移动节点：布局更新给导出使用，但不重建着色器。
      pipeline.submit(graph, false);
    }
  });

  const dispatch = (action: GraphAction) => {
    dispatchReducer(action);
  };

  return {
    graph,
    dispatch,
    status,
    pipeline,
    loadGraph: (g: Graph) => dispatch({ type: 'load', graph: g }),
    exportSnapshot: (capture: () => string): PreviewSnapshot =>
      pipeline.captureExport(capture),
    notifyContextLost: () => pipeline.notifyContextLost(),
    notifyContextRestored: () => pipeline.notifyContextRestored(),
  };
}
