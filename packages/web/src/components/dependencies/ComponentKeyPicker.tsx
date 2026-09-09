import { useState } from 'react';
import { Search } from 'lucide-react';
import type { ComponentKey } from '@vibeset/core';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface ComponentKeyPickerProps {
  /** Every metadata type name available to pick from (`inventory.availableTypes.all`). */
  readonly types: readonly string[];
  readonly initial?: ComponentKey;
  readonly onSubmit: (key: ComponentKey) => void;
  readonly disabled?: boolean;
}

/**
 * Focus-component picker. There is deliberately no server-side "search
 * components by name" endpoint yet (out of `packages/web`'s ownership —
 * see this PR's description), so this is type + exact full name rather
 * than fuzzy search. In practice a name usually arrives already known —
 * copied from a comparison's results tree, a deploy package, or a
 * previous graph node's "Focus on..." action (`ImpactList`) — so exact
 * entry is the common case, not a regression from a nicer search UI that
 * doesn't exist yet.
 */
export function ComponentKeyPicker({ types, initial, onSubmit, disabled }: ComponentKeyPickerProps) {
  const [type, setType] = useState(initial?.type ?? 'ApexClass');
  const [fullName, setFullName] = useState(initial?.fullName ?? '');

  const canSubmit = type.trim().length > 0 && fullName.trim().length > 0;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit({ type: type.trim(), fullName: fullName.trim() });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dep-type">Type</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger id="dep-type" className="w-44">
            <SelectValue placeholder="Type" />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="dep-fullname">Full name</Label>
        <Input
          id="dep-fullname"
          placeholder="e.g. OpportunityService"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className="w-64 font-mono"
        />
      </div>
      <Button type="submit" disabled={!canSubmit || disabled}>
        <Search className="h-4 w-4" /> Analyze impact
      </Button>
    </form>
  );
}
