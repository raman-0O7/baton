import type {
  CaptureCheckpoint,
  EventBatch,
  EventSource,
  SourceSessionRef,
} from './types.js';

export interface ReconciliationScheduleOptions {
  intervalMs: number;
}

/**
 * Tracks periodic full-source reads independently from best-effort file watch
 * notifications. State is local scheduling metadata, not an upload cursor.
 */
export class ReconciliationSchedule {
  readonly #intervalMs: number;
  readonly #lastRead = new Map<string, number>();

  constructor(options: ReconciliationScheduleOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError(
        'reconciliation interval must be a positive integer',
      );
    }
    this.#intervalMs = options.intervalMs;
  }

  isDue(sourceId: string, nowMs: number): boolean {
    const previous = this.#lastRead.get(sourceId);
    return previous === undefined || nowMs - previous >= this.#intervalMs;
  }

  markRead(sourceId: string, nowMs: number): void {
    this.#lastRead.set(sourceId, nowMs);
  }

  nextDueAt(sourceId: string): number | null {
    const previous = this.#lastRead.get(sourceId);
    return previous === undefined ? null : previous + this.#intervalMs;
  }
}

/** Execute one due reconciliation pass in stable source-ID order. */
export async function reconcileDue(
  source: EventSource,
  refs: readonly SourceSessionRef[],
  checkpoints: ReadonlyMap<string, CaptureCheckpoint>,
  schedule: ReconciliationSchedule,
  nowMs: number,
): Promise<EventBatch[]> {
  const batches: EventBatch[] = [];
  for (const ref of [...refs].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId),
  )) {
    if (!schedule.isDue(ref.sourceId, nowMs)) continue;
    const batch = await source.readSince(ref, checkpoints.get(ref.sourceId), {
      reason: 'periodic_reconciliation',
    });
    batches.push(batch);
    schedule.markRead(ref.sourceId, nowMs);
  }
  return batches;
}
