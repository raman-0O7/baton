export interface ReconciliationScheduler {
  start(task: () => Promise<void>): { close(): Promise<void> };
}

export class IntervalReconciliationScheduler implements ReconciliationScheduler {
  constructor(private readonly intervalMs = 5 * 60_000) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
      throw new TypeError(
        'reconciliation interval must be at least one second',
      );
    }
  }

  start(task: () => Promise<void>): { close(): Promise<void> } {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void task().finally(() => {
        running = false;
      });
    }, this.intervalMs);
    timer.unref();
    return {
      close: async () => clearInterval(timer),
    };
  }
}
