import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@vibeset/server';
import { getSessionToken } from '@/stores/session';

export const trpc = createTRPCReact<AppRouter>();

export function trpcClientConfig() {
  return {
    links: [
      httpBatchLink({
        url: '/trpc',
        headers() {
          const token = getSessionToken();
          return token ? { 'x-vibeset-token': token } : {};
        },
      }),
    ],
  };
}

/** Builds the WS URL for streaming one job's progress, including the session token. */
export function jobProgressWsUrl(jobId: string): string {
  const token = getSessionToken() ?? '';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.host}/ws/jobs/${jobId}?token=${encodeURIComponent(token)}`;
}
