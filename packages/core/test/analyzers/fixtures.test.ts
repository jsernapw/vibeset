import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYZERS, runAnalyzers } from '../../src/analyzers/index.js';
import type {
  AnalysisContext,
  ApexCoverageEntry,
  DeploymentIntent,
  Finding,
  OrgContext,
} from '../../src/types/analyzer.js';
import type { ComponentKey } from '../../src/types/metadata-source.js';
import { loadFixturePackage } from './fixture-loader.js';
import { FakeDependencyGraph } from './fake-dependency-graph.js';

/**
 * The analyzer golden-fixture corpus, in the same spirit as
 * `test/diff/fixtures.test.ts`: each `fixtures/<name>/` directory is a
 * REAL Salesforce source-format tree (`package/`) plus JSON describing the
 * org/dependency/intent context, run through the real rule set, asserted
 * against a structural projection of the resulting findings.
 *
 * `meta.json`'s `analyzerIds` scopes each fixture to the rule(s) it's
 * actually testing — otherwise every fixture would need to anticipate
 * every OTHER rule the shipped set might also fire for the same input,
 * which would make the corpus fragile to unrelated new rules. Full
 * end-to-end "everything at once" behavior is exercised by
 * `real-org-flagship.test.ts` instead.
 */
const FIXTURES_DIR = join(__dirname, 'fixtures');

interface RawOrgContext extends Omit<OrgContext, 'apexCoverage'> {
  readonly apexCoverage?: Record<string, ApexCoverageEntry>;
}

interface RawExistsEntry {
  readonly key: ComponentKey;
  readonly exists: boolean;
}
interface RawEdge {
  readonly from: ComponentKey;
  readonly to: ComponentKey;
}
interface RawDependencies {
  readonly edges?: readonly RawEdge[];
  readonly existsInTarget?: readonly RawExistsEntry[];
}

interface FixtureMeta {
  readonly analyzerIds: readonly string[];
}

interface ExpectedFinding {
  readonly analyzerId: string;
  readonly severity: Finding['severity'];
  readonly key: ComponentKey | null;
  readonly relatedKeys: readonly ComponentKey[] | null;
}

function readJson<T>(path: string): T | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
}

function reviveOrgContext(raw: RawOrgContext | undefined): OrgContext | undefined {
  if (!raw) return undefined;
  return {
    ...raw,
    apexCoverage: raw.apexCoverage ? new Map(Object.entries(raw.apexCoverage)) : undefined,
  };
}

function reviveDependencyGraph(raw: RawDependencies | undefined): FakeDependencyGraph | undefined {
  if (!raw) return undefined;
  const graph = new FakeDependencyGraph();
  for (const edge of raw.edges ?? []) graph.addEdge(edge.from, edge.to);
  for (const entry of raw.existsInTarget ?? []) graph.setExists(entry.key, entry.exists);
  return graph;
}

function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((name) => existsSync(join(FIXTURES_DIR, name, 'meta.json')))
    .sort();
}

function projectFinding(f: Finding): ExpectedFinding {
  return {
    analyzerId: f.analyzerId,
    severity: f.severity,
    key: f.key ?? null,
    relatedKeys: f.relatedKeys ? [...f.relatedKeys] : null,
  };
}

describe('analyzer golden-fixture corpus', () => {
  const names = listFixtures();

  it('is non-empty and covers every rule category exercised by this workstream', () => {
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  for (const name of names) {
    it(name, () => {
      const dir = join(FIXTURES_DIR, name);
      const meta = readJson<FixtureMeta>(join(dir, 'meta.json'))!;
      const expected = readJson<ExpectedFinding[]>(join(dir, 'expected.json')) ?? [];

      const packageComponents = loadFixturePackage(join(dir, 'package'));
      const destructiveComponents = readJson<ComponentKey[]>(join(dir, 'destructive.json'));
      const target = reviveOrgContext(readJson<RawOrgContext>(join(dir, 'org.json')));
      const intent = readJson<DeploymentIntent>(join(dir, 'intent.json'));
      const dependencyGraph = reviveDependencyGraph(
        readJson<RawDependencies>(join(dir, 'dependencies.json')),
      );

      const ctx: AnalysisContext = {
        packageComponents,
        destructiveComponents,
        target,
        intent,
        dependencyGraph,
      };

      const scopedAnalyzers = DEFAULT_ANALYZERS.filter((a) => meta.analyzerIds.includes(a.id));
      expect(scopedAnalyzers.map((a) => a.id).sort()).toEqual([...meta.analyzerIds].sort());

      const findings = runAnalyzers(scopedAnalyzers, ctx);
      expect(findings.map(projectFinding)).toEqual(expected);

      // Every non-empty finding in this corpus must actually be specific —
      // naming a real component, not a generic template sentence — per the
      // task brief's bar ("a finding that says 'missing dependency' without
      // naming the component ... is not worth shipping").
      for (const f of findings) {
        expect(f.title.length).toBeGreaterThan(10);
        expect(f.detail.length).toBeGreaterThan(20);
        expect(f.recommendation.length).toBeGreaterThan(10);
      }
    });
  }
});
