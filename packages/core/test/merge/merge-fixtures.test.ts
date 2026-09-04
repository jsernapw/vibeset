import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeComponent } from '../../src/merge/dispatch.js';
import type { MergeProfileCoverage } from '../../src/merge/profile-merge.js';
import type { SideCoverage } from '../../src/diff/profiles.js';
import type { MergeInput } from '../../src/types/merge.js';

/**
 * Golden-file fixture corpus for the merge engine — the merge-side sibling
 * of `test/diff/fixtures.test.ts`. Deliberately a SEPARATE directory
 * (`test/fixtures-merge/`, not `test/fixtures/`) rather than reusing the
 * diff corpus's `test/fixtures/` tree: that tree's runner scans every
 * subdirectory with a `meta.json` and feeds it to `diffComponent`, so a
 * merge fixture sitting in the same tree (three sides, a `mode` field, a
 * `MergeResult`-shaped `expected.json`) would silently corrupt that loop.
 *
 * Fixture layout:
 *
 *   test/fixtures-merge/<name>/
 *     meta.json        { "type": "CustomObject", "mode": "two-way"|"three-way", "fullName"?, "profileCoverage"?: {...} }
 *     base/<any-file>   raw content for the merge-base side (three-way only; omit dir for "absent")
 *     left/<any-file>   raw content for the left side (omit dir for "absent")
 *     right/<any-file>  raw content for the right side
 *     expected.json     { mode, entries: MergeEntry[], summary }
 */

const FIXTURES_DIR = join(__dirname, '..', 'fixtures-merge');

interface RawSideCoverage {
  readonly mode: 'full' | 'scoped';
  readonly retrievedComponents?: readonly string[];
}
interface RawProfileCoverage {
  readonly base?: RawSideCoverage;
  readonly left: RawSideCoverage;
  readonly right: RawSideCoverage;
}
interface FixtureMeta {
  readonly type: string;
  readonly fullName?: string;
  readonly mode: 'two-way' | 'three-way';
  readonly profileCoverage?: RawProfileCoverage;
}

function readSingleFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (files.length === 0) return undefined;
  if (files.length > 1) {
    throw new Error(
      `Fixture dir ${dir} has more than one file (${files.join(', ')}) — a fixture side is exactly one file.`,
    );
  }
  return readFileSync(join(dir, files[0]!), 'utf8');
}

function reviveSide(side: RawSideCoverage): SideCoverage {
  return side.mode === 'scoped'
    ? { mode: 'scoped', retrievedComponents: new Set(side.retrievedComponents ?? []) }
    : { mode: 'full' };
}

function reviveCoverage(raw: RawProfileCoverage | undefined): MergeProfileCoverage | undefined {
  if (!raw) return undefined;
  return {
    base: raw.base ? reviveSide(raw.base) : undefined,
    left: reviveSide(raw.left),
    right: reviveSide(raw.right),
  };
}

function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((name) => existsSync(join(FIXTURES_DIR, name, 'meta.json')))
    .sort();
}

describe('golden-file fixture corpus — entry-level merge', () => {
  const names = listFixtures();

  it('is non-empty and covers the required scenario categories', () => {
    expect(names.length).toBeGreaterThanOrEqual(8);
  });

  for (const name of names) {
    it(name, () => {
      const dir = join(FIXTURES_DIR, name);
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));

      const left = readSingleFile(join(dir, 'left'));
      const right = readSingleFile(join(dir, 'right'));
      const key = { type: meta.type, fullName: meta.fullName ?? name };
      const coverage = reviveCoverage(meta.profileCoverage);

      const input: MergeInput =
        meta.mode === 'three-way'
          ? { mode: 'three-way', base: readSingleFile(join(dir, 'base')), left, right }
          : { mode: 'two-way', left, right };

      const result = mergeComponent(key, input, coverage);

      expect({ mode: result.mode, entries: result.entries, summary: result.summary }).toEqual(expected);
    });
  }
});
