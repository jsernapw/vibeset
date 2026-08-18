import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { jobProgressWsUrl, trpc } from '@/lib/trpc';

/**
 * "Add org" — the admin-friendly path. VibeSet never stores a credential:
 * this either registers a connection for an org the `sf` CLI already has
 * authenticated, or shells out to `sf org login web` (blocking, opens a
 * real browser window) and registers the result. Both land in the same
 * `connections.add` mutation.
 */
export function AddOrgDialog() {
  const [open, setOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const authorizedOrgs = trpc.connections.listAuthorizedOrgs.useQuery(undefined, { enabled: open });
  const registered = trpc.connections.list.useQuery(undefined, { enabled: open });
  const addConnection = trpc.connections.add.useMutation({
    onSuccess: () => {
      utils.connections.list.invalidate();
    },
  });
  // `sf org login web` blocks on a human finishing OAuth in a browser, so the
  // server runs it as a job and hands back a jobId immediately. (Held open as
  // a plain mutation the request outlives the dev proxy, and the response
  // comes back truncated as "Unable to transform response from server".) We
  // follow it over the same WebSocket channel every other long job uses.
  const [loginPhase, setLoginPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [loginMessage, setLoginMessage] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => () => wsRef.current?.close(), []);

  const registerAuthorizedOrg = useCallback(
    async (wantedAlias: string) => {
      const orgs = await utils.connections.listAuthorizedOrgs.fetch();
      const org = orgs.find((o) => o.alias === wantedAlias);
      if (!org) {
        setLoginError(`Login finished but no org with alias "${wantedAlias}" appeared in the sf CLI auth store.`);
        return;
      }
      addConnection.mutate({
        kind: 'org',
        label: org.alias ?? org.username,
        username: org.username,
        alias: org.alias,
        instanceUrl: org.instanceUrl,
        isSandbox: org.isSandbox,
      });
      setAlias('');
      setLoginPhase('done');
    },
    [addConnection, utils],
  );

  const loginWeb = trpc.connections.loginWeb.useMutation({
    onSuccess: ({ jobId }, variables) => {
      setLoginError(null);
      setLoginPhase('running');
      setLoginMessage('Opening your browser...');

      const ws = new WebSocket(jobProgressWsUrl(jobId));
      wsRef.current = ws;
      ws.onmessage = (event) => {
        const p = JSON.parse(event.data) as { status: string; percent: number; message?: string };
        setLoginMessage(p.message ?? '');
        if (p.status === 'succeeded') {
          ws.close();
          void registerAuthorizedOrg(variables.alias);
        } else if (p.status === 'failed' || p.status === 'canceled') {
          ws.close();
          setLoginPhase('idle');
          setLoginError(p.message ?? 'Login failed.');
        }
      };
      ws.onerror = () => {
        setLoginPhase('idle');
        setLoginError('Lost the connection while waiting for login to complete.');
      };
    },
    onError: (err) => {
      setLoginPhase('idle');
      setLoginError(err.message);
    },
  });

  const loginBusy = loginWeb.isPending || loginPhase === 'running';

  const registeredUsernames = new Set((registered.data ?? []).filter((c) => c.kind === 'org').map((c) => c.username));
  const unregistered = (authorizedOrgs.data ?? []).filter((o) => !registeredUsernames.has(o.username));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" /> Add org
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add an org</DialogTitle>
          <DialogDescription>
            VibeSet never stores credentials of its own — it reuses the `sf` CLI&apos;s local auth store.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="existing">
          <TabsList>
            <TabsTrigger value="existing">Already authenticated</TabsTrigger>
            <TabsTrigger value="login">Log in with browser</TabsTrigger>
          </TabsList>

          <TabsContent value="existing" className="flex flex-col gap-2">
            {authorizedOrgs.isPending && <p className="text-sm text-neutral-400">Loading `sf` CLI auth store...</p>}
            {authorizedOrgs.isError && (
              <p className="text-sm text-red-600">Could not read the `sf` CLI auth store: {authorizedOrgs.error.message}</p>
            )}
            {authorizedOrgs.data && unregistered.length === 0 && (
              <p className="text-sm text-neutral-400">
                No unregistered orgs found. Every `sf`-authenticated org is already registered, or none are authenticated
                yet — use &quot;Log in with browser&quot; instead.
              </p>
            )}
            {unregistered.map((org) => (
              <div
                key={org.username}
                className="flex items-center justify-between gap-2 rounded-md border border-neutral-200 px-3 py-2 dark:border-neutral-800"
              >
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{org.alias ?? org.username}</span>
                  <span className="text-xs text-neutral-400">{org.username}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {org.isScratch && <Badge variant="info">scratch</Badge>}
                  {org.isSandbox && !org.isScratch && <Badge variant="warning">sandbox</Badge>}
                  {/* `isExpired` is `boolean | 'unknown'`, and the string
                      'unknown' is truthy — a bare truthiness check labels
                      every perfectly healthy org "expired". */}
                  {org.isExpired === true && <Badge variant="error">expired</Badge>}
                  <Button
                    size="sm"
                    disabled={addConnection.isPending}
                    onClick={() =>
                      addConnection.mutate({
                        kind: 'org',
                        label: org.alias ?? org.username,
                        username: org.username,
                        alias: org.alias,
                        instanceUrl: org.instanceUrl,
                        isSandbox: org.isSandbox,
                      })
                    }
                  >
                    Register
                  </Button>
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="login" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="login-alias">Alias for the new org</Label>
              <Input id="login-alias" value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="my-sandbox" />
            </div>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Opens a real browser window for Salesforce OAuth (<code>sf org login web --alias {alias || '<alias>'}</code>
              ). The `sf` CLI keeps the resulting token — VibeSet only reads it afterward.
            </p>
            {loginBusy && (
              <div className="flex items-center gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {loginMessage || 'Starting login...'}
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">
                    Finish the login in the browser window that just opened. Times out after 10 minutes.
                  </span>
                </span>
              </div>
            )}
            {loginError && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-400">
                {loginError}
              </p>
            )}
            {addConnection.isSuccess && loginPhase === 'done' && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">Org registered.</p>
            )}
            <DialogFooter>
              <Button
                disabled={!alias.trim() || loginBusy}
                onClick={() => {
                  setLoginError(null);
                  loginWeb.mutate({ alias: alias.trim() });
                }}
              >
                {loginBusy ? 'Waiting for login...' : 'Open browser to log in'}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
