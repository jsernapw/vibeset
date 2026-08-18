import { Server } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { ConnectionCard } from './ConnectionCard';

export function ConnectionsList() {
  const utils = trpc.useUtils();
  const connections = trpc.connections.list.useQuery();
  const authorized = trpc.connections.listAuthorizedOrgs.useQuery();

  if (connections.isPending) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
    );
  }

  if (connections.isError) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
        Failed to load connections: {connections.error.message}
      </div>
    );
  }

  if (connections.data.length === 0) {
    return (
      <EmptyState
        icon={Server}
        title="No sources registered yet"
        description="Add an org, or register a local SFDX project or Git repo, to start comparing."
      />
    );
  }

  const authorizedByUsername = new Map((authorized.data ?? []).map((o) => [o.username, o]));

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {connections.data.map((c) => (
        <ConnectionCard
          key={c.id}
          connection={c}
          isExpired={c.kind === 'org' && c.username ? authorizedByUsername.get(c.username)?.isExpired === true : undefined}
          isScratch={c.kind === 'org' && c.username ? authorizedByUsername.get(c.username)?.isScratch : undefined}
          onRemoved={() => utils.connections.list.invalidate()}
        />
      ))}
    </div>
  );
}
