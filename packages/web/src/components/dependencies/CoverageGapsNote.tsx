import { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert } from 'lucide-react';

/**
 * Renders `KNOWN_COVERAGE_GAPS` (`@vibeset/core`), disclosed verbatim from
 * whichever sync run produced the graph being viewed. This exists because
 * the single most dangerous misreading of this whole feature is "no edge
 * found" being read as "confirmed no dependency" — `ReferenceAnswer`'s
 * `'no-recorded-edge'` case and `DependencyEdge`'s doc comment both exist
 * specifically to prevent that, and this component is the UI's obligation
 * to actually say so rather than leaving it a type-level guarantee nobody
 * reads.
 */
export function CoverageGapsNote({ gaps }: { readonly gaps: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  if (gaps.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left font-medium text-amber-800 dark:text-amber-300"
      >
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span className="flex-1">
          No recorded edge is not proof of absence — this graph has {gaps.length} known coverage gap{gaps.length === 1 ? '' : 's'}
        </span>
        {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </button>
      {expanded && (
        <ul className="mt-2 flex flex-col gap-2 text-xs text-amber-700 dark:text-amber-400">
          {gaps.map((gap, i) => (
            <li key={i} className="list-disc pl-4">
              {gap}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
