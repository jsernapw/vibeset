import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Boots the REAL built artifact — `packages/cli/bin/vibeset.js` spawned as a
 * subprocess, exactly the way a user's shell invokes `vibeset up` — and
 * proves it actually serves traffic.
 *
 * This exists because every other gate in this repo missed a production
 * outage: `@salesforce/core` (zod ^4) and VibeSet's own packages (zod ^3)
 * collided the moment tsdown bundled the Salesforce SDKs into
 * packages/server/dist/index.js, and `.meta()` (a zod-4-only schema API)
 * threw at import time. `pnpm verify` stayed green through it because:
 *
 *   - `vitest` imports source through `tsx`/esbuild, never the bundled
 *     dist/index.js, so pnpm's own (correct) per-package dependency
 *     resolution masked the bundler's version collapse entirely.
 *   - `scripts/dev.sh` runs the same unbundled path for the same reason.
 *
 * So the one thing that actually reproduces the failure mode is running
 * `node packages/cli/bin/vibeset.js up` — a real subprocess, importing the
 * real dist/index.js, over the real CLI entry point. That is what this test
 * does. Do not "simplify" this into an in-process `import()` of the built
 * file or a unit test against `startServer()` from source — both would
 * silently reopen the exact hole that hid the original bug.
 */

const binPath = fileURLToPath(new URL('../bin/vibeset.js', import.meta.url));
const BOOT_TIMEOUT_MS = 30_000;
const TEST_TOKEN = 'boot-smoke-test-token';

let child: ChildProcessWithoutNullStreams | undefined;
let homeDir: string | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5_000);
      child!.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  child = undefined;
  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true }).catch(() => {});
    homeDir = undefined;
  }
});

/** Waits for a line matching `pattern` on the child's stdout, or rejects on exit/timeout. */
function waitForStdout(
  proc: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for /${pattern.source}/ on stdout.\n` +
            `--- stdout ---\n${out}\n--- stderr ---\n${err}`,
        ),
      );
    }, timeoutMs);

    const onStdout = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const m = out.match(pattern);
      if (m) {
        cleanup();
        resolve(m);
      }
    };
    const onStderr = (chunk: Buffer) => {
      err += chunk.toString('utf8');
    };
    const onExit = (code: number | null, signal: string | null) => {
      cleanup();
      reject(
        new Error(
          `vibeset.js exited early (code=${code}, signal=${signal}) before printing /${pattern.source}/.\n` +
            `--- stdout ---\n${out}\n--- stderr ---\n${err}`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timer);
      proc.stdout.off('data', onStdout);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
    }

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.once('exit', onExit);
  });
}

describe('vibeset up (real built artifact)', () => {
  it(
    'boots packages/server/dist/index.js via the CLI bin, and serves a real tRPC call',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'vibeset-boot-smoke-'));

      child = spawn(process.execPath, [binPath, 'up', '--no-open'], {
        env: {
          ...process.env,
          VIBESET_HOME: homeDir,
          VIBESET_TOKEN: TEST_TOKEN,
          VIBESET_PORT: '0', // OS-assigned free port, so parallel test runs never collide.
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // cli.ts prints `  API:  http://127.0.0.1:<port>` once startServer()
      // has successfully returned from app.listen() — this is the earliest
      // externally-observable proof that the whole import graph (including
      // every Salesforce SDK reachable from packages/server/dist/index.js)
      // resolved and executed without throwing.
      const match = await waitForStdout(child, /API:\s+http:\/\/127\.0\.0\.1:(\d+)/, BOOT_TIMEOUT_MS);
      const port = Number(match[1]);
      expect(port).toBeGreaterThan(0);

      const base = `http://127.0.0.1:${port}`;

      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true });

      // A real tRPC call, authenticated, end to end through the router that
      // (via connections.ts/merge.ts) pulls in the very Salesforce SDKs whose
      // bundling broke production.
      const ping = await fetch(`${base}/trpc/system.ping?token=${TEST_TOKEN}`);
      expect(ping.status).toBe(200);
      const body = (await ping.json()) as { result: { data: { ok: boolean } } };
      expect(body.result.data.ok).toBe(true);
    },
    BOOT_TIMEOUT_MS + 10_000,
  );
});
