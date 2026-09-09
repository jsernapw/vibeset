import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ComponentKey } from '@vibeset/core';
import { componentKeyString } from '@vibeset/core';
import { Crosshair } from 'lucide-react';
import type { GraphEdgeModel, GraphModel, GraphNodeModel } from '@/lib/dependency-graph';
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, layoutGraph } from '@/lib/elk-layout';

const ROLE_STYLE: Record<GraphNodeModel['role'], { border: string; bg: string; label: string }> = {
  focus: { border: 'border-neutral-900 dark:border-white', bg: 'bg-white dark:bg-neutral-900', label: 'Focus' },
  forward: { border: 'border-sky-400', bg: 'bg-sky-50 dark:bg-sky-950', label: 'Depends on (forward)' },
  reverse: { border: 'border-amber-400', bg: 'bg-amber-50 dark:bg-amber-950', label: 'Depends on this (reverse)' },
};

function DependencyNode({ data }: NodeProps<Node<{ model: GraphNodeModel; onFocus: (key: ComponentKey) => void }>>) {
  const { model, onFocus } = data;
  const style = ROLE_STYLE[model.role];
  return (
    <div
      className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-lg border-2 ${style.border} ${style.bg} px-3 py-1.5 shadow-sm`}
      style={{ width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Left} className="!bg-neutral-400" />
      <Handle type="source" position={Position.Right} className="!bg-neutral-400" />
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-[10px] font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{model.key.type}</span>
        {model.role !== 'focus' && (
          <button
            type="button"
            title="Re-center the graph on this component"
            aria-label={`Focus on ${model.key.fullName}`}
            onClick={(e) => {
              e.stopPropagation();
              onFocus(model.key);
            }}
            className="shrink-0 rounded p-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700"
          >
            <Crosshair className="h-3 w-3" />
          </button>
        )}
      </div>
      <span className="truncate font-mono text-xs" title={model.key.fullName}>
        {model.key.fullName}
      </span>
    </div>
  );
}

function DependencyEdgeLabel({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<{ model: GraphEdgeModel }>>) {
  const model = data?.model;
  if (!model) return null;
  return (
    <path
      id={id}
      d={`M${sourceX},${sourceY} C${sourceX + 60},${sourceY} ${targetX - 60},${targetY} ${targetX},${targetY}`}
      fill="none"
      strokeWidth={1.5}
      stroke={model.provenance === 'org' ? '#0284c7' : '#a16207'}
      strokeDasharray={model.provenance === 'org' ? undefined : '5 4'}
      markerEnd={`url(#dep-arrow-${model.provenance})`}
    />
  );
}

const nodeTypes = { dependency: DependencyNode };
const edgeTypes = { dependency: DependencyEdgeLabel };

export interface DependencyGraphViewProps {
  readonly model: GraphModel;
  readonly onFocus: (key: ComponentKey) => void;
  readonly height?: number;
}

/**
 * Renders the bounded graph model (see `lib/dependency-graph.ts` for why
 * it's bounded) with `@xyflow/react` for interaction (pan/zoom/minimap)
 * and `elkjs` for layout — the exact pairing the Phase 3 plan calls for.
 * Layout is computed once per model change (async, off the render path)
 * rather than every frame, since ELK's layered algorithm is not free at
 * a few hundred nodes.
 */
export function DependencyGraphView({ model, onFocus, height = 480 }: DependencyGraphViewProps) {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }>>(new Map());
  const [layingOut, setLayingOut] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLayingOut(true);
    void layoutGraph(model.nodes, model.edges).then((pos) => {
      if (!cancelled) {
        setPositions(pos);
        setLayingOut(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  const flowNodes: Node[] = useMemo(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: 'dependency',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: { model: n, onFocus },
        draggable: true,
      })),
    [model.nodes, positions, onFocus],
  );

  const flowEdges: Edge[] = useMemo(
    () =>
      model.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'dependency',
        data: { model: e },
      })),
    [model.edges],
  );

  if (model.nodes.length <= 1) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed border-neutral-300 text-sm text-neutral-400 dark:border-neutral-700" style={{ height }}>
        No recorded edges for this component yet.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800" style={{ height }}>
      {layingOut && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/60 text-sm text-neutral-400 dark:bg-neutral-950/60">
          Laying out graph...
        </div>
      )}
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable className="!bg-neutral-100 dark:!bg-neutral-900" />
      </ReactFlow>
      <svg width={0} height={0}>
        <defs>
          <marker id="dep-arrow-org" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#0284c7" />
          </marker>
          <marker id="dep-arrow-supplemented" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="#a16207" />
          </marker>
        </defs>
      </svg>
      <div className="absolute bottom-2 left-2 z-10 flex flex-col gap-1 rounded-md border border-neutral-200 bg-white/90 p-2 text-[11px] shadow-sm dark:border-neutral-800 dark:bg-neutral-900/90">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">Legend</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-neutral-900 dark:border-white" /> Focus</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 bg-sky-50" /> Depends on (forward)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400 bg-amber-50" /> Depends on this (reverse)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 bg-sky-600" /> Org edge (authoritative)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-amber-700" /> Supplemented edge</span>
      </div>
    </div>
  );
}
