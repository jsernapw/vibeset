import { useEffect, useState } from 'react';
import { Plus, Save, Search, Trash2, X } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { deleteFilterSet, loadFilterSets, saveFilterSet, type SavedFilterSet } from '@/lib/filter-sets';
import { splitTypes } from '@/lib/type-selection';

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
 * Multi-select metadata-type picker for the "Select types" step: a
 * "Selected types" section and a separate "Available types" section, so
 * picking one type never blocks picking more — the exact gap the user
 * flagged in the old single flat checkbox grid. Scales to Phase 2's 100+
 * types via the search box on the Available side; the Selected side is
 * never search-filtered so nothing you've already picked can silently
 * scroll out of view.
 */
export function TypeFilterPanel({
  allTypes,
  selectedTypes,
  onChange,
}: {
  allTypes: readonly string[];
  selectedTypes: readonly string[];
  onChange: (types: string[]) => void;
}) {
  const [savedSets, setSavedSets] = useState<SavedFilterSet[]>([]);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setSavedSets(loadFilterSets());
  }, []);

  const { selected, available } = splitTypes(allTypes, selectedTypes, search);

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
          <Button variant="outline" size="sm" onClick={() => setShowSave((v) => !v)}>
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

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
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
          <div className="flex max-h-72 min-h-24 flex-col gap-0.5 overflow-y-auto p-1.5" data-testid="selected-types-list">
            {selected.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-neutral-400">Nothing selected yet — add types from the right.</p>
            ) : (
              selected.map((type) => (
                <TypeRow key={type} type={type} icon={X} actionLabel={`Remove ${type}`} onAction={() => remove(type)} />
              ))
            )}
          </div>
        </div>

        <div className="flex flex-col rounded-lg border border-neutral-200 dark:border-neutral-800">
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
          <div className="border-b border-neutral-100 p-1.5 dark:border-neutral-900">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <Input
                placeholder="Search types..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-7 text-xs"
              />
            </div>
          </div>
          <div className="flex max-h-64 min-h-24 flex-col gap-0.5 overflow-y-auto p-1.5" data-testid="available-types-list">
            {available.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-neutral-400">
                {search ? 'No matching types.' : 'Every type is already selected.'}
              </p>
            ) : (
              available.map((type) => (
                <TypeRow key={type} type={type} icon={Plus} actionLabel={`Add ${type}`} onAction={() => add(type)} />
              ))
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-neutral-400">
        {selected.length === 0
          ? 'Leave empty to compare every registered type.'
          : `${selected.length} type${selected.length === 1 ? '' : 's'} selected.`}
      </p>
    </div>
  );
}
