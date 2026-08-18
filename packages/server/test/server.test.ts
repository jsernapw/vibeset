import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedServer } from '../src/server.js';

let started: StartedServer;
let tmpHome: string;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'vibeset-server-test-'));
  process.env.VIBESET_HOME = tmpHome;
  const { startServer } = await import('../src/server.js');
  started = await startServer({ port: 0 });
});

afterAll(async () => {
  await started.close();
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VIBESET_HOME;
});

describe('security', () => {
  it('binds to 127.0.0.1', () => {
    expect(started.host).toBe('127.0.0.1');
  });

  it('rejects a trpc request with no token', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/system.ping`);
    expect(res.status).toBe(401);
  });

  it('rejects a trpc request with a wrong token', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/system.ping`, {
      headers: { 'x-vibeset-token': 'not-the-token' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a request with a bad Origin even with a valid token', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/system.ping`, {
      headers: { 'x-vibeset-token': started.token, origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a trpc request with a valid token and matching origin', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/trpc/system.ping`, {
      headers: {
        'x-vibeset-token': started.token,
        origin: `http://127.0.0.1:${started.port}`,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.data.ok).toBe(true);
  });

  it('healthz is unprotected', async () => {
    const res = await fetch(`http://127.0.0.1:${started.port}/healthz`);
    expect(res.status).toBe(200);
  });
});

describe('jobs pipeline', () => {
  it('enqueues a demo job and streams progress to completion', async () => {
    const enqueueRes = await fetch(`http://127.0.0.1:${started.port}/trpc/jobs.enqueueDemo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vibeset-token': started.token,
        origin: `http://127.0.0.1:${started.port}`,
      },
      body: JSON.stringify({ steps: 3, stepDelayMs: 10 }),
    });
    expect(enqueueRes.status).toBe(200);
    const { result } = await enqueueRes.json();
    const jobId = result.data.jobId as string;
    expect(jobId).toBeTruthy();

    // Poll until terminal (the WS route is exercised separately by curl in manual verification).
    let job: any;
    for (let i = 0; i < 50; i += 1) {
      const getRes = await fetch(
        `http://127.0.0.1:${started.port}/trpc/jobs.get?input=${encodeURIComponent(
          JSON.stringify({ jobId }),
        )}`,
        {
          headers: {
            'x-vibeset-token': started.token,
            origin: `http://127.0.0.1:${started.port}`,
          },
        },
      );
      const body = await getRes.json();
      job = body.result.data;
      if (job && (job.status === 'succeeded' || job.status === 'failed')) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(job.status).toBe('succeeded');
    expect(job.progressPercent).toBe(100);
  });
});
