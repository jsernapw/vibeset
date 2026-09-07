import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DependencyEdge } from '@vibeset/core';
import { closeDb, getDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { connections } from '../../src/db/schema.js';
import { DrizzleDependencyGraph, replaceDependencyEdges } from '../../src/store/drizzle-dependency-graph.js';

let tmpHome: string;
let db: Db;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-dependency-graph-test-'));
  process.env.VIBESET_HOME = tmpHome;
  db = getDb();
  runMigrations(db);
  // `dependency_edges.connection_id` is a real FK — insert the connections
  // the tests reference (content otherwise irrelevant to this suite).
  db.insert(connections).values([
    { id: 'conn-1', kind: 'org', label: 'Conn 1', username: 'one@example.com' },
    { id: 'conn-2', kind: 'org', label: 'Conn 2', username: 'two@example.com' },
  ]).run();
});

afterEach(() => {
  closeDb();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

const orgEdge: DependencyEdge = {
  fromType: 'ApexClass',
  fromFullName: 'Foo',
  toType: 'ApexClass',
  toFullName: 'Bar',
  provenance: 'org',
};
const supplementedEdge: DependencyEdge = {
  fromType: 'Profile',
  fromFullName: 'Admin',
  toType: 'ApexClass',
  toFullName: 'Foo',
  provenance: 'supplemented',
  supplementKind: 'profile-grant',
};
const namespacedEdge: DependencyEdge = {
  fromType: 'ApexClass',
  fromFullName: 'omnistudio__Widget',
  toType: 'ApexClass',
  toFullName: 'omnistudio__Helper',
  provenance: 'org',
  fromNamespace: 'omnistudio',
  toNamespace: 'omnistudio',
};

describe('DrizzleDependencyGraph + replaceDependencyEdges (against a real migrated SQLite database)', () => {
  it('round-trips forward and reverse queries, preserving provenance/supplementKind/namespace', async () => {
    replaceDependencyEdges(db, 'conn-1', 'run-1', [orgEdge, supplementedEdge, namespacedEdge]);
    const graph = new DrizzleDependencyGraph(db, 'conn-1');

    const forwardFromFoo = await graph.forward({ type: 'ApexClass', fullName: 'Foo' });
    expect(forwardFromFoo).toEqual([orgEdge]);

    const reverseToFoo = await graph.reverse({ type: 'ApexClass', fullName: 'Foo' });
    expect(reverseToFoo).toEqual([supplementedEdge]);

    const forwardFromWidget = await graph.forward({ type: 'ApexClass', fullName: 'omnistudio__Widget' });
    expect(forwardFromWidget).toEqual([namespacedEdge]);
  });

  it('scopes edges to their connection — a different connectionId sees nothing', async () => {
    replaceDependencyEdges(db, 'conn-1', 'run-1', [orgEdge]);
    const otherGraph = new DrizzleDependencyGraph(db, 'conn-2');

    expect(await otherGraph.forward({ type: 'ApexClass', fullName: 'Foo' })).toEqual([]);
  });

  it('fully replaces a connection\'s edges on re-sync — a stale edge from the prior sync must not survive', async () => {
    replaceDependencyEdges(db, 'conn-1', 'run-1', [orgEdge, supplementedEdge]);
    replaceDependencyEdges(db, 'conn-1', 'run-2', [namespacedEdge]); // simulates a re-sync where Foo->Bar no longer exists

    const graph = new DrizzleDependencyGraph(db, 'conn-1');
    expect(await graph.forward({ type: 'ApexClass', fullName: 'Foo' })).toEqual([]);
    expect(await graph.reverse({ type: 'ApexClass', fullName: 'Foo' })).toEqual([]);
    expect(await graph.forward({ type: 'ApexClass', fullName: 'omnistudio__Widget' })).toEqual([namespacedEdge]);
  });

  it('returns an empty array (not undefined/throw) for a component with no recorded edges at all', async () => {
    replaceDependencyEdges(db, 'conn-1', 'run-1', [orgEdge]);
    const graph = new DrizzleDependencyGraph(db, 'conn-1');
    expect(await graph.forward({ type: 'ApexClass', fullName: 'NeverReferencedOrReferencing' })).toEqual([]);
  });
});
