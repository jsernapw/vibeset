import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';

let started: StartedServer;
let tmpHome: string;
let leftProjectDir: string; // "target org" content (unchanged side)
let rightProjectDir: string; // "desired/source" content — what's being deployed
let targetOrgProjectDir: string; // stands in for the deploy TARGET's inventory (existsInTarget)

function authHeaders(): Record<string, string> {
  return { 'x-vibeset-token': started.token, origin: `http://127.0.0.1:${started.port}` };
}

async function trpcQuery(path: string, input: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, {
    headers: authHeaders(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.result.data;
}

async function trpcMutate(path: string, input: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${started.port}/trpc/${path}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body.result.data;
}

async function waitForJob(jobId: string): Promise<any> {
  let job: any;
  for (let i = 0; i < 200; i += 1) {
    job = await trpcQuery('jobs.get', { jobId });
    if (job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled')) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Job ${jobId} did not reach a terminal state in time (last status: ${job?.status})`);
}

async function writeSfdxProjectShell(dir: string): Promise<void> {
  await writeFile(join(dir, 'sfdx-project.json'), JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }));
}

const LAYOUT_FULL_NAME = 'Account-Account Layout';

async function writeLayoutReferencingMissingField(dir: string): Promise<void> {
  await mkdir(join(dir, 'force-app/main/default/layouts'), { recursive: true });
  await writeFile(
    join(dir, `force-app/main/default/layouts/${LAYOUT_FULL_NAME}.layout-meta.xml`),
    `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <label>Information</label>
        <layoutColumns>
            <layoutItems>
                <field>Missing__c</field>
                <behavior>Edit</behavior>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
</Layout>
`,
  );
}

async function writeApexProject(dir: string, body: string): Promise<void> {
  await writeSfdxProjectShell(dir);
  await mkdir(join(dir, 'force-app/main/default/classes'), { recursive: true });
  await writeFile(join(dir, 'force-app/main/default/classes/Foo.cls'), body);
  await writeFile(
    join(dir, 'force-app/main/default/classes/Foo.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-analyze-router-test-'));
  process.env.VIBESET_HOME = tmpHome;
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0 });
});

