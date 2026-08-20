import { ArrowLeftRight } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { SourceOption } from '@/lib/adapters/comparisons';

const KIND_LABEL: Record<SourceOption['kind'], string> = {
  org: 'Org',
  'sfdx-project': 'SFDX project',
  'git-ref': 'Git ref',
};

function SourcePicker({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: SourceOption[];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col gap-1.5">
      <Label>{label}</Label>
      {/*
        Radix's `Select` is uncontrolled the instant `value` is `undefined`
        and controlled the instant it's a string — flipping between the two
        (exactly what happens here: unset -> picked) logs React's
        "changing from uncontrolled to controlled" warning and is a real
        anti-pattern, not just noise: it means the FIRST render of this
        component is uncontrolled, so Radix bootstraps its own internal
        value state independently of ours before the switch. `?? ''` keeps
        it controlled from the very first render — Radix already treats an
        empty string as "nothing selected" (same as `undefined`) for
        `SelectValue`'s placeholder, so this is a pure robustness fix with
        no behavior change for a real selection.
      */}
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder="Choose a source..." />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              <span className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {KIND_LABEL[opt.kind]}
                </Badge>
                {opt.label}
              </span>
            </SelectItem>
          ))}
          {options.length === 0 && (
            <div className="px-3 py-2 text-sm text-neutral-400">No connections registered yet.</div>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Source/target pickers for a comparison. Both accept any registered
 * connection kind — org, local SFDX project, or Git ref — because
 * `MetadataSource` makes them interchangeable; the differ never knows or
 * cares which kind it's looking at.
 */
export function SourceTargetPicker({
  options,
  leftId,
  rightId,
  onChangeLeft,
  onChangeRight,
  onSwap,
}: {
  options: SourceOption[];
  leftId: string | undefined;
  rightId: string | undefined;
  onChangeLeft: (id: string) => void;
  onChangeRight: (id: string) => void;
  onSwap: () => void;
}) {
  return (
    <div className="flex items-end gap-3">
      <SourcePicker label="Source" options={options} value={leftId} onChange={onChangeLeft} />
      <Button variant="ghost" size="sm" onClick={onSwap} aria-label="Swap source and target" className="mb-1.5">
        <ArrowLeftRight className="h-4 w-4" />
      </Button>
      <SourcePicker label="Target" options={options} value={rightId} onChange={onChangeRight} />
    </div>
  );
}
