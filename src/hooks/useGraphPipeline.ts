import { useEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import {
  CompileAdapter,
  BuildSink,
  GraphPipeline,
  PreviewSnapshot,
} from '../graph/pipeline';
import { createDemoGraph, graphReducer } from '../graph/reducer';
import { Graph } from '../graph/types';

export function useGraphPipeline(sink: BuildSink, compileAdapter: CompileAdapter) {
  const [graph, dispatch] = useReducer(graphReducer, undefined, createDemoGraph);
  const pipelineRef = useRef<GraphPipeline | null>(null);
  if (pipelineRef.current === null) {
    pipelineRef.current = new GraphPipeline(graph, sink, compileAdapter);
  }
  const pipeline = pipelineRef.current;

  const status = useSyncExternalStore(
    (cb) => pipeline.subscribe(cb),
    () => pipeline.status,
  );

  // 任何图引用变化都同步给 pipeline，不能只看修订号：
  //  - 导入的图可能与当前图修订号相同（结构不同 → 必须重建，结构相同 → 更新布局）；
  //  - move-node 不递增修订号，但导出的图数据必须带上新坐标。
  // 是否真正重新构建/编译由 pipeline 按结构签名自行判断。
  const lastGraphRef = useRef<Graph | null>(null);
  useEffect(() => {
    if (lastGraphRef.current !== graph) {
      lastGraphRef.current = graph;
      pipeline.submit(graph);
    }
  });

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
