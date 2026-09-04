import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseCommaList } from '@/lib/filter-set-utils';

/**
 * Small free-text "add a tag, see it as a removable chip" control shared by
 * `ScopeFiltersPanel`'s name-patterns and namespace-exclusion fields. Accepts
 * a comma-separated paste/type (`parseCommaList`) so a user can add several
 * at once (e.g. pasting `omnistudio, gearset, fflib`) as well as one at a
 * time via Enter or the Add button.
 */
export function TagListInput({
  values,
  onChange,
  placeholder,
  addLabel = 'Add',
  emptyHint,
  monospace = false,
}: {
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel?: string;
  emptyHint?: string;
  /** Render chips in a monospace font — used for namespace/name-pattern values, which are code-like identifiers. */
  monospace?: boolean;
}) {
  const [draft, setDraft] = useState('');

  const commit = () => {
    const additions = parseCommaList(draft).filter((v) => !values.includes(v));
    if (additions.length > 0) onChange([...values, ...additions]);
    setDraft('');
  };

  const remove = (value: string) => onChange(values.filter((v) => v !== value));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={placeholder}
          className="h-8 text-xs"
        />
        <Button type="button" variant="outline" size="sm" onClick={commit} disabled={!draft.trim()}>
          <Plus className="h-3.5 w-3.5" /> {addLabel}
        </Button>
      </div>
      {values.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <Badge key={v} variant="neutral" className="gap-1">
              <span className={monospace ? 'font-mono' : undefined}>{v}</span>
              <button
                type="button"
                onClick={() => remove(v)}
                aria-label={`Remove ${v}`}
                className="text-neutral-400 hover:text-red-600"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      ) : emptyHint ? (
        <p className="text-xs text-neutral-400">{emptyHint}</p>
      ) : null}
    </div>
  );
}
