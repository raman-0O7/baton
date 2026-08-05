import { Buffer } from 'node:buffer';

import type {
  CaptureCheckpoint,
  EventSource as CaptureEventSource,
  SourceSessionRef as CaptureSourceSessionRef,
} from '@baton/capture';
import {
  decodeCaptureCheckpoint,
  encodeCaptureCheckpoint,
} from '@baton/capture';
import type { AgentName, SourceEventInput } from '@baton/protocol';
import type {
  EventSource,
  ProjectBinding,
  SourceReadLimit,
  SourceReadResult,
  SourceSessionRef,
} from '@baton/sync';

interface BridgeCursor {
  v: 1;
  committed: string | null;
  pending: {
    fingerprint: string;
    generation: number;
    eventCount: number;
    offset: number;
  } | null;
}

/**
 * Adapts native capture to sync without putting source paths or native payloads
 * in the persisted cursor. Pending pages are deterministically reconstructed.
 */
export class CaptureSyncEventSource implements EventSource {
  readonly name;
  readonly #refs = new Map<string, CaptureSourceSessionRef>();

  constructor(
    private readonly source: CaptureEventSource,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.name = source.name;
  }

  async discover(binding: ProjectBinding): Promise<SourceSessionRef[]> {
    const refs = await this.source.discover({
      projectId: binding.cloudProjectId,
      rootPath: binding.canonicalLocalPath,
    });
    for (const ref of refs) this.#refs.set(ref.sourceId, ref);
    return refs.map((ref) => ({
      key: ref.sourceId,
      sourceSessionId: ref.sourceId,
      nativeSessionHash: ref.nativeSessionHash,
      parserVersion: this.source.parserVersion,
    }));
  }

  async currentCursor(
    binding: ProjectBinding,
    ref: SourceSessionRef,
  ): Promise<string | null> {
    const local = await this.localRef(binding, ref);
    const batch = await this.source.readSince(local);
    return encodeCursor({
      v: 1,
      committed: encodeCaptureCheckpoint(batch.checkpoint),
      pending: null,
    });
  }

  async readSince(
    binding: ProjectBinding,
    ref: SourceSessionRef,
    cursor: string | null,
    limit: SourceReadLimit,
  ): Promise<SourceReadResult> {
    const state = decodeCursor(cursor);
    const local = await this.localRef(binding, ref);
    const captured = await this.source.readSince(
      local,
      state.committed === null
        ? undefined
        : decodeCaptureCheckpoint(state.committed),
    );
    const pending = state.pending;
    if (
      pending !== null &&
      (pending.fingerprint !== captured.checkpoint.fingerprint.digest ||
        pending.generation !== captured.checkpoint.generation ||
        pending.eventCount !== captured.checkpoint.adapter.eventCount)
    ) {
      throw new Error(
        `${this.name}: source changed while a paged capture was awaiting acknowledgement`,
      );
    }

    const offset = pending?.offset ?? 0;
    const normalized = captured.events.map((event, index) =>
      normalizeEvent(
        event,
        ref.sourceSessionId,
        binding.deviceId,
        this.name,
        captured.mode === 'append'
          ? captured.checkpoint.adapter.eventCount -
              captured.events.length +
              index
          : index,
        this.now().toISOString(),
      ),
    );
    const page = boundedPage(normalized, offset, limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < normalized.length;
    const proposed = encodeCursor({
      v: 1,
      committed: hasMore
        ? state.committed
        : encodeCaptureCheckpoint(captured.checkpoint),
      pending: hasMore
        ? {
            fingerprint: captured.checkpoint.fingerprint.digest,
            generation: captured.checkpoint.generation,
            eventCount: captured.checkpoint.adapter.eventCount,
            offset: nextOffset,
          }
        : null,
    });

    return {
      events: page,
      previousCursor: cursor,
      proposedCursor: proposed,
      hasMore,
    };
  }

  async fingerprint(
    binding: ProjectBinding,
    ref: SourceSessionRef,
  ): Promise<string> {
    const fingerprint = await this.source.fingerprint(
      await this.localRef(binding, ref),
    );
    return `${fingerprint.algorithm}:${fingerprint.extent}:${fingerprint.digest}`;
  }

  async localRef(
    binding: ProjectBinding,
    ref: SourceSessionRef,
  ): Promise<CaptureSourceSessionRef> {
    const known = this.#refs.get(ref.key);
    if (known !== undefined) return known;
    await this.discover(binding);
    const discovered = this.#refs.get(ref.key);
    if (discovered === undefined) {
      throw new Error(`${this.name}: source ${ref.sourceSessionId} not found`);
    }
    return discovered;
  }
}

function normalizeEvent(
  event: {
    occurredAt: string;
    payload: SourceEventInput['payload'];
  },
  sourceSessionId: string,
  sourceDeviceId: string,
  sourceAgent: AgentName,
  nativeSequence: number,
  observedAt: string,
): SourceEventInput {
  return {
    sourceSessionId,
    workThreadId: null,
    sourceAgent,
    sourceDeviceId,
    nativeSequence,
    parentEventId: null,
    occurredAt: event.occurredAt,
    observedAt,
    schemaVersion: 1,
    payload: event.payload,
  };
}

function boundedPage(
  events: SourceEventInput[],
  offset: number,
  limit: SourceReadLimit,
): SourceEventInput[] {
  const result: SourceEventInput[] = [];
  let bytes = 2;
  const maximum = Math.max(1, limit.maxEvents);
  const targetBytes = Math.max(1, limit.targetUncompressedBytes);
  for (const event of events.slice(offset)) {
    if (result.length >= maximum) break;
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (result.length > 0 && bytes + eventBytes > targetBytes) break;
    result.push(event);
    bytes += eventBytes;
  }
  return result;
}

function decodeCursor(value: string | null): BridgeCursor {
  if (value === null) return { v: 1, committed: null, pending: null };
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('capture cursor is malformed');
  }
  if (!isRecord(decoded) || decoded.v !== 1) {
    throw new TypeError('capture cursor has an unsupported schema');
  }
  if (
    (decoded.committed !== null && typeof decoded.committed !== 'string') ||
    (decoded.pending !== null && !validPending(decoded.pending))
  ) {
    throw new TypeError('capture cursor is malformed');
  }
  if (typeof decoded.committed === 'string') {
    decodeCaptureCheckpoint(decoded.committed);
  }
  return decoded as unknown as BridgeCursor;
}

function encodeCursor(cursor: BridgeCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), 'utf8').toString(
    'base64url',
  );
  if (encoded.length > 2_048) {
    throw new RangeError('capture bridge cursor exceeds the protocol limit');
  }
  return encoded;
}

function validPending(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.fingerprint === 'string' &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) >= 0 &&
    Number.isSafeInteger(value.eventCount) &&
    Number(value.eventCount) >= 0 &&
    Number.isSafeInteger(value.offset) &&
    Number(value.offset) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
