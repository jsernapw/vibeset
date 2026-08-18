import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import type { DiffStatus } from '@vibeset/core';
import { AppShell } from '@/components/AppShell';
import { DashboardPage } from '@/routes/dashboard';
import { ConnectionsPage } from '@/routes/connections';
import { ComparisonsPage } from '@/routes/comparisons';
import { ComparisonSourcesPage } from '@/routes/comparisons.new';
import { ComparisonTypesPage } from '@/routes/comparisons.new.types';
import { ComparisonResultsPage } from '@/routes/comparisons.$comparisonId';
import { ComparisonDeployPage } from '@/routes/comparisons.$comparisonId.deploy';
import { DeploymentsPage } from '@/routes/deployments';
import { DeploymentReviewPage } from '@/routes/deployments.new';
import { DeploymentDetailPage } from '@/routes/deployments.$deploymentId';
import { HistoryPage } from '@/routes/history';
import { useComparisonFlowStore } from '@/lib/comparison-flow-store';

const rootRoute = createRootRoute({
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connections',
  component: ConnectionsPage,
});

const comparisonsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comparisons',
  component: ComparisonsPage,
});

const comparisonsNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comparisons/new',
  component: ComparisonSourcesPage,
});

const comparisonsNewTypesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comparisons/new/types',
  // Step 2 needs a committed source/target pair from step 1 — if the flow
  // store doesn't have one (fresh tab, store cleared, direct URL entry),
  // send the user back to choose sources rather than rendering a form with
  // nothing to run.
  beforeLoad: () => {
    const { leftId, rightId } = useComparisonFlowStore.getState();
    if (!leftId || !rightId) {
      throw redirect({ to: '/comparisons/new' });
    }
  },
  component: ComparisonTypesPage,
});

/** Search params for the Review differences step: status/name filters and the tree-vs-selected view toggle, all deep-linkable and preserved across Back/Forward. */
export interface ComparisonReviewSearch {
  statuses?: DiffStatus[];
  search?: string;
  view?: 'tree' | 'selected';
}

const comparisonResultRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comparisons/$comparisonId',
  validateSearch: (search: Record<string, unknown>): ComparisonReviewSearch => ({
    statuses: Array.isArray(search.statuses) ? (search.statuses as DiffStatus[]) : undefined,
    search: typeof search.search === 'string' ? search.search : undefined,
    view: search.view === 'selected' ? 'selected' : undefined,
  }),
  component: ComparisonResultsPage,
});

const comparisonDeployRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/comparisons/$comparisonId/deploy',
  component: ComparisonDeployPage,
});

const deploymentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deployments',
  component: DeploymentsPage,
});

const deploymentNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deployments/new',
  component: DeploymentReviewPage,
});

const deploymentDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/deployments/$deploymentId',
  component: DeploymentDetailPage,
});

const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  component: HistoryPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  connectionsRoute,
  comparisonsRoute,
  comparisonsNewRoute,
  comparisonsNewTypesRoute,
  comparisonResultRoute,
  comparisonDeployRoute,
  deploymentsRoute,
  deploymentNewRoute,
  deploymentDetailRoute,
  historyRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
