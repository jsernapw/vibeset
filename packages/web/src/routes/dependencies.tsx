import { useMemo, useState } from 'react';
import { Network } from 'lucide-react';
import type { ComponentKey } from '@vibeset/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ComponentKeyPicker } from '@/components/dependencies/ComponentKeyPicker';
import { SyncStatusPanel } from '@/components/dependencies/SyncStatusPanel';
import { CoverageGapsNote } from '@/components/dependencies/CoverageGapsNote';
import { ImpactList } from '@/components/dependencies/ImpactList';
import { DependencyGraphView } from '@/components/dependencies/DependencyGraphView';
import { useSourceOptions, useAvailableTypes } from '@/lib/adapters/comparisons';
import { useDependencyImpactBoth, useDependencySyncRuns, useSyncDependencies } from '@/lib/adapters/dependencies';
import { buildGraphModel, DEFAULT_MAX_NODES_PER_DIRECTION } from '@/lib/dependency-graph';

const DEPTH_OPTIONS = [1, 2, 3] as const;

export function DependenciesPage() {
  const { options } = useSourceOptions();
  const orgOptions = useMemo(() => options.filter((o) => o.kind === 'org'), [options]);
  const { data: availableTypes } = useAvailableTypes();

  const [connectionId, setConnectionId] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<ComponentKey | undefined>(undefined);
  const [maxDepth, setMaxDepth] = useState<number>(2);

  const { runs, isLoading: syncRunsLoading } = useDependencySyncRuns(connectionId);
  const sync = useSyncDependencies();
  const impact = useDependencyImpactBoth(connectionId, focus, maxDepth);

  const model = useMemo(
    () =>
      focus
        ? buildGraphModel(focus, impact.forward.nodes, impact.reverse.nodes, {
            maxNodesPerDirection: DEFAULT_MAX_NODES_PER_DIRECTION,
          })
        : undefined,
    [focus, impact.forward.nodes, impact.reverse.nodes],
  );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dependencies</h1>
        <p className="text-neutral-500 dark:text-neutral-400">
          Impact analysis over the org&apos;s real dependency graph — what a component depends on, and the higher-stakes question of what depends on it.
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dep-connection">Connection</Label>
            {/*
              `value` defaults to `''` rather than leaving it `undefined` on
              first render — Radix's `Select` is uncontrolled the instant
              `value` is `undefined` and controlled the instant it becomes a
              string, and flipping between the two logs React's "changing
              from uncontrolled to controlled" warning (confirmed in this
              session's console). Same fix as `SourceTargetPicker.tsx`'s
              `SourcePicker`/`TargetPicker`; `''` is already treated as
              "nothing selected" here, same as `undefined`.
            */}
            <Select value={connectionId ?? ''} onValueChange={(v) => { setConnectionId(v); setFocus(undefined); }}>
              <SelectTrigger id="dep-connection" className="w-56">
                <SelectValue placeholder="Choose an org" />
              </SelectTrigger>
              <SelectContent>
                {orgOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="dep-depth">Max depth</Label>
            <Select value={String(maxDepth)} onValueChange={(v) => setMaxDepth(Number(v))}>
              <SelectTrigger id="dep-depth" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEPTH_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} hop{d === 1 ? '' : 's'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {!connectionId ? (
        <EmptyState
          icon={Network}
          title="Choose an org connection"
          description="Dependency edges are org-specific — pick a registered org connection above to start impact analysis."
        />
      ) : (
        <>
          <SyncStatusPanel
            runs={runs}
            isLoading={syncRunsLoading}
            syncStatus={sync.status}
            syncPercent={sync.percent}
            syncMessage={sync.message}
            onSync={() => sync.run(connectionId)}
          />

          <Card>
            <CardHeader>
              <CardTitle>Focus component</CardTitle>
              <CardDescription>
                Pick a component to analyze. There&apos;s no name search yet — enter the exact type and full name (copied from a comparison, a
                deploy package, or a node&apos;s &quot;Focus on&quot; action below).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ComponentKeyPicker types={availableTypes?.all ?? []} initial={focus} onSubmit={setFocus} />
            </CardContent>
          </Card>

          {!focus ? (
            <EmptyState title="No focus component yet" description="Enter a type and full name above to see what it depends on and what depends on it." />
          ) : impact.isLoading && !model ? (
            <div className="flex flex-col gap-4">
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-96 w-full" />
            </div>
          ) : (
            <>
              <CoverageGapsNote gaps={impact.knownCoverageGaps} />

              <Card>
                <CardHeader>
                  <CardTitle>
                    {focus.type} <span className="font-mono">{focus.fullName}</span>
                  </CardTitle>
                  <CardDescription>
                    {impact.forward.nodes.length.toLocaleString()} components depended on (forward), {impact.reverse.nodes.length.toLocaleString()}{' '}
                    components depend on this (reverse), within {maxDepth} hop{maxDepth === 1 ? '' : 's'}.
                  </CardDescription>
                </CardHeader>
                <CardContent>{model && <DependencyGraphView model={model} onFocus={setFocus} />}</CardContent>
              </Card>

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Depends on (forward)</CardTitle>
                    <CardDescription>What this component references — everything needed to build a complete deployment package.</CardDescription>
                  </CardHeader>
                  <CardContent className="max-h-96 overflow-auto">
                    <ImpactList
                      nodes={impact.forward.nodes.slice(0, DEFAULT_MAX_NODES_PER_DIRECTION)}
                      direction="forward"
                      truncatedCount={model?.truncatedForward ?? 0}
                      onFocus={setFocus}
                      focusedKey={focus}
                    />
                  </CardContent>
                </Card>
                <Card className="border-amber-200 dark:border-amber-900">
                  <CardHeader>
                    <CardTitle>Depends on this (reverse)</CardTitle>
                    <CardDescription>The delete-safety direction — what would break if this component were removed.</CardDescription>
                  </CardHeader>
                  <CardContent className="max-h-96 overflow-auto">
                    <ImpactList
                      nodes={impact.reverse.nodes.slice(0, DEFAULT_MAX_NODES_PER_DIRECTION)}
                      direction="reverse"
                      truncatedCount={model?.truncatedReverse ?? 0}
                      onFocus={setFocus}
                      focusedKey={focus}
                    />
                  </CardContent>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
