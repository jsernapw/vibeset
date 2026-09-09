import { ArrowRight, Crosshair } from 'lucide-react';
import type { ComponentKey } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ProvenanceBadge } from './ProvenanceBadge';
import { componentKeyString, type ImpactNodeLike } from '@/lib/dependency-graph';

export interface ImpactListProps {
  readonly nodes: readonly ImpactNodeLike[];
  /** 'forward' = "what this depends on" (build a complete package). 'reverse' = "what depends on this" (the delete-safety direction). */
  readonly direction: 'forward' | 'reverse';
  readonly truncatedCount: number;
  readonly onFocus: (key: ComponentKey) => void;
  readonly focusedKey?: ComponentKey;
}

/**
 * The textual half of impact analysis — every node React Flow renders is
 * ALSO listed here, in plain sortable/scannable rows, because a graph
 * picture is not a substitute for being able to actually read every name
 * (screen readers, copy-paste, and a plain "which of these am I about to
 * break" scan all need this). Clicking a row re-centers the graph on that
 * component — the explicit-expansion motion the scale requirement calls
 * for, rather than silently expanding everything.
 */
export function ImpactList({ nodes, direction, truncatedCount, onFocus, focusedKey }: ImpactListProps) {
  if (nodes.length === 0) {
    return (
      <EmptyState
        title={direction === 'forward' ? 'Depends on nothing recorded' : 'Nothing recorded depends on this'}
        description={
          direction === 'forward'
            ? 'No forward dependency edges are recorded for this component — that means no edge was found, not a confirmed "depends on nothing" (see the coverage-gap note above).'
            : 'No reverse dependency edges are recorded — this is NOT confirmation it is safe to delete. See the coverage-gap note above.'
        }
      />
    );
  }

  const focusedId = focusedKey ? componentKeyString(focusedKey) : undefined;

  return (
    <div className="flex flex-col gap-1">
      {nodes.map((n) => {
        const id = componentKeyString(n.key);
        const isFocused = id === focusedId;
        return (
          <div
            key={`${id}:${n.depth}`}
            className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm ${
              isFocused
                ? 'border-neutral-400 bg-neutral-100 dark:border-neutral-600 dark:bg-neutral-800'
                : 'border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-900'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant="outline" className="shrink-0 font-mono">
                {n.key.type}
              </Badge>
              <span className="truncate font-mono text-xs">{n.key.fullName}</span>
              <span className="shrink-0 text-xs text-neutral-400">{n.depth} hop{n.depth === 1 ? '' : 's'}</span>
              <ProvenanceBadge provenance={n.viaEdge.provenance} supplementKind={n.viaEdge.supplementKind} />
              {(n.viaEdge.fromNamespace || n.viaEdge.toNamespace) && (
                <Badge variant="neutral" className="shrink-0">
                  managed pkg
                </Badge>
              )}
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onFocus(n.key)}
              aria-label={`Focus on ${n.key.fullName}`}
              title="Re-center the graph on this component"
            >
              <Crosshair className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
      {truncatedCount > 0 && (
        <p className="flex items-center gap-1 px-2.5 pt-2 text-xs text-neutral-400">
          <ArrowRight className="h-3 w-3" /> {truncatedCount.toLocaleString()} more not shown — reduce depth or pick a more specific focus component.
        </p>
      )}
    </div>
  );
}
