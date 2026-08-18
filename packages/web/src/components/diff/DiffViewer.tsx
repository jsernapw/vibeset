import { useState } from 'react';
import type { DiffResult } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { isPermissionGridType, isTextDiffType } from '@/lib/metadata-types';
import { useComponentContent } from '@/lib/adapters/comparisons';
import { LazyMonacoDiff } from './LazyMonacoDiff';
import { SemanticTreeDiff } from './SemanticTreeDiff';
import { PermissionGrid } from './PermissionGrid';

function shortSha(sha?: string): string | undefined {
  return sha ? sha.slice(0, 10) : undefined;
}

/**
 * Routes a single `DiffResult` to the right renderer: Monaco `DiffEditor`
 * for opaque code bodies (Apex/LWC/Aura/VF), the dedicated grid for
 * Profiles/PermissionSets, and the collapsible semantic tree for every
 * other decomposable XML type.
 */
export function DiffViewer({
  result,
  leftLabel,
  rightLabel,
  comparisonId,
}: {
  result: DiffResult | undefined;
  leftLabel: string;
  rightLabel: string;
  comparisonId: string | undefined;
}) {
  const [gridSelected, setGridSelected] = useState<Set<string>>(new Set());

  // Real retrieved body content, resolved from the content-addressed snapshot
  // store. Only fetched for the opaque code types Monaco renders; the XML
  // types are diffed structurally from `result.entries` and need no bodies.
  const wantsBody = !!result && isTextDiffType(result.key.type);
  const content = useComponentContent(comparisonId, wantsBody ? result.key : undefined);

  if (!result) {
    return <EmptyState title="No component selected" description="Choose a row from the results tree to view its diff." />;
  }

  const toggle = (path: string) => {
    setGridSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const toggleMany = (paths: string[], checked: boolean) => {
    setGridSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (checked) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <Badge variant="outline">{result.key.type}</Badge>
        <span className="truncate font-mono text-sm font-medium">{result.key.fullName}</span>
        <Badge variant={result.status}>{result.status}</Badge>
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-400">
          {shortSha(result.leftSha256) && <span title={result.leftSha256}>{leftLabel}: {shortSha(result.leftSha256)}</span>}
          {shortSha(result.rightSha256) && <span title={result.rightSha256}>{rightLabel}: {shortSha(result.rightSha256)}</span>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {isPermissionGridType(result.key.type) ? (
          <PermissionGrid entries={result.entries} selected={gridSelected} onToggle={toggle} onToggleMany={toggleMany} />
        ) : isTextDiffType(result.key.type) ? (
          content.isPending ? (
            <EmptyState title="Loading source..." description={`Fetching ${result.key.fullName} from the snapshot store.`} />
          ) : content.isError ? (
            <EmptyState
              title="Could not load source"
              description={content.error?.message ?? 'The component body could not be resolved.'}
            />
          ) : (
            // An absent side is meaningful, not an error: a `new` component has
            // no left content and a `deleted` one has no right content. Monaco
            // renders '' as an empty pane, which is exactly right.
            <LazyMonacoDiff
              original={content.data?.leftContent ?? ''}
              modified={content.data?.rightContent ?? ''}
              language="apex"
              height={460}
            />
          )
        ) : (
          <SemanticTreeDiff entries={result.entries} />
        )}
      </div>
    </div>
  );
}