afterAll(async () => {
  await started.close();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

beforeEach(async () => {
  leftProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-analyze-left-'));
  rightProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-analyze-right-'));
  targetOrgProjectDir = await mkdtemp(join(tmpdir(), 'vibeset-analyze-target-'));
  await writeSfdxProjectShell(targetOrgProjectDir);
  await mkdir(join(targetOrgProjectDir, 'force-app/main/default'), { recursive: true });
});

afterEach(async () => {
  await rm(leftProjectDir, { recursive: true, force: true });
  await rm(rightProjectDir, { recursive: true, force: true });
  await rm(targetOrgProjectDir, { recursive: true, force: true });
});

describe('analyze router', () => {
  it('listAnalyzers returns every shipped analyzer, including the flagship coverage rule and the missing-dependency rules', async () => {
    const analyzers = await trpcQuery('analyze.listAnalyzers', undefined);
    const ids = analyzers.map((a: any) => a.id);
    expect(ids).toContain('coverage/production-run-local-tests-gate');
    expect(ids).toContain('dependencies/layout-missing-field');
    expect(ids).toContain('destructive/deleting-referenced-component');
    expect(analyzers.length).toBeGreaterThanOrEqual(20); // Phase 3's 23-rule set
  });

  it('rejects a call with neither packageId nor comparisonId', async () => {
    await expect(trpcMutate('analyze.run', { components: [{ type: 'ApexClass', fullName: 'Foo' }] })).rejects.toThrow(
      /analyze\.run requires either/,
    );
  });

  it('runs against a real deployment package (packageId path) with no target — findings run, target/dependencyGraph are honestly absent, not defaulted', async () => {
    await writeApexProject(leftProjectDir, 'public class Foo { Integer v = 1; }');
    await writeApexProject(rightProjectDir, 'public class Foo { Integer v = 2; }');
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['ApexClass'] },
    });
    await waitForJob(jobId);

    const built = await trpcMutate('deploy.buildPackage', {
      comparisonId,
      name: 'Analyze Test Package',
      selectedKeys: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    const result = await trpcMutate('analyze.run', { packageId: built.packageId });

    expect(result.packageComponentCount).toBe(1);
    expect(result.destructiveComponentCount).toBe(0);
    expect(result.unresolvedComponents).toEqual([]);
    expect(result.target).toBeUndefined(); // no targetConnectionId given — never guessed
    expect(result.dependencyGraphApplied).toBe(false);
    expect(Array.isArray(result.knownCoverageGaps)).toBe(true);
    expect(result.knownCoverageGaps.length).toBeGreaterThan(0);
    expect(Array.isArray(result.findings)).toBe(true);
  });

  it('runs against an explicit comparisonId + components (no saved package needed) — the "review before you build a package" path', async () => {
    await writeApexProject(leftProjectDir, 'public class Foo { Integer v = 1; }');
    await writeApexProject(rightProjectDir, 'public class Foo { Integer v = 2; }');
    const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
    const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });

    const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
      leftConnectionId: leftId,
      rightConnectionId: rightId,
      filter: { types: ['ApexClass'] },
    });
    await waitForJob(jobId);

    const result = await trpcMutate('analyze.run', {
      comparisonId,
      components: [{ type: 'ApexClass', fullName: 'Foo' }],
    });

    expect(result.packageComponentCount).toBe(1);
    expect(result.unresolvedComponents).toEqual([]);
  });

  it(
    'end-to-end THE JOIN: a Layout referencing a field confirmed absent from the target org inventory produces a ' +
      'real dependencies/layout-missing-field finding — via the real DrizzleDependencyGraph + buildAnalyzerDependencyGraph ' +
      'adapter + a real MetadataSource.inventory() call, not FakeDependencyGraph',
    async () => {
      await writeSfdxProjectShell(leftProjectDir);
      await mkdir(join(leftProjectDir, 'force-app/main/default'), { recursive: true });
      await writeLayoutReferencingMissingField(rightProjectDir);
      await writeSfdxProjectShell(rightProjectDir); // sfdx-project.json alongside the layout

      const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
      const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });
      const { id: targetOrgId } = await trpcMutate('connections.add', {
        kind: 'sfdx-project',
        label: 'Target Org Inventory',
        projectPath: targetOrgProjectDir, // deliberately has NO CustomField anywhere — confirmed absent
      });

      const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
        leftConnectionId: leftId,
        rightConnectionId: rightId,
        filter: { types: ['Layout'] },
      });
      await waitForJob(jobId);

      const result = await trpcMutate('analyze.run', {
        comparisonId,
        components: [{ type: 'Layout', fullName: LAYOUT_FULL_NAME }],
        targetConnectionId: targetOrgId,
      });

      expect(result.packageComponentCount).toBe(1);
      expect(result.dependencyGraphApplied).toBe(true);
      // target is an sfdx-project, not an OrgSource — OrgContext stays honestly undefined.
      expect(result.target).toBeUndefined();

      const finding = result.findings.find((f: any) => f.analyzerId === 'dependencies/layout-missing-field');
      expect(finding).toBeDefined();
      expect(finding.relatedKeys).toEqual([{ type: 'CustomField', fullName: 'Account.Missing__c', parentFullName: 'Account' }]);
      expect(finding.severity).toBe('error');
    },
  );

  it(
    'unknown stays unknown: the SAME missing-field Layout produces NO finding when no targetConnectionId is given ' +
      '(existsInTarget is never queried, so the rule fails closed instead of guessing absence)',
    async () => {
      await writeSfdxProjectShell(leftProjectDir);
      await mkdir(join(leftProjectDir, 'force-app/main/default'), { recursive: true });
      await writeLayoutReferencingMissingField(rightProjectDir);
      await writeSfdxProjectShell(rightProjectDir);

      const { id: leftId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Target', projectPath: leftProjectDir });
      const { id: rightId } = await trpcMutate('connections.add', { kind: 'sfdx-project', label: 'Source', projectPath: rightProjectDir });

      const { comparisonId, jobId } = await trpcMutate('comparisons.start', {
        leftConnectionId: leftId,
        rightConnectionId: rightId,
        filter: { types: ['Layout'] },
      });
      await waitForJob(jobId);

      const result = await trpcMutate('analyze.run', {
        comparisonId,
        components: [{ type: 'Layout', fullName: LAYOUT_FULL_NAME }],
        // no targetConnectionId at all
      });

      expect(result.dependencyGraphApplied).toBe(false);
      const finding = result.findings.find((f: any) => f.analyzerId === 'dependencies/layout-missing-field');
      expect(finding).toBeUndefined();
    },
  );

  it('rejects an unknown packageId', async () => {
    await expect(trpcMutate('analyze.run', { packageId: 'does-not-exist' })).rejects.toThrow(/No deployment package with id/);
  });

  it('rejects an unknown comparisonId', async () => {
    await expect(
      trpcMutate('analyze.run', { comparisonId: 'does-not-exist', components: [{ type: 'ApexClass', fullName: 'Foo' }] }),
    ).rejects.toThrow(/No comparison with id/);
  });
});
