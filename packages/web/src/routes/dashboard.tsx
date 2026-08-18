import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DemoJobWidget } from '@/components/DemoJobWidget';
import { trpc } from '@/lib/trpc';

export function DashboardPage() {
  const ping = trpc.system.ping.useQuery();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-neutral-500 dark:text-neutral-400">Phase 0 foundation shell.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>API connectivity</CardTitle>
          <CardDescription>Round-trips a tRPC call to the local Fastify server.</CardDescription>
        </CardHeader>
        <CardContent>
          {ping.isPending && <p>Pinging server…</p>}
          {ping.isError && <p className="text-red-600">Error: {ping.error.message}</p>}
          {ping.data && (
            <p className="text-green-600 dark:text-green-400">
              Connected — server responded at {ping.data.at}
            </p>
          )}
        </CardContent>
      </Card>

      <DemoJobWidget />
    </div>
  );
}
