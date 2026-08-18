import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Plus, Save, Search, Trash2, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { deleteFilterSet, loadFilterSets, saveFilterSet, type SavedFilterSet } from '@/lib/filter-sets';
import { splitTypesForScope } from '@/lib/type-selection';

const ROW_HEIGHT = 30;
type Scope = 'curated' | 'all';

function TypeRow({ type, icon: Icon, actionLabel, onAction }: { type: string; icon: typeof Plus; actionLabel: string; onAction: () => void }) {
  return (
    <button
      type="button"
      onClick={onAction}
      className="group flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      <span className="truncate font-mono text-xs">{type}</span>
      <Icon
        aria-label={actionLabel}
        className="h-3.5 w-3.5 shrink-0 text-neutral-300 group-hover:text-neutral-600 dark:text-neutral-700 dark:group-hover:text-neutral-300"
      />
    </button>
  );
}

/**
 * A virtualized, fixed-height list of type rows. Selected can hold every
 * type a user picks (in principle all ~418), and Available can hold the
 * full ~418-type registry when scope is `'all'` — rendering either
 * unvirtualized would put hundreds of DOM nodes into an already-heavy
 * wizard page. Same TanStack Virtual pattern as `ResultsTree`/
 * `SelectedComponentsView`.
 */
function TypeList({
  items,
  icon,
  actionLabel,
  onAction,
  emptyMessage,
  testId,
}: {
  items: readonly string[];
  icon: typeof Plus;
  actionLabel: (type: string) => string;
  onAction: (type: string) => void;
  emptyMessage: React.ReactNode;
  testId: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-1.5" data-testid={testId}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div ref={parentRef} className="h-full overflow-y-auto p-1.5" data-testid={testId}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vRow) => {
          const type = items[vRow.index];
          if (!type) return null;
          return (
            <div
              key={type}
              data-index={vRow.index}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: vRow.size, transform: `translateY(${vRow.start}px)` }}
            >
              <TypeRow type={type} icon={icon} actionLabel={actionLabel(type)} onAction={() => onAction(type)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Multi-select metadata-type picker for the "Select types" step: a
 * "Selected types" section and a separate "Available types" section, so
 * picking one type never blocks picking more — the exact gap the user
 * flagged in the old single flat checkbox grid.
 *
 * Phase 2 adds a scope toggle to the Available column: `curatedTypes` (the
 * ~33-type default a comparison uses when nothing is explicitly chosen —
 * see `@vibeset/core`'s `DEFAULT_INVENTORY_TYPES`) is the default view, and
 * the full `allTypes` (~418, everything SDR's registry knows about) is one
 * click away via "All types" — reachable, but a user looking for `ApexClass`
 * never has to scroll past hundreds of Territory2/Wave/AI internals to find
 * it. Searching while scoped to Common and finding nothing offers a direct
 * jump to searching All.
 */
export function TypeFilterPanel({
  allTypes,
  curatedTypes,
  selectedTypes,
  onChange,
  isLoading = false,
  error,
  onRetry,
}: {
  /** Every registry-known type name (~418). Empty while `isLoading`/`error`. */
  allTypes: readonly string[];
  /** The curated default subset (~33) — the Available column's default scope. */
  curatedTypes: readonly string[];
  selectedTypes: readonly string[];
  onChange: (types: string[]) => void;
  isLoading?: boolean;
  error?: Error | null;
  onRetry?: () => void;
}) {
  const [savedSets, setSavedSets] = useState<SavedFilterSet[]>([]);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState<Scope>('curated');

  useEffect(() => {
    setSavedSets(loadFilterSets());
  }, []);

  const scopeTypes = scope === 'curated' ? curatedTypes : allTypes;
  const { selected, available } = splitTypesForScope({ allTypes, scopeTypes, selectedTypes, search });

  const add = (type: string) => onChange([...selectedTypes, type]);
  const remove = (type: string) => onChange(selectedTypes.filter((t) => t !== type));
  const addAll = () => onChange([...selectedTypes, ...available]);
  const clearAll = () => onChange([]);

  const applySet = (id: string) => {
    const set = savedSets.find((s) => s.id === id);
    if (set) onChange(set.filter.types ?? []);
  };

  const handleSave = () => {
    if (!saveName.trim()) return;
    saveFilterSet(saveName.trim(), { types: [...selectedTypes] });
    setSavedSets(loadFilterSets());
    setSaveName('');
    setShowSave(false);
  };

  const noCommonMatches = scope === 'curated' && search.trim().length > 0 && available.length === 0 && allTypes.length > curatedTypes.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label>Metadata types</Label>
        <div className="flex items-center gap-2">
          {savedSets.length > 0 && (
            <Select onValueChange={applySet}>
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue placeholder="Load filter set..." />
              </SelectTrigger>
              <SelectContent>
                {savedSets.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex w-full items-center justify-between gap-2">
                      {s.name}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteFilterSet(s.id);
                          setSavedSets(loadFilterSets());
                        }}
                        className="text-neutral-400 hover:text-red-600"
                        aria-label={`Delete ${s.name}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button variant="outline" size="sm" onClick={() => setShowSave((v) => !v)} disabled={isLoading || !!error}>
            <Save className="h-3.5 w-3.5" /> Save set
          </Button>
        </div>
      </div>

      {showSave && (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter set name..."
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            className="h-8 max-w-56"
          />
          <Button size="sm" onClick={handleSave} disabled={!saveName.trim()}>
            Save
          </Button>
        </div>
      )}

      {error ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-red-200 px-6 py-10 text-center dark:border-red-900">
          <AlertTriangle className="h-6 w-6 text-red-500" />
          <div>
            <p className="text-sm font-medium text-red-700 dark:text-red-400">Could not load metadata types</p>
            <p className="mt-1 max-w-sm text-sm text-neutral-500 dark:text-neutral-400">{error.message}</p>
          </div>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <Skeleton className="h-4 w-32" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
          <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex h-80 flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  Selected types ({selected.length})
                </span>
                <button
                  type="button"
                  disabled={selected.length === 0}
                  onClick={clearAll}
                  className="text-xs font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:text-neutral-50"
                >
                  Clear all
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <TypeList
                  items={selected}
                  icon={X}
                  actionLabel={(t) => `Remove ${t}`}
                  onAction={remove}
                  testId="selected-types-list"
                  emptyMessage={<p className="px-2 py-4 text-center text-xs text-neutral-400">Nothing selected yet — add types from the right.</p>}
                />
              </div>
            </div>

            <div className="flex h-80 flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
                <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                  Available types ({available.length})
                </span>
                <button
                  type="button"
                  disabled={available.length === 0}
                  onClick={addAll}
                  className="text-xs font-medium text-neutral-500 hover:text-neutral-900 disabled:opacity-40 dark:text-neutral-400 dark:hover:text-neutral-50"
                >
                  Add all
                </button>
              </div>
              <div className="flex items-center gap-2 border-b border-neutral-100 p-1.5 dark:border-neutral-900">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
                  <Input
                    placeholder="Search types..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="h-8 pl-7 text-xs"
                  />
                </div>
                {allTypes.length > curatedTypes.length && (
                  <div className="flex shrink-0 items-center gap-0.5 rounded-md bg-neutral-100 p-0.5 dark:bg-neutral-900">
                    <button
                      type="button"
                      onClick={() => setScope('curated')}
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-medium',
                        scope === 'curated'
                          ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                          : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
                      )}
                    >
                      Common ({curatedTypes.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setScope('all')}
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-medium',
                        scope === 'all'
                          ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                          : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200',
                      )}
                    >
                      All types ({allTypes.length})
                    </button>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1">
                <TypeList
                  items={available}
                  icon={Plus}
                  actionLabel={(t) => `Add ${t}`}
                  onAction={add}
                  testId="available-types-list"
                  emptyMessage={
                    noCommonMatches ? (
                      <div className="flex flex-col items-center gap-2 px-2 py-4 text-center">
                        <p className="text-xs text-neutral-400">No matches in the common {curatedTypes.length} types.</p>
                        <button
                          type="button"
                          onClick={() => setScope('all')}
                          className="text-xs font-medium text-neutral-600 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-50"
                        >
                          Search all {allTypes.length} registered types →
                        </button>
                      </div>
                    ) : (
                      <p className="px-2 py-4 text-center text-xs text-neutral-400">
                        {search ? 'No matching types.' : 'Every type is already selected.'}
                      </p>
                    )
                  }
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-neutral-400">
            {selected.length === 0
              ? 'No types selected — add at least one to run a comparison.'
              : `${selected.length} type${selected.length === 1 ? '' : 's'} selected.`}
          </p>
        </>
      )}
    </div>
  );
}
