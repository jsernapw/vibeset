import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const binPath = fileURLToPath(new URL('../bin/vibeset.js', import.meta.url));

/**
 * Find any installed Node older than the 22.10 floor, so the preflight's
 * failure path is exercised on whatever machine happens to be running the
 * suite. Previously this was a hardcoded path into one developer's home
 * directory, which meant `it.runIf` silently skipped everywhere else — the
 * guard looked tested while never actually running.
 */
function findOldNode(): string | undefined {
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node');
  if (!existsSync(nvmRoot)) return undefined;
  for (const dir of readdirSync(nvmRoot)) {
    const m = /^v(\d+)\.(\d+)\./.exec(dir);
    if (!m) continue;
    const [major, minor] = [Number(m[1]), Number(m[2])];
    if (major < 22 || (major === 22 && minor < 10)) {
      const candidate = join(nvmRoot, dir, 'bin', 'node');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const oldNode = findOldNode();

// These spawn a real Node process that imports the server (better-sqlite3,
// migrations), so they are genuinely slow — and slower still when the rest of
// the monorepo's suites run concurrently. The default 5s timeout flakes there.
const SPAWN_TIMEOUT_MS = 30_000;

describe('Node version preflight', () => {
  it.runIf(oldNode)(
    'exits non-zero with a clear message on Node below the floor',
    () => {
      const result = spawnSync(oldNode!, [binPath, 'up'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('VibeSet requires Node.js >= 22');
      // The message must name the offending runtime, or the user cannot tell
      // which Node actually ran.
      expect(result.stderr).toMatch(/v\d+\.\d+\.\d+/);
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'succeeds the version check under the current Node',
    () => {
      const result = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
      // Should NOT hit the preflight error path.
      expect(result.stderr).not.toContain('VibeSet requires Node.js');
    },
    SPAWN_TIMEOUT_MS,
  );
});
