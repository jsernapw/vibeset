import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { AuthInfo, Connection } from '@salesforce/core';
import { ComponentSet, MetadataConverter, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { OrgSource, type ComponentKey, type OrgSourceDeps, type RetrieveAndConvertResult } from '@vibeset/core';
import type { PhaseTimer } from './phase-timer.js';

/**
 * Counters that fall out of wrapping `Connection` for the duration of one
 * `OrgSource`, surfaced because the brief specifically asks to "count API
 * round-trips" for inventory.
 */
export interface OrgSourceCounters {
  listMetadataCalls: number;
  listMetadataBatches: number;
  retrieveOperations: number;
}

/**
 * Builds a real `OrgSource` (reads the `sf` CLI's own auth store — VibeSet
 * never stores a credential, see `sources/org-source.ts`) with two of its
 * documented dependency-injection seams used for measurement rather than
 * testing:
 *
 *  - `getConnection`: wraps the live `Connection`'s `metadata.list` so every
 *    `listMetadata` round-trip is counted. This is the same seam
 *    `test/sources/org-source.test.ts` uses to fake a connection; here it
 *    wraps a REAL one.
 *  - `retrieveAndConvert`: replicates `OrgSource`'s own default
 *    implementation (`ComponentSet.retrieve` + `MetadataConverter.convert`)
 *    line-for-line, but times the two SDR calls separately. This is the
 *    only way to split "Retrieve" (network) from "Convert" (SDR, CPU/disk)
 *    without adding a hook to `org-source.ts` itself — which Livia does not
 *    own and was asked not to modify silently. See the harness report for
 *    why this duplication was judged worth it: it directly answers the
 *    brief's central question (network vs. CPU-bound).
 */
export function createInstrumentedOrgSource(
  id: string,
  label: string,
  connectionOptions: { username: string; instanceUrl?: string },
  timer: PhaseTimer,
): { source: OrgSource; counters: OrgSourceCounters } {
  const counters: OrgSourceCounters = { listMetadataCalls: 0, listMetadataBatches: 0, retrieveOperations: 0 };
  const registry = new RegistryAccess();

  const deps: OrgSourceDeps = {
    registry,

    getConnection: async () => {
      const authInfo = await AuthInfo.create({ username: connectionOptions.username });
      const conn = await Connection.create({
        authInfo,
        connectionOptions: connectionOptions.instanceUrl ? { instanceUrl: connectionOptions.instanceUrl } : undefined,
      });
      const originalList = conn.metadata.list.bind(conn.metadata);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (conn.metadata as any).list = async (...args: unknown[]) => {
        counters.listMetadataBatches += 1;
        const queries = args[0] as unknown[] | undefined;
        counters.listMetadataCalls += Array.isArray(queries) ? queries.length : 1;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (originalList as any)(...args);
      };
      return conn;
    },

    retrieveAndConvert: async (
      keys: ComponentKey[],
      destDir: string,
      signal: AbortSignal | undefined,
      connection: Connection,
    ): Promise<RetrieveAndConvertResult> => {
      counters.retrieveOperations += 1;
      const componentSet = new ComponentSet(
        keys.map((k) => ({ type: k.type, fullName: k.fullName })),
        registry,
      );
      componentSet.apiVersion = connection.getApiVersion();

      const mdapiDir = await mkdtemp(join(tmpdir(), 'vibeset-perf-mdapi-'));
      try {
        const operation = await timer.time('retrieve', () =>
          componentSet.retrieve({ usernameOrConnection: connection, output: mdapiDir, merge: false }),
        );

        const onAbort = (): void => {
          void operation.cancel();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        let result;
        try {
          result = await timer.time('retrieve', () => operation.pollStatus());
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        signal?.throwIfAborted();

        const missing = result
          .getFileResponses()
          .filter((fr) => fr.state === 'Failed')
          .map((fr) => ({
            key: { type: fr.type, fullName: fr.fullName },
            reason: 'error' in fr ? fr.error : 'retrieve failed',
          }));

        await timer.time('convert', async () => {
          const converter = new MetadataConverter(registry);
          await converter.convert(result.components, 'source', {
            type: 'directory',
            outputDirectory: destDir,
            genUniqueDir: false,
          });
        });

        const files = new Map<string, string>();
        await walkDir(destDir, destDir, files);

        return { files, missing };
      } finally {
        await rm(mdapiDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };

  const source = new OrgSource(id, label, connectionOptions, deps);
  return { source, counters };
}

async function walkDir(root: string, dir: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(abs, { recursive: true }).catch(() => {});
      await walkDir(root, abs, out);
    } else {
      out.set(relative(root, abs), abs);
    }
  }
}
