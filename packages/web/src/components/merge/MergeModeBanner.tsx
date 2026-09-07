import { GitBranch, ShieldAlert } from 'lucide-react';
import type { MergeMode } from '@vibeset/core';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { modeBannerCopy } from '@/lib/merge-resolution';
import type { GitRefConnectionOption } from '@/lib/adapters/merge';
import { cn } from '@/lib/utils';

/**
 * States, unmissably, whether this merge carries the three-way "only
 * genuine conflicts need attention" guarantee or not — see `types/merge.ts`
 * (`@vibeset/core`) for why that distinction is load-bearing rather than
 * cosmetic. Also hosts the base-connection picker: the ONLY way to move
 * from two-way to three-way is a `git-ref` connection (`merge.resolve`
 * hard-errors on anything else), so the picker only ever lists those.
 */
export function MergeModeBanner({
  mode,
  baseLabel,
  gitRefOptions,
  selectedBaseId,
  onSelectBase,
}: {
  mode: MergeMode;
  baseLabel?: string;
  gitRefOptions: GitRefConnectionOption[];
  selectedBaseId: string | undefined;
  onSelectBase: (id: string | undefined) => void;
}) {
  const copy = modeBannerCopy(mode, baseLabel);
  const Icon = mode === 'three-way' ? GitBranch : ShieldAlert;

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-start sm:gap-3',
        copy.tone === 'warning'
          ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950'
          : 'border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950',
      )}
      data-testid="merge-mode-banner"
      data-mode={mode}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          copy.tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400',
        )}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm font-medium',
            copy.tone === 'warning' ? 'text-amber-900 dark:text-amber-200' : 'text-sky-900 dark:text-sky-200',
          )}
        >
          {copy.title}
        </p>
        <p className={cn('text-xs', copy.tone === 'warning' ? 'text-amber-800 dark:text-amber-300' : 'text-sky-800 dark:text-sky-300')}>
          {copy.body}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">Base:</span>
        <Select
          value={selectedBaseId ?? '__none__'}
          onValueChange={(v) => onSelectBase(v === '__none__' ? undefined : v)}
        >
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue placeholder="None (two-way)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">None (two-way)</SelectItem>
            {gitRefOptions.map((opt) => (
              <SelectItem key={opt.id} value={opt.id}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
