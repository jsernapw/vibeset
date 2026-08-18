import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PhaseReport } from './phase-timer.js';

export interface RunReport {
  readonly label: string;
  readonly totalWallMs: number;
  readonly componentCount: number;
  readonly summary: Record<string, number>;
  readonly phases: PhaseReport;
  readonly cache?: { hits: number; misses: number; hitRatePercent: number };
  readonly extra?: Record<string, unknown>;
}

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(2)}min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

export function printRunReport(r: RunReport): void {
  console.log(`\n=== ${r.label} ===`);
  console.log(`Total wall time: ${fmtMs(r.totalWallMs)}  |  components: ${r.componentCount}`);
  console.log(`Summary: ${JSON.stringify(r.summary)}`);
  if (r.cache) {
    console.log(`Cache: ${r.cache.hits} hits / ${r.cache.misses} misses (${r.cache.hitRatePercent}% hit rate)`);
  }
  if (r.extra) {
    for (const [k, v] of Object.entries(r.extra)) console.log(`${k}: ${JSON.stringify(v)}`);
  }
  console.log('Phase breakdown (measured, not estimated):');
  const rows = r.phases.rows;
  if (rows.length === 0) {
    console.log('  (no phase timings recorded)');
  }
  for (const row of rows) {
    console.log(
      `  ${row.phase.padEnd(18)} ${fmtMs(row.totalMs).padStart(10)}  ${String(row.percentOfTotal).padStart(5)}%  (${row.calls} call${row.calls === 1 ? '' : 's'})`,
    );
  }
}

export function writeJsonReport(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`\nMachine-readable report written to ${path}`);
}
