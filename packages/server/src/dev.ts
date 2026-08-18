import { startServer } from './server.js';

// `pnpm --filter @vibeset/server dev` — API-only, for iterating on the
// server against the Vite dev server running separately (`pnpm --filter
// @vibeset/web dev`), which proxies /trpc and /ws to this process.
const started = await startServer({ dev: true, port: Number(process.env.VIBESET_PORT ?? 4317) });
// eslint-disable-next-line no-console
console.log(`\nVibeSet API dev server: ${started.url}\n`);
