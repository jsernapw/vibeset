import type { FastifyInstance } from 'fastify';
import type { JobRunner } from '../jobs/job-runner.js';

/**
 * `GET /ws/jobs/:jobId` — streams `JobProgress` events for one job as JSON
 * text frames. Sends the job's current known state immediately on connect
 * (useful for a client that subscribes after the job already started), then
 * live updates as they happen, then closes once the job reaches a terminal
 * status.
 */
export function registerWsRoutes(app: FastifyInstance, jobRunner: JobRunner): void {
  app.get('/ws/jobs/:jobId', { websocket: true }, (socket, req) => {
    const { jobId } = req.params as { jobId: string };

    const current = jobRunner.getJob(jobId);
    if (current) {
      socket.send(
        JSON.stringify({
          jobId,
          status: current.status,
          percent: current.progressPercent ?? 0,
          message: current.progressMessage ?? undefined,
          at: current.startedAt ?? current.createdAt,
        }),
      );
      if (
        current.status === 'succeeded' ||
        current.status === 'failed' ||
        current.status === 'canceled'
      ) {
        socket.close();
        return;
      }
    }

    const unsubscribe = jobRunner.subscribe(jobId, (progress) => {
      socket.send(JSON.stringify(progress));
      if (
        progress.status === 'succeeded' ||
        progress.status === 'failed' ||
        progress.status === 'canceled'
      ) {
        socket.close();
      }
    });

    socket.on('close', unsubscribe);
  });
}
