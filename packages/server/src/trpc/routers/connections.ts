import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { OrgSource, listAuthorizedOrgs } from '@vibeset/core';
import type { JobHandler } from '../../jobs/job-runner.js';
import { connections } from '../../db/schema.js';
import { publicProcedure, router } from '../trpc.js';

const execFileAsync = promisify(execFile);

export interface LoginWebJobPayload {
  readonly alias: string;
}

/**
 * The `sf` CLI decorates stderr with ANSI colour and prepends an unrelated
 * "update available" notice, both of which bury the actual failure when shown
 * in the UI. Strip the escape codes and drop the advisory lines so the user
 * sees the real reason the login failed.
 */
export function cleanSfStderr(raw: string): string {
  // eslint-disable-next-line no-control-regex
  // Explicit \u001b escape: matching a bare "[..m" would also eat
  // legitimate text that merely looks like a colour code.
  const noAnsi = raw.replace(/\u001b\[[0-9;]*m/g, '');
  return noAnsi
    .split('\n')
    .filter((line) => !/Warning:\s*@salesforce\/cli update available/i.test(line))
    .map((line) => line.replace(/^\s*›\s*/, '').trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
    .trim();
}

/**
 * The `'login-web'` job handler: shells out to `sf org login web`, which
 * opens the user's browser and blocks until they finish the OAuth flow.
 *
 * This is a job rather than a plain mutation for one reason: it waits on a
 * human. Held open as a request/response mutation it routinely outlives the
 * Vite dev proxy's tolerance, and the tRPC client then chokes on the cut-off
 * body with "Unable to transform response from server" — while `sf` is still
 * happily waiting in the background. As a job, the HTTP call returns a jobId
 * immediately and the UI follows progress over `/ws/jobs/:jobId`.
 *
 * VibeSet still never sees a credential: the `sf` CLI performs the login and
 * owns the resulting token in its own auth store.
 */
export function createLoginWebJobHandler(): JobHandler {
  return async (payload, { signal, onProgress }) => {
    const { alias } = payload as LoginWebJobPayload;

    onProgress(10, `Opening your browser to log in as "${alias}"...`);

    const child = execFileAsync('sf', ['org', 'login', 'web', '--alias', alias], {
      // Generous: bounded only so a login the user silently abandoned cannot
      // leave an `sf` process (and this job) alive forever.
      timeout: 10 * 60 * 1000,
    });

    // Cancelling the job must also kill the CLI, or the browser tab keeps
    // waiting on a login nothing is listening for any more.
    const onAbort = () => child.child.kill();
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      onProgress(30, 'Waiting for you to complete login in the browser...');
      await child;
    } catch (err) {
      const e = err as { killed?: boolean; stderr?: string; message?: string };
      if (signal.aborted) throw new Error('Login canceled.');
      if (e.killed) {
        throw new Error(
          `Login timed out after 10 minutes waiting for the browser flow to complete for alias "${alias}".`,
        );
      }
      // `sf`'s stderr is far more useful than execFile's generic message —
      // once the colour codes and the unrelated "update available" notice
      // are stripped out of it.
      const detail = cleanSfStderr(e.stderr ?? '') || e.message || 'unknown error';
      throw new Error(`'sf org login web' failed: ${detail}`);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }

    onProgress(80, 'Login complete — reading the CLI auth store...');
    const orgs = await listAuthorizedOrgs();
    const authorized = orgs.find((o) => o.alias === alias);
    if (!authorized) {
      throw new Error(`'sf org login web' completed but no authorization for alias "${alias}" was found.`);
    }

    onProgress(100, `Authorized ${authorized.username}.`);
    return authorized;
  };
}

const AddConnectionInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('org'),
    label: z.string().min(1),
    username: z.string().min(1),
    alias: z.string().optional(),
    instanceUrl: z.string().optional(),
    isSandbox: z.boolean().optional(),
    apiVersion: z.string().optional(),
  }),
  z.object({
    kind: z.literal('sfdx-project'),
    label: z.string().min(1),
    projectPath: z.string().min(1),
  }),
  z.object({
    kind: z.literal('git-ref'),
    label: z.string().min(1),
    projectPath: z.string().min(1),
    gitRef: z.string().min(1),
  }),
]);

/**
 * Connections + org connectivity. VibeSet never stores a credential of its
 * own: `listAuthorizedOrgs`/`healthCheck` read the `sf` CLI's local auth
 * store via `@salesforce/core`'s `AuthInfo`/`Connection`, and `loginWeb`
 * shells out to `sf org login web` so the CLI keeps owning the token.
 */
export const connectionsRouter = router({
  /** Orgs the `sf` CLI already has authenticated — the source list for the "add org" picker. */
  listAuthorizedOrgs: publicProcedure.query(() => listAuthorizedOrgs()),

  /** Connections VibeSet has registered (orgs, local SFDX projects, git refs). */
  list: publicProcedure.query(({ ctx }) => ctx.db.select().from(connections).all()),

  /** Registers a connection. For `org`, `username` must already be authenticated via the `sf` CLI (see `loginWeb`). */
  add: publicProcedure.input(AddConnectionInput).mutation(({ ctx, input }) => {
    const id = nanoid();
    const now = new Date().toISOString();

    const row: typeof connections.$inferInsert =
      input.kind === 'org'
        ? {
            id,
            kind: 'org',
            label: input.label,
            username: input.username,
            alias: input.alias,
            instanceUrl: input.instanceUrl,
            isSandbox: input.isSandbox,
            apiVersion: input.apiVersion,
            updatedAt: now,
          }
        : input.kind === 'sfdx-project'
          ? { id, kind: 'sfdx-project', label: input.label, projectPath: input.projectPath, updatedAt: now }
          : {
              id,
              kind: 'git-ref',
              label: input.label,
              projectPath: input.projectPath,
              // The `connections` table has no dedicated git-ref column; it's
              // exactly the kind of small, source-specific extra the freeform
              // `metadataJson` column exists for.
              metadataJson: JSON.stringify({ ref: input.gitRef }),
              updatedAt: now,
            };

    ctx.db.insert(connections).values(row).run();
    return { id };
  }),

  remove: publicProcedure.input(z.object({ connectionId: z.string() })).mutation(({ ctx, input }) => {
    ctx.db.delete(connections).where(eq(connections.id, input.connectionId)).run();
    return { removed: true };
  }),

  /** Verifies the org connection actually works and reports API version, org id, and limits. */
  healthCheck: publicProcedure.input(z.object({ connectionId: z.string() })).query(async ({ ctx, input }) => {
    const row = ctx.db.select().from(connections).where(eq(connections.id, input.connectionId)).get();
    if (!row) throw new Error(`No connection with id ${input.connectionId}.`);
    if (row.kind !== 'org' || !row.username) {
      throw new Error(`Connection ${input.connectionId} (${row.kind}) is not an org connection.`);
    }
    const source = new OrgSource(row.id, row.label, {
      username: row.username,
      instanceUrl: row.instanceUrl ?? undefined,
    });
    return source.healthCheck();
  }),

  /**
   * Shells out to `sf org login web --alias <alias>`, which opens a browser
   * for interactive OAuth and blocks until it completes. The `sf` CLI's own
   * auth store ends up with the token, never VibeSet — this mutation just
   * waits for that to finish and returns the resulting authorization.
   */
  loginWeb: publicProcedure.input(z.object({ alias: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    const jobId = await ctx.jobRunner.enqueue({
      type: 'login-web',
      payload: { alias: input.alias } satisfies LoginWebJobPayload,
    });
    return { jobId };
  }),
});
