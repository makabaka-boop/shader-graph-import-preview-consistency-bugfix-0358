import { useEffect, useMemo, useRef, useState } from 'react';
import { NodeCard, DragConnection } from './NodeCard';
import {
  Edge,
  Graph,
  GraphNode,
  NODE_DEFS,
  NodeKind,
  PortRef,
  findNode,
  MAX_NODES,
} from '../graph/types';
import { GraphAction } from '../graph/reducer';

interface GraphCanvasProps {
  graph: Graph;
  reachableIds: string[];
  order: string[];
  resolvedTypes: Map<string, import('../graph/types').DataType>;
  dispatch: React.Dispatch<GraphAction>;
}

const NODE_W = 168;
const NODE_H_ESTIMATE = 110;

function portPos(node: GraphNode, portId: string, isOutput: boolean) {
  const nodeDef = NODE_DEFS[node.kind];
  const ports = isOutput ? nodeDef.outputs : nodeDef.inputs;
  const idx = ports.findIndex((p) => p.id === portId);
  // header(28) + 内边距后每行 24px
  const y = node.y + 42 + idx * 24;
  const x = isOutput ? node.x + NODE_W : node.x;
  return { x, y };
}

function edgePath(edge: Edge, graph: Graph): string | null {
  const src = findNode(graph, edge.from.node);
  const dst = findNode(graph, edge.to.node);
  if (!src || !dst) return null;
  const a = portPos(src, edge.from.port, true);
  const b = portPos(dst, edge.to.port, false);
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

export function GraphCanvas({ graph, reachableIds, order, resolvedTypes, dispatch }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dragNode = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [dragConn, setDragConn] = useState<DragConnection | null>(null);
  const dragConnRef = useRef<DragConnection | null>(null);
  const reachableSet = useMemo(() => new Set(reachableIds), [reachableIds]);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (dragNode.current) {
        const rect = canvasRef.current!.getBoundingClientRect();
        dispatch({
          type: 'move-node',
          id: dragNode.current.id,
          x: e.clientX - rect.left - dragNode.current.dx,
          y: e.clientY - rect.top - dragNode.current.dy,
        });
      }
      const conn = dragConnRef.current;
      if (conn) {
        const rect = canvasRef.current!.getBoundingClientRect();
        setDragConn({
          ...conn,
          mouse: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        });
      }
    };
    const up = () => {
      dragNode.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dispatch]);

  const onPointerDownNode = (e: React.PointerEvent, node: GraphNode) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    dragNode.current = {
      id: node.id,
      dx: e.clientX - rect.left - node.x,
      dy: e.clientY - rect.top - node.y,
    };
  };

  const startConnect = (from: PortRef, e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const conn: DragConnection = {
      from,
      mouse: { x: e.clientX - rect.left, y: e.clientY - rect.top },
    };
    dragConnRef.current = conn;
    setDragConn(conn);
  };

  const endConnect = (to: PortRef) => {
    const conn = dragConnRef.current;
    if (conn) {
      dispatch({ type: 'connect', from: conn.from, to });
    }
    dragConnRef.current = null;
    setDragConn(null);
  };

  const addNode = (kind: NodeKind) => {
    if (graph.nodes.length >= MAX_NODES) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    dispatch({
      type: 'add-node',
      kind,
      x: rect.width / 2 - NODE_W / 2 + Math.random() * 60 - 30,
      y: rect.height / 2 - NODE_H_ESTIMATE / 2 + Math.random() * 60 - 30,
    });
  };

  return (
    <div className="canvas-wrap">
      <div className="toolbar">
        {(
          [
            ['const_float', '常量 float'],
            ['const_vec3', '常量 vec3'],
            ['uv', 'UV'],
            ['time', '时间'],
            ['add', '加'],
            ['multiply', '乘'],
            ['lerp', '插值'],
            ['output', '颜色输出'],
          ] as [NodeKind, string][]
        ).map(([kind, label]) => (
          <button key={kind} onClick={() => addNode(kind)} className="tool-btn">
            + {label}
          </button>
        ))}
        <span className="node-count">
          节点 {graph.nodes.length}/{MAX_NODES}
        </span>
      </div>
      <div
        className="graph-canvas"
        ref={canvasRef}
        onPointerUp={() => {
          dragConnRef.current = null;
          setDragConn(null);
        }}
      >
        <svg className="edges-layer">
          {graph.edges.map((edge) => {
            const d = edgePath(edge, graph);
            const active =
              reachableSet.has(edge.from.node) && reachableSet.has(edge.to.node);
            return d ? (
              <path
                key={edge.id}
                d={d}
                className={`edge ${active ? 'edge-active' : 'edge-dead'}`}
                onClick={() => dispatch({ type: 'disconnect', edgeId: edge.id })}
              >
                <title>点击断开</title>
              </path>
            ) : null;
          })}
          {dragConn &&
            (() => {
              const src = findNode(graph, dragConn.from.node);
              if (!src) return null;
              const a = portPos(src, dragConn.from.port, true);
              const dx = Math.max(40, Math.abs(dragConn.mouse.x - a.x) / 2);
              return (
                <path
                  d={`M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${dragConn.mouse.x - dx} ${dragConn.mouse.y}, ${dragConn.mouse.x} ${dragConn.mouse.y}`}
                  className="edge edge-dragging"
                />
              );
            })()}
        </svg>

        {graph.nodes.map((node) => (
          <NodeCard
            key={node.id}
            node={node}
            selected={selectedId === node.id}
            reachable={reachableSet.has(node.id)}
            orderIndex={order.indexOf(node.id)}
            resolvedTypes={resolvedTypes}
            onPointerDownNode={onPointerDownNode}
            onStartConnect={startConnect}
            onEndConnect={endConnect}
            onDelete={(id) => dispatch({ type: 'remove-node', id })}
            onSelect={setSelectedId}
          />
        ))}

        {graph.nodes.length === 0 && (
          <div className="empty-hint">
            从上方工具栏添加节点，从输出端口拖拽到输入端口建立连接。
          </div>
        )}
      </div>
    </div>
  );
}
