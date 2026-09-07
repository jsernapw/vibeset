import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { nanoid } from 'nanoid';
import { getDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { JobRunner } from './jobs/job-runner.js';
import { createInventoryJobHandler } from './trpc/routers/inventory.js';
import { createLoginWebJobHandler } from './trpc/routers/connections.js';
import { createCompareJobHandler } from './trpc/routers/comparisons.js';
import { createDeployJobHandler } from './trpc/routers/deploy.js';
import { createDependencySyncJobHandler } from './trpc/routers/dependencies.js';
import authPlugin from './plugins/auth.js';
import { registerWsRoutes } from './routes/ws.js';
import { DrizzleSnapshotStore } from './store/drizzle-snapshot-store.js';
import { createContextFactory } from './trpc/context.js';
import { appRouter } from './trpc/router.js';

export interface StartServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Directory containing the built web SPA (`index.html` + assets). Omit to run API-only. */
  readonly webDistDir?: string;
  readonly dev?: boolean;
}

export interface StartedServer {
  readonly app: FastifyInstance;
  readonly port: number;
  readonly host: string;
  readonly token: string;
  readonly url: string;
  readonly jobRunner: JobRunner;
  close(): Promise<void>;
}

const DEFAULT_PORT = 4317;

export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`Refusing to bind to non-loopback host "${host}". VibeSet is local-only.`);
  }

  // Normally a fresh per-boot token, embedded in the launch URL. `VIBESET_TOKEN`
  // pins it to a known value, which the Vite dev server and automated tests need:
  // in dev the UI is served from :5173, so it never sees the API's launch URL and
  // has no other way to learn the token. Never set this in production use.
  const token = process.env.VIBESET_TOKEN || nanoid(32);

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: opts.dev
        ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
        : undefined,
    },
  });

  const db = getDb();
  runMigrations(db);
  const jobRunner = new JobRunner(db);
  const snapshotStore = new DrizzleSnapshotStore(db);
  jobRunner.registerHandler('login-web', createLoginWebJobHandler());
  jobRunner.registerHandler('inventory', createInventoryJobHandler({ db, snapshotStore }));
  jobRunner.registerHandler('compare', createCompareJobHandler({ db, snapshotStore }));
  // 'deploy' and 'validate' share one handler implementation; 'validate'
  // forces checkOnly: true regardless of what the payload says, so a
  // validation can never accidentally perform a real deploy.
  jobRunner.registerHandler('deploy', createDeployJobHandler({ db, snapshotStore }));
  jobRunner.registerHandler('validate', createDeployJobHandler({ db, snapshotStore }, { forceCheckOnly: true }));
  jobRunner.registerHandler('dependency-sync', createDependencySyncJobHandler({ db }));

  // Resolved after listen() once we know the actual bound port (supports port:0).
  let allowedOrigins: string[] = [];

  await app.register(authPlugin, {
    token,
    get allowedOrigins() {
      return allowedOrigins;
    },
    protectedPrefixes: ['/trpc', '/ws'],
  } as any);

  await app.register(fastifyWebsocket);

  await app.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory({ db, jobRunner, snapshotStore }),
    },
  });

  registerWsRoutes(app, jobRunner);

  app.get('/healthz', async () => ({ ok: true }));

  if (opts.webDistDir && existsSync(opts.webDistDir)) {
    await app.register(fastifyStatic, {
      root: opts.webDistDir,
      prefix: '/',
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/trpc') || req.raw.url?.startsWith('/ws')) {
        reply.code(404).send({ error: 'Not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  }

  await app.listen({ port: opts.port ?? DEFAULT_PORT, host });
  const address = app.server.address();
  const actualPort =
    typeof address === 'object' && address ? address.port : (opts.port ?? DEFAULT_PORT);

  allowedOrigins = [`http://${host}:${actualPort}`, `http://localhost:${actualPort}`];
  if (opts.dev) {
    // In dev, the UI is served by the separate Vite dev server (default
    // :5173), which proxies /trpc and /ws here without rewriting Origin.
    allowedOrigins.push('http://127.0.0.1:5173', 'http://localhost:5173');
  }

  const url = `http://${host}:${actualPort}/?token=${token}`;

  app.log.info({ url }, 'VibeSet server listening');

  return {
    app,
    port: actualPort,
    host,
    token,
    url,
    jobRunner,
    async close() {
      await jobRunner.close();
      await app.close();
    },
  };
}
