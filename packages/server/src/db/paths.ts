import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Root directory for all VibeSet local state (SQLite DB, cached retrieves,
 * logs). Defaults to `~/.vibeset`, overridable via `VIBESET_HOME` — tests
 * rely on the override to run against an isolated, throwaway directory.
 */
export function vibesetHome(): string {
  const override = process.env.VIBESET_HOME;
  const home = override && override.length > 0 ? override : join(homedir(), '.vibeset');
  mkdirSync(home, { recursive: true });
  return home;
}

export function vibesetDbPath(): string {
  return join(vibesetHome(), 'vibeset.db');
}
