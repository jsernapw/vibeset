import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ShieldCheck, Sparkles } from 'lucide-react';
import type { TestLevel } from '@vibeset/core';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { EmptyState } from '@/components/ui/empty-state';
import { TestLevelPicker } from '@/components/deploy/TestLevelPicker';
import { useDeploymentDraftStore } from '@/lib/deployment-draft-store';
import { findQuickDeployCandidate, useStartDeployment } from '@/lib/adapters/deploy';
import { buildPackageXmlPreview } from '@/lib/package-xml';
import { formatRelativeTime } from '@/lib/format';

const PREVIEW_ROW_LIMIT = 300;

export function DeploymentReviewPage() {
  const navigate = useNavigate();
  const draft = useDeploymentDraftStore();
  const { start } = useStartDeployment();

  const [packageName, setPackageName] = useState(() => `package-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
  const [checkOnly, setCheckOnly] = useState(true);
  const [testLevel, setTestLevel] = useState<TestLevel>('RunLocalTests');

  const packageXml = useMemo(() => buildPackageXmlPreview(draft.components), [draft.components]);
  const destructiveXml = useMemo(
    () => (draft.destructiveComponents.length > 0 ? buildPackageXmlPreview(draft.destructiveComponents) : null),
    [draft.destructiveComponents],
  );
  const quickDeploy = useMemo(() => findQuickDeployCandidate(draft.components), [draft.components]);

  const totalCount = draft.components.length + draft.destructiveComponents.length;
  if (totalCount === 0) {
    return (
      <EmptyState
        title="Nothing selected yet"
        description="Run a comparison and select components, then come back here to review and deploy. New comparisons now walk you straight from selection to deploy without leaving the flow."
        action={
          <Button variant="outline" onClick={() => navigate({ to: '/comparisons/new' })}>
            New comparison
          </Button>
        }
      />
    );
  }

  const runDeployment = (asCheckOnly: boolean) => {
    const id = start({
      components: draft.components,
      destructiveComponents: draft.destructiveComponents,
      checkOnly: asCheckOnly,
      testLevel,
      targetLabel: draft.targetLabel ?? 'target',
      packageName,
    });
    navigate({ to: '/deployments/$deploymentId', params: { deploymentId: id } });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Review deployment</h1>
        <p className="text-neutral-500 dark:text-neutral-400">
          {draft.sourceLabel && draft.targetLabel ? (
            <>
              From <span className="font-medium">{draft.sourceLabel}</span> to <span className="font-medium">{draft.targetLabel}</span> &mdash;{' '}
            </>
          ) : null}
          {draft.components.length} to add/update, {draft.destructiveComponents.length} to delete.
        </p>
      </div>

      {quickDeploy && (
        <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm dark:border-emerald-900 dark:bg-emerald-950">
          <Sparkles className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" />
          <div className="flex-1">
            <p className="font-medium text-emerald-800 dark:text-emerald-300">Quick Deploy available</p>
            <p className="text-emerald-700 dark:text-emerald-400">
              This exact component set validated successfully {formatRelativeTime(quickDeploy.validatedAt)} ({quickDeploy.daysRemaining} day
              {quickDeploy.daysRemaining === 1 ? '' : 's'} left in the 10-day window) — deploy without re-running tests.
            </p>
          </div>
          <Button size="sm" onClick={() => runDeployment(false)}>
            Quick Deploy
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>package.xml</CardTitle>
              <CardDescription>{draft.components.length} components across {new Set(draft.components.map((c) => c.type)).size} types.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">{packageXml}</pre>
            </CardContent>
          </Card>

          {destructiveXml && (
            <Card className="border-red-200 dark:border-red-900">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <AlertTriangle className="h-4 w-4" /> destructiveChangesPost.xml
                </CardTitle>
                <CardDescription>{draft.destructiveComponents.length} components will be permanently deleted from the target.</CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="max-h-72 overflow-auto rounded-md bg-neutral-900 p-3 text-xs text-neutral-100">{destructiveXml}</pre>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Selected components</CardTitle>
            </CardHeader>
            <CardContent className="max-h-64 overflow-auto">
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {[...draft.components, ...draft.destructiveComponents].slice(0, PREVIEW_ROW_LIMIT).map((c) => (
                  <li key={`${c.type}:${c.fullName}`} className="flex gap-2">
                    <Badge variant="outline" className="w-32 shrink-0 justify-center text-[10px]">
                      {c.type}
                    </Badge>
                    <span className="truncate">{c.fullName}</span>
                  </li>
                ))}
              </ul>
              {totalCount > PREVIEW_ROW_LIMIT && (
                <p className="mt-2 text-xs text-neutral-400">and {totalCount - PREVIEW_ROW_LIMIT} more...</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Analyzer findings</CardTitle>
              <CardDescription>Problem analyzers (missing dependencies, hardcoded IDs, coverage warnings...) ship in Phase 3.</CardDescription>
            </CardHeader>
            <CardContent>
              <EmptyState title="No analyzer findings yet" description="This placeholder will surface actionable warnings before you deploy." />
            </CardContent>
          </Card>
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Deploy options</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pkg-name">Package name</Label>
              <Input id="pkg-name" value={packageName} onChange={(e) => setPackageName(e.target.value)} />
            </div>

            <TestLevelPicker value={testLevel} onChange={setTestLevel} />

            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={checkOnly} onCheckedChange={(c) => setCheckOnly(c === true)} />
              Validate only (checkOnly) &mdash; no changes are made to the target
            </label>

            <Separator />

            <div className="flex flex-col gap-2">
              <Button onClick={() => runDeployment(checkOnly)} className="w-full">
                <ShieldCheck className="h-4 w-4" /> {checkOnly ? 'Validate' : 'Deploy'}
              </Button>
              {checkOnly && (
                <Button variant="outline" onClick={() => runDeployment(false)} className="w-full">
                  Skip validation, deploy directly
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
