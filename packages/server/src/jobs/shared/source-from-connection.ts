import { GitRefSource, OrgSource, SfdxProjectSource, type MetadataSource } from '@vibeset/core';
import type { connections } from '../../db/schema.js';

/**
 * Builds the right `MetadataSource` for a stored `connections` row. This is
 * intentionally a small, standalone copy of the same logic
 * `trpc/routers/inventory.ts` already has as a private (unexported)
 * `sourceFromConnectionRow` — that file is 1a/1b-owned and out of scope for
 * this phase to modify, so the `comparisons`/`deploy`/`history` routers
 * (which all need the same connection -> source mapping) share this
 * version instead of either duplicating it three more times or reaching
 * into a sibling router's private internals.
 */
export function sourceFromConnectionRow(row: typeof connections.$inferSelect): MetadataSource {
  switch (row.kind) {
    case 'org': {
      if (!row.username) throw new Error(`Connection ${row.id} is kind "org" but has no username.`);
      return new OrgSource(row.id, row.label, { username: row.username, instanceUrl: row.instanceUrl ?? undefined });
    }
    case 'sfdx-project': {
      if (!row.projectPath) throw new Error(`Connection ${row.id} is kind "sfdx-project" but has no projectPath.`);
      return new SfdxProjectSource(row.id, row.label, row.projectPath);
    }
    case 'git-ref': {
      if (!row.projectPath) throw new Error(`Connection ${row.id} is kind "git-ref" but has no projectPath.`);
      const meta = row.metadataJson ? (JSON.parse(row.metadataJson) as { ref?: string }) : {};
      if (!meta.ref) throw new Error(`Connection ${row.id} is kind "git-ref" but has no ref in metadataJson.`);
      return new GitRefSource(row.id, row.label, row.projectPath, meta.ref);
    }
    default:
      throw new Error(`Unknown connection kind "${row.kind}" for connection ${row.id}.`);
  }
}
