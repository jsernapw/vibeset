import { AlertTriangle, Loader2, RefreshCw, ShieldOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TagListInput } from './TagListInput';
import type { ImpactCheckStatus, NamespaceImpactRow } from '@/lib/adapters/inventory-preview';
import { computeNamespaceImpact } from '@/lib/filter-set-utils';

export interface ImpactPreviewProps {
  readonly status: ImpactCheckStatus;
  readonly results: readonly NamespaceImpactRow[];
  readonly error: string | null;
  readonly onCheck: () => void;
  /** True when there's nothing to check against (e.g. no connections chosen yet). */
  readonly disabled?: boolean;
}

function ImpactRow({ row }: { row: NamespaceImpactRow }) {
  const { removed, removedPercent } = computeNamespaceImpact(row.before, row.after);
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800">
      <span className="truncate font-medium">{row.label}</span>
      <span className="flex items-center gap-2 text-neutral-500 dark:text-neutral-400">
        <span className="font-mono text-xs">
          {row.before} <span className="text-neutral-300 dark:text-neutral-600">&rarr;</span> {row.after}
        </span>
        {removed > 0 ? (
          <Badge variant="success">
            -{removed} ({removedPercent}%)
          </Badge>
        ) : (
          <Badge variant="neutral">no change</Badge>
        )}
      </span>
    </div>
  );
}

/**
 * "How many components does this actually remove" — the impact preview
 * this panel exists to surface (see this session's brief: StaticResource
 * 200 -> 1 with `omnistudio` excluded, 16.5x faster; ApexClass 408 -> 37
 * with managed packages excluded, 3.4x faster on a cold run). Runs
 * `inventory.start` (listMetadata-only, no retrieve — see
 * `useNamespaceImpactPreview`'s doc comment) against each chosen
 * connection, once with the current namespace filtering and once without,
 * and shows the delta so the exclusion's effect is never a guess.
 */
function ImpactPreview({ status, results, error, onCheck, disabled }: ImpactPreviewProps) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-neutral-300 p-3 dark:border-neutral-700">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
          How many components does this exclude?
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={disabled || status === 'running'}>
          {status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Check impact
        </Button>
      </div>
      {status === 'error' && error && (
        <p className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {status === 'done' && results.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {results.map((row) => (
            <ImpactRow key={row.connectionId} row={row} />
          ))}
        </div>
      )}
      {status === 'idle' && (
        <p className="text-xs text-neutral-400">
          Runs a quick, read-only inventory check (no files fetched) against your chosen sources.
        </p>
      )}
    </div>
  );
}

/**
 * The rest of `TypeFilter` beyond type selection (which `TypeFilterPanel`
 * already owns): name patterns, modified-since, and namespace exclusion —
 * surfaced together because they're the "which components, precisely" half
 * of scoping a comparison, and namespace exclusion in particular is
 * "simultaneously the main noise filter and the main speed lever" (this
 * session's brief), not a buried advanced option.
 */
export function ScopeFiltersPanel({
  namePatterns,
  onChangeNamePatterns,
  modifiedSince,
  onChangeModifiedSince,
  excludeManagedPackages,
  onChangeExcludeManagedPackages,
  excludeNamespaces,
  onChangeExcludeNamespaces,
  impact,
}: {
  namePatterns: readonly string[];
  onChangeNamePatterns: (patterns: string[]) => void;
  modifiedSince: string | undefined;
  onChangeModifiedSince: (date: string | undefined) => void;
  excludeManagedPackages: boolean;
  onChangeExcludeManagedPackages: (value: boolean) => void;
  excludeNamespaces: readonly string[];
  onChangeExcludeNamespaces: (namespaces: string[]) => void;
  /** Omit to hide the "Check impact" preview entirely (e.g. the standalone filter-set manager, which has no connections to check against). */
  impact?: ImpactPreviewProps;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
        <div className="flex items-start gap-2">
          <ShieldOff className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex flex-1 flex-col gap-2">
            <label className="flex items-center gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
              <Checkbox
                checked={excludeManagedPackages}
                onCheckedChange={(c) => onChangeExcludeManagedPackages(c === true)}
              />
              Exclude managed-package components
            </label>
            <p className="text-xs text-amber-800 dark:text-amber-300">
              Components from installed managed packages (namespaced, not your own) are excluded by default —
              they're almost never hand-deployable and can dominate a comparison's scope. On by default;
              uncheck to include them.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label>Exclude specific namespaces</Label>
        <TagListInput
          values={excludeNamespaces}
          onChange={onChangeExcludeNamespaces}
          placeholder="e.g. omnistudio"
          addLabel="Exclude"
          emptyHint="No specific namespaces excluded. Add one to hide just that managed package, independent of the toggle above."
          monospace
        />
      </div>

      {impact && <ImpactPreview {...impact} />}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label>Name patterns</Label>
          <TagListInput
            values={namePatterns}
            onChange={onChangeNamePatterns}
            placeholder="e.g. Account.*"
            emptyHint="No name filter — every matching component's fullName is included."
            monospace
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="scope-modified-since">Modified since</Label>
          <Input
            id="scope-modified-since"
            type="date"
            className="h-8 w-40 text-xs"
            value={modifiedSince ?? ''}
            onChange={(e) => onChangeModifiedSince(e.target.value || undefined)}
          />
          <p className="text-xs text-neutral-400">Only components last modified on or after this date.</p>
        </div>
      </div>
    </div>
  );
}
