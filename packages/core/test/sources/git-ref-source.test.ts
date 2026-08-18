import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitRefSource } from '../../src/sources/git-ref-source.js';

let repoDir: string;

async function writeFileDeep(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

async function commit(message: string): Promise<string> {
  return git.commit({
    fs,
    dir: repoDir,
    message,
    author: { name: 'Test', email: 'test@example.com' },
  });
}

beforeEach(async () => {
  repoDir = await mkdtemp(join(tmpdir(), 'vibeset-git-source-test-'));
  await git.init({ fs, dir: repoDir, defaultBranch: 'main' });

  await writeFileDeep(
    join(repoDir, 'sfdx-project.json'),
    JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }),
  );
  await git.add({ fs, dir: repoDir, filepath: 'sfdx-project.json' });
  await commit('init project');

  await writeFileDeep(join(repoDir, 'force-app/main/default/classes/FooController.cls'), 'public class FooController {}');
  await writeFileDeep(
    join(repoDir, 'force-app/main/default/classes/FooController.cls-meta.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>62.0</apiVersion><status>Active</status></ApexClass>\n',
  );
  await git.add({ fs, dir: repoDir, filepath: '.' });
  await commit('add FooController');

  // A second, later commit that modifies only the .cls body, so the
  // -meta.xml's attributed date should stay at the earlier commit while the
  // .cls (and therefore the component overall) picks up the later one.
  await writeFileDeep(join(repoDir, 'force-app/main/default/classes/FooController.cls'), 'public class FooController { void m() {} }');
  await git.add({ fs, dir: repoDir, filepath: '.' });
  await commit('tweak FooController body');
});

afterEach(async () => {
  await rm(repoDir, { recursive: true, force: true });
});

describe('GitRefSource — no working-directory mutation', () => {
  it('never runs checkout: the real working directory is untouched by inventory/materialize', async () => {
    const source = new GitRefSource('git-1', 'main @ HEAD', repoDir, 'main');
    await source.inventory({});
    await source.materialize([{ type: 'ApexClass', fullName: 'FooController' }]);

    // The working tree still only has what we explicitly wrote via `writeFileDeep`
    // above + git's own .git dir — no checked-out copies, no index mutation
    // artifacts beyond what `git.add`/`git.commit` already produced.
    const status = await git.statusMatrix({ fs, dir: repoDir });
    // Every tracked file should be fully unmodified (HEAD === workdir === stage).
    for (const [, head, workdir, stage] of status) {
      expect([head, workdir, stage]).toEqual([1, 1, 1]);
    }
  });
});

describe('GitRefSource.inventory', () => {
  it('resolves components at the given ref via a content-less tree walk', async () => {
    const source = new GitRefSource('git-1', 'main @ HEAD', repoDir, 'main');
    const inventory = await source.inventory({});
    expect(inventory.entries.map((e) => e.key.fullName)).toContain('FooController');
  });

  it('attributes lastModifiedDate from the commit that last touched each file, via a single log walk', async () => {
    const source = new GitRefSource('git-1', 'main @ HEAD', repoDir, 'main');
    const inventory = await source.inventory({ types: ['ApexClass'] });
    const entry = inventory.entries.find((e) => e.key.fullName === 'FooController');
    expect(entry).toBeDefined();
    expect(entry!.lastModifiedDateUnknown).toBeFalsy();

    const log = await git.log({ fs, dir: repoDir, ref: 'main' });
    const lastCommitDate = new Date(log[0]!.commit.committer.timestamp * 1000).toISOString();
    expect(entry!.lastModifiedDate).toBe(lastCommitDate);
  });

  it('can read an older ref without touching the current working directory contents', async () => {
    const log = await git.log({ fs, dir: repoDir, ref: 'main' });
    const firstCommitOid = log[log.length - 1]!.oid; // "init project" — before FooController existed

    const source = new GitRefSource('git-1', 'main @ first commit', repoDir, firstCommitOid);
    const inventory = await source.inventory({ types: ['ApexClass'] });
    expect(inventory.entries).toHaveLength(0);

    // The real working directory still has the later version on disk.
    const stillThere = await readFile(join(repoDir, 'force-app/main/default/classes/FooController.cls'), 'utf8');
    expect(stillThere).toContain('void m()');
  });
});

describe('GitRefSource.materialize', () => {
  it('reads blob content straight from the object database into a fresh temp dir', async () => {
    const source = new GitRefSource('git-1', 'main @ HEAD', repoDir, 'main');
    const tree = await source.materialize([{ type: 'ApexClass', fullName: 'FooController' }]);

    expect(tree.rootDir).not.toBe(repoDir);
    expect(tree.files.size).toBe(2);
    let sawBody = false;
    for (const [rel, abs] of tree.files) {
      if (rel.endsWith('.cls')) {
        const content = await readFile(abs, 'utf8');
        expect(content).toContain('void m()');
        sawBody = true;
      }
    }
    expect(sawBody).toBe(true);

    await rm(tree.rootDir, { recursive: true, force: true });
  });

  it('reports missing for keys that do not resolve at the ref', async () => {
    const source = new GitRefSource('git-1', 'main @ HEAD', repoDir, 'main');
    const tree = await source.materialize([{ type: 'ApexClass', fullName: 'NoSuchClass' }]);
    expect(tree.missing).toHaveLength(1);
    expect(tree.missing![0]!.key.fullName).toBe('NoSuchClass');
    await rm(tree.rootDir, { recursive: true, force: true });
  });
});
