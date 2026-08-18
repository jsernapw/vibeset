import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffComponent } from '../../src/diff/dispatch.js';
import type { ProfileDiffContext, SideCoverage } from '../../src/diff/profiles.js';

/**
 * The golden-file fixture corpus runner. Per the task brief, this is meant
 * to be "the single highest-value test investment in the project" — every
 * false positive/negative that's ever reported against the diff engine
 * should become a permanent fixture here.
 *
 * Fixture layout (adding one is meant to be trivial):
 *
 *   test/fixtures/<name>/
 *     meta.json        { "type": "CustomObject", "profileContext"?: {...} }
 *     left/<any-file>   raw content for the left/source side (omit dir/leave empty for "absent")
 *     right/<any-file>  raw content for the right/target side
 *     expected.json     { status, hashesEqual?, entries?, textDiff? }
 *
 * `expected.json` is a *projection* of `DiffResult`, not the raw type: raw
 * sha256 hex digests aren't asserted literally (meaningless as literals —
 * what matters is whether the two sides hash equal), so `hashesEqual` is
 * asserted instead whenever both sides have content. `entries`/`textDiff`
 * are asserted verbatim when the fixture's DiffResult has them.
 *
 * On failure, vitest's own `toEqual` prints a structural diff of expected
 * vs. actual (not an opaque assertion failure) — exactly what you want
 * when a fixture regresses: the fixture name is in the test title, and the
 * mismatched fields are visible directly in the failure output.
 */

const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

interface RawSideCoverage {
  readonly mode: 'full' | 'scoped';
  readonly retrievedComponents?: readonly string[];
}
interface RawProfileContext {
  readonly left: RawSideCoverage;
  readonly right: RawSideCoverage;
}
interface FixtureMeta {
  readonly type: string;
  readonly fullName?: string;
  readonly profileContext?: RawProfileContext;
}

function readSingleFile(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (files.length === 0) return undefined;
  if (files.length > 1) {
    throw new Error(
      `Fixture dir ${dir} has more than one file (${files.join(', ')}) — a fixture component is exactly one file.`,
    );
  }
  return readFileSync(join(dir, files[0]!), 'utf8');
}

function reviveSide(side: RawSideCoverage): SideCoverage {
  return side.mode === 'scoped'
    ? { mode: 'scoped', retrievedComponents: new Set(side.retrievedComponents ?? []) }
    : { mode: 'full' };
}

function reviveContext(raw: RawProfileContext | undefined): ProfileDiffContext | undefined {
  if (!raw) return undefined;
  return { left: reviveSide(raw.left), right: reviveSide(raw.right) };
}

function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((name) => existsSync(join(FIXTURES_DIR, name, 'meta.json')))
    .sort();
}

describe('golden-file fixture corpus', () => {
  const names = listFixtures();

  it('is non-empty and covers the required categories', () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  for (const name of names) {
    it(name, () => {
      const dir = join(FIXTURES_DIR, name);
      const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as FixtureMeta;
      const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8'));

      const left = readSingleFile(join(dir, 'left'));
      const right = readSingleFile(join(dir, 'right'));
      const key = { type: meta.type, fullName: meta.fullName ?? name };
      const ctx = reviveContext(meta.profileContext);

      const result = ctx ? diffComponent(key, left, right, ctx) : diffComponent(key, left, right);

      const actual: Record<string, unknown> = { status: result.status };
      if (left !== undefined && right !== undefined) {
        actual.hashesEqual = result.leftSha256 === result.rightSha256;
      }
      if (result.entries) actual.entries = result.entries;
      if (result.textDiff) actual.textDiff = result.textDiff;

      expect(actual).toEqual(expected);
    });
  }
});
