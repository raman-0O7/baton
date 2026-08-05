export interface WorkerDependencies {
  heartbeatIntervalMs: number;
  heartbeat(): Promise<void> | void;
  log(
    message: string,
    fields?: Record<string, string | number | boolean>,
  ): void;
}

export async function runWorker(
  signal: AbortSignal,
  dependencies: WorkerDependencies,
): Promise<void> {
  dependencies.log('worker started');
  while (!signal.aborted) {
    const startedAt = performance.now();
    await dependencies.heartbeat();
    dependencies.log('worker heartbeat', {
      durationMs: Math.round(performance.now() - startedAt),
    });
    await abortableDelay(dependencies.heartbeatIntervalMs, signal);
  }
  dependencies.log('worker stopped');
}

function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}
