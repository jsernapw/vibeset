import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Connection } from '@salesforce/core';
import { ComponentSet, DestructiveChangesType, type DeployResult, type FileResponse, type MetadataApiDeployStatus } from '@salesforce/source-deploy-retrieve';
import { runDeploy, type DeployOperationRunner } from '../../src/deploy/executor.js';
import type { ComponentInventory, ComponentKey, MetadataSource, SourceTree, TypeFilter } from '../../src/types/metadata-source.js';

/** Same fixture-writing pattern as `test/compare/comparison-engine.test.ts` — real files on disk in source format, so `ComponentSet.fromSource` resolves real components without a network round trip. */
class FakeSource implements MetadataSource {
  readonly kind = 'org' as const;
  readonly materializedCalls: ComponentKey[][] = [];

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly bodies: Map<string, string>,
  ) {}

  async inventory(_filter: TypeFilter): Promise<ComponentInventory> {
    return { sourceId: this.id, entries: [] };
  }

  async materialize(keys: ComponentKey[]): Promise<SourceTree> {
    this.materializedCalls.push(keys);
    const rootDir = await mkdtemp(join(tmpdir(), 'vibeset-executor-test-'));
    const files = new Map<string, string>();
    for (const key of keys) {
      const body = this.bodies.get(`${key.type}#${key.fullName}`);
      if (!body) continue;
      const clsRel = `classes/${key.fullName}.cls`;
      const metaRel = `classes/${key.fullName}.cls-meta.xml`;
      const clsAbs = join(rootDir, clsRel);
      await mkdir(dirname(clsAbs), { recursive: true });
      await writeFile(clsAbs, body);
      await writeFile(
        join(rootDir, metaRel),
        '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
      );
      files.set(clsRel, clsAbs);
      files.set(metaRel, join(rootDir, metaRel));
    }
    return { sourceId: this.id, rootDir, files };
  }
}

function fakeConnection(): Connection {
  return {} as Connection;
}

function fakeDeployResult(response: Partial<MetadataApiDeployStatus>, fileResponses: FileResponse[]): DeployResult {
  return {
    response: response as MetadataApiDeployStatus,
    getFileResponses: () => fileResponses,
  } as unknown as DeployResult;
}

