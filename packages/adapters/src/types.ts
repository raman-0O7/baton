import type { AgentName, SourceEventPayload } from '@baton/protocol';
import { canonicalJsonSha256 } from '@baton/protocol';

export interface NativeLocator {
  line?: number;
  table?: string;
  nativeId?: string;
}

export interface AdapterEvent {
  /** Human-readable stable key within the normalized session projection. */
  key: string;
  /** Native identity used for rewrite/deduplication diagnostics. */
  identity: string;
  occurredAt: string;
  sourcePointer: string;
  nativeLocator: NativeLocator;
  payload: SourceEventPayload;
}

export interface AdapterCursor {
  schemaVersion: 1;
  agent: AgentName;
  eventCount: number;
  prefixDigest: string;
  snapshotDigest: string;
}

export interface AdapterReadResult {
  mode: 'append' | 'replace';
  events: AdapterEvent[];
  snapshotEvents: AdapterEvent[];
  cursor: AdapterCursor;
}

export interface NativeSnapshot {
  content: string;
  /** OpenCode tests/providers can expose one transaction's visible part IDs. */
  visibleNativeIds?: ReadonlySet<string>;
}

export interface IncrementalAdapter {
  readonly name: AgentName;
  readonly formatVersion: string;
  parseSnapshot(snapshot: NativeSnapshot): AdapterEvent[];
  readSince(
    snapshot: NativeSnapshot,
    cursor?: AdapterCursor,
  ): AdapterReadResult;
  fingerprint(snapshot: NativeSnapshot): string;
}

export abstract class SnapshotAdapter implements IncrementalAdapter {
  abstract readonly name: AgentName;
  abstract readonly formatVersion: string;
  abstract parseSnapshot(snapshot: NativeSnapshot): AdapterEvent[];

  readSince(
    snapshot: NativeSnapshot,
    cursor?: AdapterCursor,
  ): AdapterReadResult {
    const snapshotEvents = this.parseSnapshot(snapshot);
    const snapshotDigest = digestEvents(snapshotEvents);
    const extendsPrior =
      cursor !== undefined &&
      cursor.agent === this.name &&
      cursor.eventCount <= snapshotEvents.length &&
      digestEvents(snapshotEvents.slice(0, cursor.eventCount)) ===
        cursor.prefixDigest;
    const mode = extendsPrior ? 'append' : 'replace';
    const events = extendsPrior
      ? snapshotEvents.slice(cursor.eventCount)
      : snapshotEvents;

    return {
      mode,
      events,
      snapshotEvents,
      cursor: {
        schemaVersion: 1,
        agent: this.name,
        eventCount: snapshotEvents.length,
        prefixDigest: snapshotDigest,
        snapshotDigest,
      },
    };
  }

  fingerprint(snapshot: NativeSnapshot): string {
    return digestEvents(this.parseSnapshot(snapshot));
  }
}

export class UnknownFormatError extends Error {
  constructor(agent: AgentName) {
    super(`${agent}: snapshot contains no recognized native records`);
    this.name = 'UnknownFormatError';
  }
}

export function digestEvents(events: readonly AdapterEvent[]): string {
  return canonicalJsonSha256(events);
}

export function normalizeTimestamp(value: string | number): string {
  return new Date(value).toISOString().replace('.000Z', 'Z');
}

export function jsonSummary(value: unknown): string {
  return JSON.stringify(value);
}
