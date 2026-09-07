import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentInventory, ComponentKey, SourceTree, ToolingQueryPage } from '@vibeset/core';
import { closeDb, getDb, type Db } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { connections, dependencyEdges, dependencySyncRuns } from '../src/db/schema.js';
import { syncDependenciesForSource, type DependencySource } from '../src/trpc/routers/dependencies.js';

let tmpHome: string;
let materializedDir: string;
let db: Db;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-dep-sync-test-'));
  process.env.VIBESET_HOME = tmpHome;
  db = getDb();
  runMigrations(db);

  db.insert(connections).values({ id: 'conn-1', kind: 'org', label: 'Test Org', username: 'test@example.com' }).run();
  db.insert(dependencySyncRuns).values({ id: 'run-1', connectionId: 'conn-1', status: 'running' }).run();

  materializedDir = await mkdtemp(join(tmpdir(), 'vibeset-dep-sync-materialize-'));
});

afterEach(async () => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  await rm(materializedDir, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

/** One page of raw `MetadataComponentDependency` — an org edge (ApexClass -> ApexClass) plus a managed-package edge, to prove namespace filtering runs. */
function toolingPage(): ToolingQueryPage<any> {
  return {
    done: true,
    records: [
      {
        MetadataComponentId: '01p1',
        MetadataComponentType: 'ApexClass',
        MetadataComponentName: 'ControllerClass',
        MetadataComponentNamespace: null,
        RefMetadataComponentId: '01p2',
        RefMetadataComponentType: 'ApexClass',
        RefMetadataComponentName: 'HelperClass',
        RefMetadataComponentNamespace: null,
      },
      {
        MetadataComponentId: '01p3',
        MetadataComponentType: 'ApexClass',
        MetadataComponentName: 'omnistudio__Widget',
        MetadataComponentNamespace: 'omnistudio',
        RefMetadataComponentId: '01p4',
        RefMetadataComponentType: 'ApexClass',
        RefMetadataComponentName: 'omnistudio__Helper',
        RefMetadataComponentNamespace: 'omnistudio',
      },
    ],
  };
}

/** Writes real, SDR-resolvable source-format files for one Profile, one PermissionSet, and one Layout — so `resolveComponentContents` (real SDR `MetadataResolver`, not mocked) can actually find and read them, exactly the way a real retrieve would leave them on disk. */
async function writeSupplementFixtures(rootDir: string): Promise<void> {
  await mkdir(join(rootDir, 'profiles'), { recursive: true });
  await writeFile(
    join(rootDir, 'profiles', 'Admin.profile-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><classAccesses><apexClass>ControllerClass</apexClass><enabled>true</enabled></classAccesses></Profile>\n`,
  );

  await mkdir(join(rootDir, 'permissionsets'), { recursive: true });
  await writeFile(
    join(rootDir, 'permissionsets', 'MyPermSet.permissionset-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><pageAccesses><apexPage>MyPage</apexPage><enabled>true</enabled></pageAccesses></PermissionSet>\n`,
  );

  await mkdir(join(rootDir, 'layouts'), { recursive: true });
  await writeFile(
    join(rootDir, 'layouts', 'Account-Account Layout.layout-meta.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<Layout xmlns="http://soap.sforce.com/2006/04/metadata"><layoutSections><layoutColumns><layoutItems><field>Custom_Field__c</field></layoutItems></layoutColumns></layoutSections></Layout>\n`,
  );
}

function fakeSource(rootDir: string): DependencySource {
  return {
    id: 'conn-1',
    kind: 'org',
    label: 'Test Org',
    async toolingClient() {
      return {
        async query<T>() {
          return toolingPage() as ToolingQueryPage<T>;
        },
        async queryMore<T>() {
          throw new Error('should not page beyond one done:true page');
        },
      };
    },
    async inventory(): Promise<ComponentInventory> {
      return {
        sourceId: 'conn-1',
        entries: [
          { key: { type: 'Profile', fullName: 'Admin' }, lastModifiedDate: '2026-01-01' },
          { key: { type: 'PermissionSet', fullName: 'MyPermSet' }, lastModifiedDate: '2026-01-01' },
          { key: { type: 'Layout', fullName: 'Account-Account Layout' }, lastModifiedDate: '2026-01-01' },
        ],
      };
    },
    async materialize(_keys: ComponentKey[]): Promise<SourceTree> {
      return { sourceId: 'conn-1', rootDir, files: new Map() };
    },
  };
}

describe('syncDependenciesForSource (fake DependencySource + real SDR file resolution)', () => {
  it('combines org-authoritative and supplemented edges, persists them, and marks the run succeeded', async () => {
    await writeSupplementFixtures(materializedDir);
    const source = fakeSource(materializedDir);

    const result = await syncDependenciesForSource(db, 'conn-1', 'run-1', source, {});

    expect(result.orgEdgeCount).toBe(2); // ControllerClass->HelperClass + the namespaced pair
    expect(result.supplementedEdgeCount).toBe(3); // Profile->ApexClass, PermissionSet->ApexPage, Layout->CustomField
    expect(result.totalEdgeCount).toBe(5);
    expect(result.managedPackageEdgeCount).toBe(1); // only the omnistudio__ pair touches a namespace

    const run = db.select().from(dependencySyncRuns).where(eq(dependencySyncRuns.id, 'run-1')).get();
    expect(run?.status).toBe('succeeded');
    expect(run?.orgEdgeCount).toBe(2);
    expect(run?.supplementedEdgeCount).toBe(3);
    expect(run?.completedAt).toBeTruthy();

    const rows = db.select().from(dependencyEdges).where(eq(dependencyEdges.connectionId, 'conn-1')).all();
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.authoritative)).toHaveLength(2);
    expect(rows.filter((r) => !r.authoritative)).toHaveLength(3);
    expect(rows.find((r) => r.fromFullName === 'Admin')).toMatchObject({
      fromType: 'Profile',
      toType: 'ApexClass',
      toFullName: 'ControllerClass',
      source: 'supplemented:profile-grant',
      authoritative: false,
    });
    expect(rows.find((r) => r.fromFullName === 'Account-Account Layout')).toMatchObject({
      toType: 'CustomField',
      toFullName: 'Custom_Field__c',
      source: 'supplemented:layout-field-reference',
    });
  });

  it('excludes managed-package edges from the Tooling API result when excludeManagedPackages is set, but leaves supplemented edges untouched by that setting', async () => {
    await writeSupplementFixtures(materializedDir);
    const source = fakeSource(materializedDir);

    const result = await syncDependenciesForSource(db, 'conn-1', 'run-1', source, { excludeManagedPackages: true });

    expect(result.orgEdgeCount).toBe(1); // the omnistudio__ pair is excluded
    expect(result.managedPackageEdgeCount).toBe(0);
  });

  it('skips the Profile/PermissionSet/Layout backfill entirely when includeSupplemented is false', async () => {
    const source = fakeSource(materializedDir); // no fixtures written — would fail if this path were exercised
    const result = await syncDependenciesForSource(db, 'conn-1', 'run-1', source, { includeSupplemented: false });

    expect(result.supplementedEdgeCount).toBe(0);
    expect(result.orgEdgeCount).toBe(2);
  });

  it('marks the run failed and records the error when the source throws', async () => {
    const failingSource: DependencySource = {
      ...fakeSource(materializedDir),
      async toolingClient() {
        throw new Error('simulated auth failure');
      },
    };

    await expect(syncDependenciesForSource(db, 'conn-1', 'run-1', failingSource, {})).rejects.toThrow('simulated auth failure');

    const run = db.select().from(dependencySyncRuns).where(eq(dependencySyncRuns.id, 'run-1')).get();
    expect(run?.status).toBe('failed');
    expect(run?.errorsJson).toContain('simulated auth failure');
  });

  it('fully replaces edges on a second sync run for the same connection (no stale rows survive)', async () => {
    const source = fakeSource(materializedDir);
    await syncDependenciesForSource(db, 'conn-1', 'run-1', source, { includeSupplemented: false });
    expect(db.select().from(dependencyEdges).where(eq(dependencyEdges.connectionId, 'conn-1')).all()).toHaveLength(2);

    db.insert(dependencySyncRuns).values({ id: 'run-2', connectionId: 'conn-1', status: 'running' }).run();
    const emptySource: DependencySource = {
      ...source,
      async toolingClient() {
        return { async query<T>() { return { done: true, records: [] } as ToolingQueryPage<T>; }, async queryMore<T>() { throw new Error('n/a'); } };
      },
    };
    await syncDependenciesForSource(db, 'conn-1', 'run-2', emptySource, { includeSupplemented: false });

    expect(db.select().from(dependencyEdges).where(eq(dependencyEdges.connectionId, 'conn-1')).all()).toHaveLength(0);
  });
});
