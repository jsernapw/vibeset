import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Generates a synthetic local SFDX project of `ApexClass` components, the
 * vehicle the brief calls for to exercise the 50k-component target: real
 * orgs registered in this environment (RCA DEV, ARM DEV) only have hundreds
 * of components, so the 50k scale can only be produced synthetically.
 * `SfdxProjectSource` (already implemented, network-free) reads whatever
 * lands on disk here with zero changes needed on VibeSet's side — this file
 * only writes files, it never touches `packages/core/src`.
 *
 * ApexClass specifically (not a mix of types) because it is the exact type
 * the >10-minute cold-run baseline in the plan doc was measured against
 * (406 ApexClass components, RCA DEV vs ARM DEV) — using the same type here
 * keeps the synthetic numbers comparable to that baseline in kind, even
 * though the org run is network-bound and this one is local-disk-bound.
 */

const META_XML = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexClass>\n`;

function classBody(name: string, variant: number): string {
  const fieldCount = 3 + (variant % 7);
  const lines: string[] = [`public class ${name} {`];
  for (let i = 0; i < fieldCount; i += 1) {
    lines.push(`    private Integer field${i} = ${(variant + i) % 100};`);
  }
  lines.push(`    public Integer compute(Integer x) {`, `        Integer result = x;`);
  for (let i = 0; i < fieldCount; i += 1) lines.push(`        result += field${i};`);
  lines.push(`        return result;`, `    }`, `}`);
  return lines.join('\n') + '\n';
}

export interface GenerateApexProjectOptions {
  /** Number of base-indexed components (SyntheticClass0..SyntheticClass{count-1}). */
  readonly count: number;
  /** Base indices to omit entirely — simulates components deleted on this side. */
  readonly skipIndices?: ReadonlySet<number>;
  /** Base indices whose body should differ from the "canonical" variant for that index — simulates components changed on this side. */
  readonly changedIndices?: ReadonlySet<number>;
  /** How many EXTRA components (indices count..count+extraCount-1) to add beyond the base set — simulates components new on this side. */
  readonly extraCount?: number;
  readonly writeConcurrency?: number;
}

export interface GenerateApexProjectResult {
  readonly written: number;
  readonly generateMs: number;
}

export async function generateSyntheticApexProject(
  projectDir: string,
  options: GenerateApexProjectOptions,
): Promise<GenerateApexProjectResult> {
  const start = performance.now();
  const classesDir = join(projectDir, 'force-app', 'main', 'default', 'classes');
  await rm(projectDir, { recursive: true, force: true });
  await mkdir(classesDir, { recursive: true });
  await writeFile(
    join(projectDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }], namespace: '', sourceApiVersion: '62.0' }, null, 2),
  );

  const skip = options.skipIndices ?? new Set<number>();
  const changed = options.changedIndices ?? new Set<number>();
  const total = options.count + (options.extraCount ?? 0);
  const concurrency = options.writeConcurrency ?? 200;

  let written = 0;
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      if (i < options.count && skip.has(i)) continue;
      const name = `SyntheticClass${i}`;
      const variant = i < options.count && changed.has(i) ? i + 1_000_000 : i;
      await Promise.all([
        writeFile(join(classesDir, `${name}.cls`), classBody(name, variant)),
        writeFile(join(classesDir, `${name}.cls-meta.xml`), META_XML),
      ]);
      written += 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return { written, generateMs: performance.now() - start };
}

/** Deterministic (not random — reproducible across runs) subset of `[0, count)`, taking every `nth` index. */
export function everyNth(count: number, nth: number): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < count; i += nth) set.add(i);
  return set;
}
