import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { jobProgressWsUrl, trpc } from '@/lib/trpc';

type JobPhase = 'idle' | 'running' | 'succeeded' | 'failed';

/**
 * Proves the whole job pipeline end to end: enqueues a fake job over tRPC,
 * then opens a WebSocket to stream its live progress into a progress bar.
 */
export function DemoJobWidget() {
  const [phase, setPhase] = useState<JobPhase>('idle');
  const [percent, setPercent] = useState(0);
  const [message, setMessage] = useState<string>('');
  const [jobId, setJobId] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const enqueue = trpc.jobs.enqueueDemo.useMutation();

  const runDemoJob = useCallback(() => {
    setPhase('running');
    setPercent(0);
    setMessage('Enqueuing...');

    enqueue.mutate(
      { steps: 12, stepDelayMs: 200 },
      {
        onSuccess: ({ jobId: newJobId }) => {
          setJobId(newJobId);
          const ws = new WebSocket(jobProgressWsUrl(newJobId));
          wsRef.current = ws;

          ws.onmessage = (event) => {
            const progress = JSON.parse(event.data) as {
              status: string;
              percent: number;
              message?: string;
            };
            setPercent(progress.percent);
            setMessage(progress.message ?? '');
            if (progress.status === 'succeeded') setPhase('succeeded');
            if (progress.status === 'failed' || progress.status === 'canceled') setPhase('failed');
          };
          ws.onerror = () => setPhase('failed');
        },
        onError: (err) => {
          setPhase('failed');
          setMessage(err.message);
        },
      },
    );
  }, [enqueue]);

  useEffect(() => () => wsRef.current?.close(), []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Job pipeline demo</CardTitle>
        <CardDescription>
          Enqueues a fake job on the server&apos;s piscina worker pool and streams its progress here
          over WebSocket &mdash; proves the end-to-end job pipeline works.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Button onClick={runDemoJob} disabled={phase === 'running'}>
          {phase === 'running' ? 'Running…' : 'Run demo job'}
        </Button>
        {jobId && (
          <div className="flex flex-col gap-2">
            <Progress value={percent} />
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {jobId.slice(0, 8)} — {percent}% — {message}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
