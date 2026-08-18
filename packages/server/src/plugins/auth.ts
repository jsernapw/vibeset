import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

export interface AuthPluginOptions {
  readonly token: string;
  readonly allowedOrigins: readonly string[];
  /** Path prefixes that require a valid token + origin. Everything else (static UI assets) is open. */
  readonly protectedPrefixes: readonly string[];
}

const TOKEN_HEADER = 'x-vibeset-token';
const TOKEN_QUERY = 'token';

/**
 * VibeSet is a local service, not a trusted-network one: anything else
 * listening on localhost (another dev server, a malicious page opened in
 * the same browser) could otherwise hit this API. Two independent checks,
 * both required for protected paths:
 *
 *  1. Origin header, when present, must exactly match an allowed origin
 *     (`http://127.0.0.1:<port>`). A cross-origin page cannot pass this.
 *  2. A per-boot session token, generated fresh each `vibeset up` and
 *     embedded in the launch URL, must be presented via the
 *     `x-vibeset-token` header (used by the tRPC/REST client) or a `token`
 *     query parameter (used by the WebSocket handshake, since browsers
 *     cannot set custom headers on a WS upgrade).
 */
export default fp(async function authPlugin(app: FastifyInstance, opts: AuthPluginOptions) {
  app.decorate('vibesetToken', opts.token);

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const isProtected = opts.protectedPrefixes.some((p) => req.url.startsWith(p));
    if (!isProtected) return;

    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) {
      app.log.warn({ origin, url: req.url }, 'rejected request: bad origin');
      return reply.code(403).send({ error: 'Forbidden: origin not allowed' });
    }

    const headerToken = req.headers[TOKEN_HEADER];
    const query = req.query as Record<string, unknown> | undefined;
    const queryToken = query?.[TOKEN_QUERY];
    const presented = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? queryToken;

    if (!presented || presented !== opts.token) {
      app.log.warn({ url: req.url }, 'rejected request: missing/invalid token');
      return reply.code(401).send({ error: 'Unauthorized: missing or invalid session token' });
    }
  });
});

declare module 'fastify' {
  interface FastifyInstance {
    vibesetToken: string;
  }
}
