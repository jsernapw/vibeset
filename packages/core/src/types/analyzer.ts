import type { ComponentKey } from './metadata-source.js';

export type FindingSeverity = 'error' | 'warning' | 'info';

/** A resolved metadata component as seen by an analyzer: key + parsed body. */
export interface Component {
  readonly key: ComponentKey;
  readonly path: string;
  readonly content: string;
}

/** Everything an analyzer needs to reason about a component in context. */
export interface AnalysisContext {
  readonly component: Component;
  /** All components in the same deployment package, for cross-component checks. */
  readonly packageComponents: readonly Component[];
  /** Dependency edges touching this component, if the dependency graph has been computed. */
  readonly dependencies?: readonly { fromKey: ComponentKey; toKey: ComponentKey }[];
}

export interface Finding {
  readonly analyzerId: string;
  readonly severity: FindingSeverity;
  readonly key: ComponentKey;
  readonly message: string;
  readonly path?: string;
  readonly line?: number;
}

/** A proposed edit an autofix can produce; applying it is the caller's responsibility. */
export interface Mutation {
  readonly key: ComponentKey;
  readonly description: string;
  /** New full content for the component, when the fix is a whole-file rewrite. */
  readonly newContent?: string;
  /** Additional components to add to the deployment package (the "add missing dependency" autofix class). */
  readonly addToPackage?: ComponentKey[];
}

/**
 * Plugin interface for "problem analyzers" (Phase 3). Ship as a registry
 * of these; `core` provides the interface and a runner, not the rule set.
 */
export interface Analyzer {
  readonly id: string;
  readonly severity: FindingSeverity;
  appliesTo(c: Component): boolean;
  analyze(ctx: AnalysisContext): Finding[];
  autofix?(ctx: AnalysisContext): Mutation[];
}
