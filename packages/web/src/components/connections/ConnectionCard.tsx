import { AlertTriangle, Building2, FolderGit2, FolderKanban, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { trpc } from '@/lib/trpc';

/**
 * Mirrors the `connections` row shape returned by `connections.list`
 * (see `packages/server/src/db/schema.ts`). Declared locally rather than
 * inferred through the tRPC hook's `ReturnType` because `useQuery`'s
 * overload set makes that inference unreliable.
 */
interface ConnectionRow {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly username: string | null;
  readonly instanceUrl: string | null;
  readonly alias: string | null;
  readonly isSandbox: boolean | null;
  readonly apiVersion: string | null;
  readonly projectPath: string | null;
}

const KIND_ICON = { org: Building2, 'sfdx-project': FolderKanban, 'git-ref': FolderGit2 } as const;
const KIND_LABEL = { org: 'Org', 'sfdx-project': 'SFDX project', 'git-ref': 'Git ref' } as const;

export function ConnectionCard({
  connection,
  isExpired,
  isScratch,
  onRemoved,
}: {
  connection: ConnectionRow;
  isExpired?: boolean;
  isScratch?: boolean;
  onRemoved: () => void;
}) {
  const Icon = KIND_ICON[connection.kind as keyof typeof KIND_ICON] ?? Building2;
  const health = trpc.connections.healthCheck.useQuery(
    { connectionId: connection.id },
    { enabled: false, retry: false },
  );
  const remove = trpc.connections.remove.useMutation({ onSuccess: onRemoved });

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-neutral-100 dark:bg-neutral-800">
              <Icon className="h-4 w-4 text-neutral-500" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-2">
                <span className="font-medium">{connection.label}</span>
                {connection.alias && connection.alias !== connection.label && (
                  <span className="text-xs text-neutral-400">({connection.alias})</span>
                )}
              </div>
              <span className="text-xs text-neutral-400">
                {connection.kind === 'org' ? connection.username : connection.projectPath}
              </span>
              {connection.kind === 'org' && connection.instanceUrl && (
                <span className="text-xs text-neutral-400">{connection.instanceUrl}</span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => remove.mutate({ connectionId: connection.id })} aria-label="Remove connection">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{KIND_LABEL[connection.kind as keyof typeof KIND_LABEL] ?? connection.kind}</Badge>
          {connection.kind === 'org' && connection.isSandbox && <Badge variant="warning">sandbox</Badge>}
          {connection.kind === 'org' && isScratch && <Badge variant="info">scratch</Badge>}
          {connection.kind === 'org' && !connection.isSandbox && !isScratch && <Badge variant="success">production</Badge>}
          {connection.apiVersion && <Badge variant="neutral">API v{connection.apiVersion}</Badge>}
          {isExpired && (
            <Badge variant="error">
              <AlertTriangle className="h-3 w-3" /> auth expired
            </Badge>
          )}
        </div>

        {connection.kind === 'org' && (
          <div className="flex flex-col gap-1.5 border-t border-neutral-100 pt-3 text-sm dark:border-neutral-800">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => health.refetch()} disabled={health.isFetching}>
                {health.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Check health
              </Button>
              {health.data?.ok && (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  Connected — API v{health.data.apiVersion}
                </span>
              )}
              {health.isError && <span className="text-xs text-red-600">{health.error.message}</span>}
              {health.data && !health.data.ok && <span className="text-xs text-red-600">{health.data.error}</span>}
            </div>
            {health.data?.ok && health.data.limits && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                {['DailyApiRequests', 'DataStorageMB', 'FileStorageMB'].map((limitName) => {
                  const l = health.data!.limits![limitName];
                  if (!l) return null;
                  return (
                    <span key={limitName}>
                      {limitName}: {(l.max - l.remaining).toLocaleString()}/{l.max.toLocaleString()}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
