import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { History as HistoryIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { useHistoryList } from '@/lib/adapters/history';
import { formatDateTime, formatDuration, formatRelativeTime } from '@/lib/format';

const STATUS_VARIANT = { succeeded: 'success', failed: 'error', 'in-progress': 'info', canceled: 'neutral', queued: 'neutral' } as const;
const STATUSES = ['succeeded', 'failed', 'in-progress', 'canceled', 'queued'] as const;

export function HistoryPage() {
  const all = useHistoryList();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUSES)[number] | 'all'>('all');

  const filtered = useMemo(() => {
    return all
      .filter((d) => statusFilter === 'all' || d.status === statusFilter)
      .filter((d) => !search || d.targetLabel.toLowerCase().includes(search.toLowerCase()) || d.initiator.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }, [all, search, statusFilter]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">History</h1>
        <p className="text-neutral-500 dark:text-neutral-400">Every past deployment and validation, with logs and rollback packages.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input placeholder="Search target or initiator..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        <div className="flex gap-1">
          {(['all', ...STATUSES] as const).map((s) => (
            <button
              key={s}
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
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={HistoryIcon} title="No matching deployments" description="Try a different filter or search term." />
      ) : (
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-50 text-xs uppercase text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
              <tr>
                <th className="px-4 py-2">Target</th>
                <th className="px-4 py-2">Result</th>
                <th className="px-4 py-2">Kind</th>
                <th className="px-4 py-2">Initiator</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">When</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => (
                <tr key={d.id} className="border-t border-neutral-100 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900">
                  <td className="px-4 py-2">
                    <Link to="/deployments/$deploymentId" params={{ deploymentId: d.id }} className="font-medium hover:underline">
                      {d.targetLabel}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={STATUS_VARIANT[d.status]}>{d.status}</Badge>
                    {d.numberComponentErrors > 0 && <span className="ml-1.5 text-xs text-red-600">{d.numberComponentErrors} errors</span>}
                  </td>
                  <td className="px-4 py-2 text-neutral-500">{d.checkOnly ? 'Validate' : 'Deploy'}</td>
                  <td className="px-4 py-2 text-neutral-500">{d.initiator}</td>
                  <td className="px-4 py-2 text-neutral-500">
                    {d.completedAt ? formatDuration(new Date(d.completedAt).getTime() - new Date(d.startedAt).getTime()) : '—'}
                  </td>
                  <td className="px-4 py-2 text-neutral-500" title={formatDateTime(d.startedAt)}>
                    {formatRelativeTime(d.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
