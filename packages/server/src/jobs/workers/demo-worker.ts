/**
 * Piscina worker for the Phase-0 "demo" job type. Its only purpose is to
 * prove the job pipeline end to end: enqueue -> run in a worker thread ->
 * stream progress back to the main thread over a transferred MessagePort ->
 * main thread rebroadcasts over WebSocket to the UI.
 */
import type { MessagePort } from 'node:worker_threads';

export interface DemoJobTask {
  readonly jobId: string;
  readonly steps: number;
  readonly stepDelayMs: number;
  readonly port: MessagePort;
}

export interface DemoJobResult {
  readonly jobId: string;
  readonly stepsCompleted: number;
}

export default async function demoWorker(task: DemoJobTask): Promise<DemoJobResult> {
  const { jobId, steps, stepDelayMs, port } = task;

  for (let step = 1; step <= steps; step += 1) {
    await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
    const percent = Math.round((step / steps) * 100);
    port.postMessage({
      jobId,
      status: 'running',
      percent,
      message: `Processed step ${step}/${steps}`,
      at: new Date().toISOString(),
    });
  }

  port.postMessage({
    jobId,
    status: 'succeeded',
    percent: 100,
    message: 'Demo job complete',
    at: new Date().toISOString(),
  });
  port.close();

  return { jobId, stepsCompleted: steps };
}
