import type { Analyzer } from '../types/analyzer.js';
import { COVERAGE_ANALYZERS } from './coverage-rules.js';
import { DEPENDENCY_ANALYZERS } from './dependency-rules.js';
import { HARDCODED_ID_ANALYZERS } from './hardcoded-id-rules.js';
import { PERMISSION_ANALYZERS } from './permission-rules.js';
import { STALE_ANALYZERS } from './stale-rules.js';
import { DESTRUCTIVE_ANALYZERS } from './destructive-rules.js';

export * from './registry.js';
export * from './component-utils.js';
export * from './coverage-rules.js';
export * from './dependency-rules.js';
export * from './hardcoded-id-rules.js';
export * from './permission-rules.js';
export * from './stale-rules.js';
export * from './destructive-rules.js';

/**
 * The shipped rule set (Phase 3 Workstream A). Register this against an
 * `AnalyzerRegistry` (or hand it straight to `runAnalyzers`) to get every
 * rule this package ships; a caller that wants a subset can filter this
 * array or use `runAnalyzers`'s `disabledIds` option instead of hand-
 * picking analyzers, so a rule added here is automatically included
 * everywhere `DEFAULT_ANALYZERS` is used.
 *
 * Six categories, weighted toward what actually breaks Salesforce
 * deployments (see each module's own doc comment for the reasoning):
 * coverage/org-type (the flagship rule — see `coverage-rules.ts`),
 * missing dependencies, hardcoded ids, profile/permission-set hazards,
 * stale/obsolete metadata, and destructive-change hazards.
 */
export const DEFAULT_ANALYZERS: readonly Analyzer[] = [
  ...COVERAGE_ANALYZERS,
  ...DEPENDENCY_ANALYZERS,
  ...PERMISSION_ANALYZERS,
  ...HARDCODED_ID_ANALYZERS,
  ...STALE_ANALYZERS,
  ...DESTRUCTIVE_ANALYZERS,
];
