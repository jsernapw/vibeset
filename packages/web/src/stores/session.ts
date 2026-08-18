import { create } from 'zustand';

const STORAGE_KEY = 'vibeset:session-token';

function resolveInitialToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl);
    return fromUrl;
  }
  return localStorage.getItem(STORAGE_KEY);
}

interface SessionState {
  token: string | null;
}

/**
 * Holds the per-boot session token `vibeset up` embeds in the launch URL
 * (`?token=...`). Read once on load, cached in localStorage so navigating
 * within the SPA (which doesn't reload) keeps working, and used by both
 * the tRPC client (as an `x-vibeset-token` header) and WebSocket
 * connections (as a `token` query param, since the browser WebSocket API
 * cannot set custom headers).
 */
export const useSessionStore = create<SessionState>(() => ({
  token: resolveInitialToken(),
}));

export function getSessionToken(): string | null {
  return useSessionStore.getState().token;
}
