import { useMemo, useState } from 'react';
import type { DiffEntry, DiffStatus } from '@vibeset/core';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

const CATEGORY_LABELS: Record<string, string> = {
  fieldPermissions: 'Field permissions',
  objectPermissions: 'Object permissions',
  classAccesses: 'Class access',
  pageAccesses: 'Page access',
  recordTypeVisibilities: 'Record types',
  tabVisibilities: 'Tabs',
  tabSettings: 'Tabs',
  userPermissions: 'User permissions',
};

function categoryOf(entry: DiffEntry): string {
  return entry.path.split('.')[0] ?? 'other';
}

function boolCell(value: unknown): string {
  if (value === undefined) return '·';
  return value ? '✓' : '✗';
}

function statusToneClass(status: DiffStatus): string {
  switch (status) {
    case 'new':
      return 'text-emerald-700 dark:text-emerald-400';
    case 'changed':
      return 'text-amber-700 dark:text-amber-400';
    case 'deleted':
      return 'text-red-600 dark:text-red-400';
    default:
      return 'text-neutral-400 dark:text-neutral-500';
  }
}

/**
 * Dedicated filterable, searchable grid for Profile/PermissionSet diffs —
 * one row per decomposed entry (a field, an object, a class, a record type,
 * a tab), each independently selectable. Profiles/PermSets are the #1
 * source of diff noise; a generic tree view here would bury real changes
 * under hundreds of identical rows, so this groups by permission category
 * with its own search + status filter per tab.
 */
export function PermissionGrid({
  entries,
  selected,
  onToggle,
  onToggleMany,
}: {
  entries?: DiffEntry[];
  selected: ReadonlySet<string>;
  onToggle: (path: string) => void;
  onToggleMany: (paths: string[], checked: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<DiffStatus | 'all'>('all');

  const categories = useMemo(() => {
    const map = new Map<string, DiffEntry[]>();
    for (const e of entries ?? []) {
      const cat = categoryOf(e);
      const list = map.get(cat);
      if (list) list.push(e);
      else map.set(cat, [e]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);

  const [activeTab, setActiveTab] = useState<string | undefined>(categories[0]?.[0]);
  const effectiveTab = activeTab && categories.some(([c]) => c === activeTab) ? activeTab : categories[0]?.[0];

  if (!entries || entries.length === 0 || categories.length === 0) {
    return <EmptyState title="No permission entries" description="This permission set/profile diff has no decomposed entries." />;
  }

  const activeEntries = categories.find(([c]) => c === effectiveTab)?.[1] ?? [];
  const filtered = activeEntries.filter((e) => {
    if (statusFilter !== 'all' && e.status !== statusFilter) return false;
    if (search && !e.key.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const columns = [...new Set(filtered.flatMap((e) => (e.children ?? []).map((c) => c.key)))];
  const allSelected = filtered.length > 0 && filtered.every((e) => selected.has(e.path));
  const someSelected = filtered.some((e) => selected.has(e.path));

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={effectiveTab} onValueChange={setActiveTab}>
        <TabsList>
          {categories.map(([cat, list]) => (
            <TabsTrigger key={cat} value={cat}>
              {CATEGORY_LABELS[cat] ?? cat}
              <span className="ml-1.5 text-neutral-400">{list.length}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {categories.map(([cat]) => (
          <TabsContent key={cat} value={cat} />
        ))}
      </Tabs>

      <div className="flex items-center gap-2">
        <Input
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <div className="flex gap-1">
          {(['all', 'new', 'changed', 'deleted', 'identical'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-medium capitalize',
                statusFilter === s
                  ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                  : 'border-neutral-200 text-neutral-600 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-900',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
          {filtered.filter((e) => selected.has(e.path)).length} of {filtered.length} selected
        </span>
      </div>

      <div className="overflow-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-neutral-50 text-xs uppercase text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
            <tr>
              <th className="w-8 px-2 py-2">
                <Checkbox
                  checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                  onCheckedChange={(c) => onToggleMany(filtered.map((e) => e.path), c === true)}
                  aria-label="Select all visible rows"
                />
              </th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Status</th>
              {columns.map((col) => (
                <th key={col} className="px-2 py-2 text-center">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((entry) => (
              <tr key={entry.path} className="border-t border-neutral-100 dark:border-neutral-800">
                <td className="px-2 py-1.5">
                  <Checkbox checked={selected.has(entry.path)} onCheckedChange={() => onToggle(entry.path)} aria-label={`Select ${entry.key}`} />
                </td>
                <td className="px-2 py-1.5 font-mono text-xs">{entry.key}</td>
                <td className="px-2 py-1.5">
                  <Badge variant={entry.status}>{entry.status}</Badge>
                </td>
                {columns.map((col) => {
                  const child = entry.children?.find((c) => c.key === col);
                  return (
                    <td key={col} className={cn('px-2 py-1.5 text-center font-mono text-xs', child && statusToneClass(child.status))}>
                      {child ? boolCell(child.status === 'deleted' ? child.before : child.after) : '·'}
                    </td>
                  );
                })}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={columns.length + 3} className="px-2 py-6 text-center text-neutral-400">
                  No entries match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
