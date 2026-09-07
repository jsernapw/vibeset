import type { AnalysisContext, Analyzer, Finding, FindingSeverity } from '../types/analyzer.js';

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Stable ordering a UI/CLI can render directly: worst severity first, then analyzer id, then title — never insertion order, which would otherwise depend on which analyzer happened to run first. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byAnalyzer = a.analyzerId.localeCompare(b.analyzerId);
    if (byAnalyzer !== 0) return byAnalyzer;
    return a.title.localeCompare(b.title);
  });
}

export interface RunAnalyzersOptions {
  /** Analyzer ids to skip entirely (a saved per-project suppression list, or a CLI `--disable-analyzer` flag). */
  readonly disabledIds?: ReadonlySet<string>;
}

/**
 * Runs `analyzers` against `ctx` and returns every finding, sorted (see
 * `sortFindings`). An analyzer that throws is caught and turned into a
 * single `info`-severity finding naming the analyzer, rather than aborting
 * the whole run — a bug in one third-party rule must never hide every
 * other rule's findings, which is exactly the failure mode that would make
 * an open analyzer ecosystem fragile in practice.
 */
export function runAnalyzers(
  analyzers: readonly Analyzer[],
  ctx: AnalysisContext,
  options: RunAnalyzersOptions = {},
): Finding[] {
  const disabled = options.disabledIds ?? new Set<string>();
  const findings: Finding[] = [];
  for (const analyzer of analyzers) {
    if (disabled.has(analyzer.id)) continue;
    if (analyzer.appliesTo && !analyzer.appliesTo(ctx)) continue;
    try {
      findings.push(...analyzer.analyze(ctx));
    } catch (err) {
      findings.push({
        analyzerId: analyzer.id,
        severity: 'info',
        title: `Analyzer "${analyzer.id}" failed to run`,
        detail: err instanceof Error ? err.message : String(err),
        recommendation: `This is a bug in the "${analyzer.id}" analyzer, not necessarily in your deployment — every other analyzer still ran normally. Consider disabling it via disabledIds until fixed.`,
      });
    }
  }
  return sortFindings(findings);
}

/**
 * A mutable collection of `Analyzer`s with unique-id enforcement — the
 * shape a server route or CLI command builds once at startup (register the
 * shipped rule set, plus any project-specific ones) and then calls `run`
 * against many packages over its lifetime, rather than re-registering
 * every time.
 */
export class AnalyzerRegistry {
  private readonly analyzers: Analyzer[] = [];
  private readonly ids = new Set<string>();

  register(analyzer: Analyzer): void {
    if (this.ids.has(analyzer.id)) {
      throw new Error(
        `Analyzer id "${analyzer.id}" is already registered — analyzer ids must be unique.`,
      );
    }
    this.ids.add(analyzer.id);
    this.analyzers.push(analyzer);
  }

  registerAll(analyzers: readonly Analyzer[]): void {
    for (const analyzer of analyzers) this.register(analyzer);
  }

  list(): readonly Analyzer[] {
    return this.analyzers.slice();
  }

  get(id: string): Analyzer | undefined {
    return this.analyzers.find((a) => a.id === id);
  }

  run(ctx: AnalysisContext, options: RunAnalyzersOptions = {}): Finding[] {
    return runAnalyzers(this.analyzers, ctx, options);
  }
}
