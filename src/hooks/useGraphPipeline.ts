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

  // 每次修订变化后自动提交（move-node 不递增修订，不会触发）
  const revRef = useRef(-1);
  useEffect(() => {
    if (graph.revision !== revRef.current) {
      revRef.current = graph.revision;
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
