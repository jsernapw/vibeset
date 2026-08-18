/**
 * A tiny, dependency-free wall-clock accumulator for the perf harness.
 *
 * Design note: this is test/harness tooling, not production code. It exists
 * because `ComparisonEngine.run()` only exposes coarse progress percentages
 * (0/30/60/90/100) — enough to drive a UI progress bar, but not enough to
 * answer "where did the 10 minutes go?". Rather than add instrumentation
 * hooks to `packages/core/src/compare/comparison-engine.ts` (production
 * source Livia does not own and the brief asks her not to touch without
 * flagging it), the harness in this directory re-composes the SAME public
 * building blocks (`RetrievalPlanner`, `MetadataSource.materialize()`,
 * `resolveComponentContents`, `canonicalizeXml`/`canonicalizeText`,
 * `diffComponent`, `SnapshotStore`) that `ComparisonEngine` itself calls,
 * wrapping each with `performance.now()` at the boundaries this file
 * defines. See `instrumented-comparison.ts` for the orchestration and the
 * top of the harness report for the "what this does NOT verify" caveat
 * that comes with reimplementing rather than hooking.
 */

export type PhaseName =
  | 'inventory'
  | 'cachePlanning'
  | 'retrieve'
  | 'convert'
  | 'resolveContent'
  | 'canonicalizeHash'
  | 'diff'
  | 'persistSnapshots'
  | 'persistDiffResults';

export interface PhaseReportRow {
  readonly phase: PhaseName;
  readonly totalMs: number;
  readonly calls: number;
  readonly percentOfTotal: number;
}

export interface PhaseReport {
  readonly rows: PhaseReportRow[];
  readonly totalMs: number;
}

/**
 * Accumulates wall-clock time per named phase across an arbitrary number of
 * calls (one comparison run touches a phase hundreds/thousands of times —
 * once per chunk, once per component — so this sums rather than overwrites).
 */
export class PhaseTimer {
  private readonly totals = new Map<PhaseName, number>();
  private readonly counts = new Map<PhaseName, number>();

  add(phase: PhaseName, ms: number, calls = 1): void {
    this.totals.set(phase, (this.totals.get(phase) ?? 0) + ms);
    this.counts.set(phase, (this.counts.get(phase) ?? 0) + calls);
  }

  /** Times a synchronous or async block and records it under `phase`. Returns the block's own return value. */
  async time<T>(phase: PhaseName, fn: () => Promise<T> | T): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.add(phase, performance.now() - start);
    }
  }

  report(): PhaseReport {
    const totalMs = [...this.totals.values()].reduce((a, b) => a + b, 0);
    const rows: PhaseReportRow[] = [...this.totals.entries()]
      .map(([phase, ms]) => ({
        phase,
        totalMs: ms,
        calls: this.counts.get(phase) ?? 0,
        percentOfTotal: totalMs > 0 ? Math.round((ms / totalMs) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.totalMs - a.totalMs);
    return { rows, totalMs };
  }

  merge(other: PhaseTimer): void {
    for (const [phase, ms] of other.totals) this.add(phase, ms, other.counts.get(phase) ?? 0);
  }
}
