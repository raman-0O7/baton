import { describe, expect, it } from 'vitest';

import { runWorker } from '../src/worker.js';

describe('worker lifecycle', () => {
  it('starts, emits a heartbeat, and stops cooperatively', async () => {
    const controller = new AbortController();
    const messages: string[] = [];
    let heartbeats = 0;
    await runWorker(controller.signal, {
      heartbeatIntervalMs: 60_000,
      heartbeat: () => {
        heartbeats += 1;
        controller.abort();
      },
      log: (message) => messages.push(message),
    });
    expect(heartbeats).toBe(1);
    expect(messages).toEqual([
      'worker started',
      'worker heartbeat',
      'worker stopped',
    ]);
  });
});
