import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Command } from 'commander';
import open from 'open';
import { startServer } from '@vibeset/server';

/**
 * Resolves the built web SPA directory. Assumes the monorepo layout
 * (`packages/cli` and `packages/web` as siblings) — true both for local
 * dev and for a `pnpm pack`/workspace install that preserves the tree.
 */
function resolveWebDistDir(): string {
  const here = fileURLToPath(import.meta.url); // .../packages/cli/dist/cli.js
  return join(here, '..', '..', '..', 'web', 'dist');
}

export async function run(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('vibeset')
    .description('Local-first Salesforce DevOps / metadata migration tool')
    .version('0.0.0');

  program
    .command('up')
    .description('Start the VibeSet API and UI, and open it in your browser')
    .option('-p, --port <port>', 'port to bind (default 4317)', (v) => Number(v))
    .option('--no-open', 'do not automatically open the browser')
    .action(async (opts: { port?: number; open: boolean }) => {
      const webDistDir = resolveWebDistDir();
      if (!existsSync(webDistDir)) {
        console.warn(
          `[vibeset] Warning: built web assets not found at ${webDistDir}. ` +
            `Run "pnpm --filter @vibeset/web build" first. Starting API-only.`,
        );
      }

      const started = await startServer({
        port: opts.port ?? Number(process.env.VIBESET_PORT ?? 4317),
        webDistDir: existsSync(webDistDir) ? webDistDir : undefined,
      });

      console.log('\nVibeSet is running:');
      console.log(`  UI:   ${started.url}`);
      console.log(`  API:  http://${started.host}:${started.port}\n`);

      if (opts.open) {
        await open(started.url).catch(() => {
          console.log('  (could not auto-open a browser; open the UI URL above manually)');
        });
      }

      const shutdown = async () => {
        console.log('\n[vibeset] shutting down...');
        await started.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    });

  await program.parseAsync(argv);
}

// Allow `tsx watch src/cli.ts up` during `pnpm --filter @vibeset/cli dev`
// (the compiled bin/vibeset.js is the real production entry point, and
// runs the Node-version preflight before this module is ever imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  void run(process.argv);
}
