import { useState } from 'react';
import { Filter, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { TypeFilterPanel } from './TypeFilterPanel';
import { ScopeFiltersPanel } from './ScopeFiltersPanel';
import { useAvailableTypes } from '@/lib/adapters/comparisons';
import { useDeleteFilterSet, useFilterSets, useSaveFilterSet, type SavedFilterSet } from '@/lib/adapters/filter-sets';
import {
  buildTypeFilter,
  defaultScopeFilterFields,
  scopeFieldsFromFilter,
  summarizeTypeFilter,
  type ScopeFilterFields,
} from '@/lib/filter-set-utils';

interface EditorState {
  readonly id?: string;
  readonly name: string;
  readonly description: string;
  readonly types: string[];
  readonly scope: ScopeFilterFields;
}

function emptyEditor(): EditorState {
  return { name: '', description: '', types: [], scope: defaultScopeFilterFields() };
}

function editorFromSet(set: SavedFilterSet): EditorState {
  return {
    id: set.id,
    name: set.name,
    description: set.description ?? '',
    types: set.filter.types ? [...set.filter.types] : [],
    scope: scopeFieldsFromFilter(set.filter),
  };
}

/**
 * Full CRUD for saved filter sets — create, name/describe, edit every
 * `TypeFilter` dimension, and delete — against the real `filters` tRPC
 * router (`.vibeset/filter-sets/<id>.yml`, shared with the CLI). This is
 * the dedicated management surface; the comparison wizard's
 * `FilterSetBar` covers the lighter "load one / save current as" path
 * without leaving the wizard.
 */
export function FilterSetManager() {
  const { data: sets, isLoading } = useFilterSets();
  const availableTypes = useAvailableTypes();
  const { save, isSaving } = useSaveFilterSet();
  const { remove, isDeleting } = useDeleteFilterSet();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const openNew = () => {
    setSaveError(null);
    setEditor(emptyEditor());
  };
  const openEdit = (set: SavedFilterSet) => {
    setSaveError(null);
    setEditor(editorFromSet(set));
  };
  const close = () => setEditor(null);

  const handleSave = async () => {
    if (!editor || !editor.name.trim()) return;
    setSaveError(null);
    try {
      await save({
        id: editor.id,
        name: editor.name.trim(),
        description: editor.description.trim() || undefined,
        filter: buildTypeFilter(editor.types, editor.scope),
      });
      close();
    } catch (err) {
      setSaveError((err as Error).message);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await remove(id);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Filter sets</h1>
          <p className="text-neutral-500 dark:text-neutral-400">
            Saved metadata scopes — type selection, name patterns, modified-since, and namespace exclusion —
            persisted server-side under <code>.vibeset/filter-sets/</code>, so they're the same set whether you're
            in the wizard, a different browser, or the CLI.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="h-4 w-4" /> New filter set
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : sets.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No saved filter sets yet"
          description="Save a metadata scope from the comparison wizard's Select types step, or create one here."
          action={
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> New filter set
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sets.map((set) => (
            <Card key={set.id}>
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{set.name}</span>
                    <span className="text-xs text-neutral-400">Updated {new Date(set.updatedAt).toLocaleString()}</span>
                  </div>
                  {set.description && <p className="text-sm text-neutral-500 dark:text-neutral-400">{set.description}</p>}
                  <div className="flex flex-wrap gap-1.5">
                    {summarizeTypeFilter(set.filter).map((chip) => (
                      <Badge key={chip} variant="outline">
                        {chip}
                      </Badge>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => openEdit(set)}>
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(set.id)}
                    disabled={isDeleting && deletingId === set.id}
                  >
                    {isDeleting && deletingId === set.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!editor} onOpenChange={(open) => !open && close()}>
        <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {editor && (
            <>
              <DialogHeader>
                <DialogTitle>{editor.id ? 'Edit filter set' : 'New filter set'}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-5">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="fs-name">Name</Label>
                    <Input
                      id="fs-name"
                      value={editor.name}
                      onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                      placeholder="e.g. Exclude OmniStudio"
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="fs-description">Description (optional)</Label>
                    <Input
                      id="fs-description"
                      value={editor.description}
                      onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                      placeholder="What this scope is for"
                    />
                  </div>
                </div>

                <TypeFilterPanel
                  allTypes={availableTypes.data?.all ?? []}
                  curatedTypes={availableTypes.data?.default ?? []}
                  selectedTypes={editor.types}
                  onChange={(types) => setEditor({ ...editor, types })}
                  isLoading={availableTypes.isLoading}
                  error={availableTypes.error as Error | null}
                  onRetry={() => availableTypes.refetch()}
                />

                <ScopeFiltersPanel
                  namePatterns={editor.scope.namePatterns}
                  onChangeNamePatterns={(namePatterns) => setEditor({ ...editor, scope: { ...editor.scope, namePatterns } })}
                  modifiedSince={editor.scope.modifiedSince}
                  onChangeModifiedSince={(modifiedSince) => setEditor({ ...editor, scope: { ...editor.scope, modifiedSince } })}
                  excludeManagedPackages={editor.scope.excludeManagedPackages}
                  onChangeExcludeManagedPackages={(excludeManagedPackages) =>
                    setEditor({ ...editor, scope: { ...editor.scope, excludeManagedPackages } })
                  }
                  excludeNamespaces={editor.scope.excludeNamespaces}
                  onChangeExcludeNamespaces={(excludeNamespaces) => setEditor({ ...editor, scope: { ...editor.scope, excludeNamespaces } })}
                />

                {saveError && <p className="text-sm text-red-600 dark:text-red-400">{saveError}</p>}

                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={close}>
                    Cancel
                  </Button>
                  <Button onClick={handleSave} disabled={!editor.name.trim() || isSaving}>
                    {isSaving && <Loader2 className="h-4 w-4 animate-spin" />} Save filter set
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
