import { Loader2, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import type { ComparisonRunStatus } from '@/lib/adapters/comparisons';

export function ComparisonRunPanel({
  status,
  percent,
  message,
  onCancel,
}: {
  status: ComparisonRunStatus;
  percent: number;
  message: string;
  onCancel: () => void;
}) {
  if (status !== 'running') return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2 className="h-4 w-4 animate-spin" />
        Running comparison...
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onCancel}>
          <X className="h-3.5 w-3.5" /> Cancel
        </Button>
      </div>
      <Progress value={percent} />
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {percent}% — {message}
      </p>
    </div>
  );
}