describe('runDeploy — orchestration (materialize -> ComponentSet -> normalize), network stubbed via the DeployOperationRunner seam', () => {
  it('materializes only the `components` set, builds a ComponentSet with both regular and destructive members, and normalizes the result', async () => {
    const source = new FakeSource(
      'target',
      'Target Org',
      new Map([['ApexClass#Keep', 'public class Keep {}']]),
    );

    let capturedComponentSet: ComponentSet | undefined;
    let capturedOptions: unknown;
    const runDeployOperation: DeployOperationRunner = async (cs, _conn, options) => {
      capturedComponentSet = cs;
      capturedOptions = options;
      return fakeDeployResult(
        {
          id: 'D1',
          checkOnly: false,
          done: true,
          success: true,
          status: 'Succeeded',
          numberComponentErrors: 0,
          numberComponentsDeployed: 1,
          numberComponentsTotal: 1,
          details: {},
        },
        [{ fullName: 'Keep', type: 'ApexClass', filePath: 'classes/Keep.cls', state: 'Changed' as never }],
      );
    };

    const progressLines: string[] = [];
    const { result, diagnostics } = await runDeploy({
      usernameOrConnection: fakeConnection(),
      targetOrgId: 'org-1',
      source,
      components: [{ type: 'ApexClass', fullName: 'Keep' }],
      destructiveComponents: [{ type: 'ApexClass', fullName: 'RemoveMe' }],
      options: { checkOnly: false, testLevel: 'NoTestRun' },
      runDeployOperation,
      onProgress: (_pct, msg) => progressLines.push(msg),
    });

    expect(source.materializedCalls).toEqual([[{ type: 'ApexClass', fullName: 'Keep' }]]);
    expect(capturedComponentSet!.has({ fullName: 'Keep', type: 'ApexClass' })).toBe(true);
    expect(capturedComponentSet!.getTypesOfDestructiveChanges()).toContain(DestructiveChangesType.POST);
    expect(capturedOptions).toEqual({ checkOnly: false, testLevel: 'NoTestRun' });

    expect(result.deploymentId).toBe('D1');
    expect(result.targetOrgId).toBe('org-1');
    expect(result.status).toBe('succeeded');
    expect(result.checkOnly).toBe(false);
    expect(result.componentResults).toEqual([{ key: { type: 'ApexClass', fullName: 'Keep' }, status: 'succeeded', changed: true }]);
    expect(result.validationId).toBeUndefined(); // not a checkOnly run
    expect(diagnostics).toEqual({ testFailures: [], coverageWarnings: [], componentFailures: [] });
    expect(progressLines.some((l) => l.includes('Keep'))).toBe(true); // per-component line was relayed
  });

  it('does not call materialize at all for a destructive-only deploy (no components to fetch content for)', async () => {
    const source = new FakeSource('target', 'Target Org', new Map());
    const runDeployOperation: DeployOperationRunner = async () =>
      fakeDeployResult(
        { id: 'D2', checkOnly: false, done: true, success: true, status: 'Succeeded', numberComponentErrors: 0, numberComponentsDeployed: 0, numberComponentsTotal: 0, details: {} },
        [],
      );

    await runDeploy({
      usernameOrConnection: fakeConnection(),
      targetOrgId: 'org-1',
      source,
      components: [],
      destructiveComponents: [{ type: 'ApexClass', fullName: 'RemoveMe' }],
      options: { checkOnly: false, testLevel: 'NoTestRun' },
      runDeployOperation,
    });

    expect(source.materializedCalls).toEqual([]);
  });

  it('sets validationId on the result when options.checkOnly is true', async () => {
    const source = new FakeSource('target', 'Target Org', new Map());
    const runDeployOperation: DeployOperationRunner = async () =>
      fakeDeployResult(
        { id: 'V1', checkOnly: true, done: true, success: true, status: 'Succeeded', numberComponentErrors: 0, numberComponentsDeployed: 0, numberComponentsTotal: 0, details: {} },
        [],
      );

    const { result } = await runDeploy({
      usernameOrConnection: fakeConnection(),
      targetOrgId: 'org-1',
      source,
      components: [],
      destructiveComponents: [],
      options: { checkOnly: true, testLevel: 'NoTestRun' },
      runDeployOperation,
    });

    expect(result.validationId).toBe('V1');
    expect(result.checkOnly).toBe(true);
  });

  it('maps a failed deploy status to status: "failed" and surfaces component failure diagnostics', async () => {
    const source = new FakeSource('target', 'Target Org', new Map());
    const runDeployOperation: DeployOperationRunner = async () =>
      fakeDeployResult(
        {
          id: 'D3',
          checkOnly: false,
          done: true,
          success: false,
          status: 'Failed',
          numberComponentErrors: 1,
          numberComponentsDeployed: 0,
          numberComponentsTotal: 1,
          details: { componentFailures: [{ fullName: 'Bad', componentType: 'ApexClass', problem: 'Compile error' } as never] },
        },
        [{ fullName: 'Bad', type: 'ApexClass', state: 'Failed', error: 'Compile error' } as unknown as FileResponse],
      );

    const { result, diagnostics } = await runDeploy({
      usernameOrConnection: fakeConnection(),
      targetOrgId: 'org-1',
      source,
      components: [],
      destructiveComponents: [],
      options: { checkOnly: false, testLevel: 'NoTestRun' },
      runDeployOperation,
    });

    expect(result.status).toBe('failed');
    expect(result.componentResults[0]!.status).toBe('failed');
    expect(diagnostics.componentFailures).toEqual([{ type: 'ApexClass', fullName: 'Bad', problem: 'Compile error', lineNumber: undefined, columnNumber: undefined }]);
  });

  it('cleans up the materialized temp directory even after a successful deploy', async () => {
    const source = new FakeSource('target', 'Target Org', new Map([['ApexClass#Keep', 'public class Keep {}']]));
    let materializedRootDir: string | undefined;
    const originalMaterialize = source.materialize.bind(source);
    source.materialize = async (keys) => {
      const tree = await originalMaterialize(keys);
      materializedRootDir = tree.rootDir;
      return tree;
    };

    const runDeployOperation: DeployOperationRunner = async () =>
      fakeDeployResult(
        { id: 'D4', checkOnly: false, done: true, success: true, status: 'Succeeded', numberComponentErrors: 0, numberComponentsDeployed: 1, numberComponentsTotal: 1, details: {} },
        [],
      );

    await runDeploy({
      usernameOrConnection: fakeConnection(),
      targetOrgId: 'org-1',
      source,
      components: [{ type: 'ApexClass', fullName: 'Keep' }],
      destructiveComponents: [],
      options: { checkOnly: false, testLevel: 'NoTestRun' },
      runDeployOperation,
    });

    expect(materializedRootDir).toBeDefined();
    expect(existsSync(materializedRootDir!)).toBe(false);
  });
});
