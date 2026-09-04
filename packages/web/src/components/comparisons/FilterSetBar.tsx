import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FolderOpen, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SavedFilterSet } from '@/lib/adapters/filter-sets';

/**
 * Quick load/save for the wizard's "Select types" step, backed by the real
 * `filters` tRPC router (`useFilterSets`/`useSaveFilterSet`/
 * `useDeleteFilterSet` in `lib/adapters/filter-sets.ts`) — replaces the
 * `localStorage`-only save/load UI that used to live inside
 * `TypeFilterPanel`. Saves/loads the FULL scope (types + name patterns +
 * modified-since + namespace exclusion), not just the type list, since
 * that's the whole point of a filter set surviving past one wizard pass.
 * Full CRUD (rename, edit description, delete without loading first) lives
 * on the dedicated `/filters` management page linked at the bottom.
 */
export function FilterSetBar({
  savedSets,
  isLoading,
  onApply,
  onDelete,
  onSave,
  isSaving,
}: {
  savedSets: readonly SavedFilterSet[];
  isLoading: boolean;
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (name: string) => void;
  isSaving: boolean;
}) {
  const [showSave, setShowSave] = useState(false);
  const [saveName, setSaveName] = useState('');

  const handleSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSave(name);
    setSaveName('');
    setShowSave(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <FolderOpen className="h-3.5 w-3.5 text-neutral-400" />
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Filter set
        </span>

        {savedSets.length > 0 && (
          <Select onValueChange={onApply}>
            <SelectTrigger className="h-7 w-52 text-xs">
              <SelectValue placeholder={isLoading ? 'Loading...' : 'Load saved filter set...'} />
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
                        onDelete(s.id);
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

        <Button variant="outline" size="sm" onClick={() => setShowSave((v) => !v)} disabled={isSaving} className="ml-auto">
          <Save className="h-3.5 w-3.5" /> Save current as...
        </Button>

        <Link to="/filters" className="text-xs font-medium text-neutral-500 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-50">
          Manage filter sets
        </Link>
      </div>

      {showSave && (
        <div className="flex items-center gap-2">
          <Input
            placeholder="Filter set name..."
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            className="h-8 max-w-64"
            autoFocus
          />
          <Button size="sm" onClick={handleSave} disabled={!saveName.trim() || isSaving}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}
