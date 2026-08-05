import type { AdapterCursor, AdapterEvent } from '@baton/adapters';
import type { AgentName } from '@baton/protocol';

/** A cloud project bound to a local checkout. The path never leaves capture. */
export interface ProjectBinding {
  projectId: string;
  rootPath: string;
}

export interface JsonlSourceLocator {
  kind: 'jsonl';
  path: string;
}

export interface SqliteSourceLocator {
  kind: 'sqlite';
  databasePath: string;
  nativeSessionId: string;
}

export type LocalSourceLocator = JsonlSourceLocator | SqliteSourceLocator;

/**
 * A local source handle. `local` is deliberately absent from EventBatch so an
 * ingestion DTO cannot accidentally serialize an absolute path.
 */
export interface SourceSessionRef {
  sourceId: string;
  nativeSessionHash: string;
  projectId: string;
  agent: AgentName;
  nativeSessionId: string;
  local: LocalSourceLocator;
}

export interface Fingerprint {
  algorithm: 'sha256';
  digest: string;
  extent: number;
}

export interface JsonlPhysicalCursor {
  kind: 'jsonl';
  byteLength: number;
  contentDigest: string;
}

export interface SqlitePhysicalCursor {
  kind: 'sqlite';
  rowCount: number;
  maxPartCreatedAt: number | null;
  maxPartId: string | null;
  contentDigest: string;
}

export type PhysicalCursor = JsonlPhysicalCursor | SqlitePhysicalCursor;

/** Opaque, content-free local acknowledgement checkpoint. */
export interface CaptureCheckpoint {
  schemaVersion: 1;
  sourceId: string;
  agent: AgentName;
  generation: number;
  adapter: AdapterCursor;
  physical: PhysicalCursor;
  fingerprint: Fingerprint;
}

export type ReadReason =
  | 'initial'
  | 'append'
  | 'unchanged'
  | 'truncation'
  | 'rewrite'
  | 'semantic_reconciliation'
  | 'periodic_reconciliation';

/**
 * Normalized output safe to pass to policy/scrubbing. There is intentionally
 * no native snapshot, raw row, absolute source path, or project checkout path.
 */
export interface EventBatch {
  sourceId: string;
  nativeSessionHash: string;
  agent: AgentName;
  parserVersion: string;
  mode: 'append' | 'replace';
  reason: ReadReason;
  events: AdapterEvent[];
  checkpoint: CaptureCheckpoint;
}

export interface ReadOptions {
  reason?: 'change' | 'periodic_reconciliation';
}

export interface EventSource {
  readonly name: AgentName;
  readonly parserVersion: string;
  discover(project: ProjectBinding): Promise<SourceSessionRef[]>;
  readSince(
    ref: SourceSessionRef,
    cursor?: CaptureCheckpoint,
    options?: ReadOptions,
  ): Promise<EventBatch>;
  fingerprint(ref: SourceSessionRef): Promise<Fingerprint>;
}

export class CheckpointMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointMismatchError';
  }
}

export class SourceChangedDuringReadError extends Error {
  constructor(sourceId: string) {
    super(`${sourceId}: source did not settle during capture`);
    this.name = 'SourceChangedDuringReadError';
  }
}

export function assertRef<
  A extends AgentName,
  K extends LocalSourceLocator['kind'],
>(
  ref: SourceSessionRef,
  agent: A,
  kind: K,
): asserts ref is SourceSessionRef & {
  agent: A;
  local: Extract<LocalSourceLocator, { kind: K }>;
} {
  if (ref.agent !== agent || ref.local.kind !== kind) {
    throw new TypeError(
      `${agent}: expected a ${kind} source reference, received ${ref.agent}/${ref.local.kind}`,
    );
  }
}

export function assertCheckpoint(
  ref: SourceSessionRef,
  checkpoint: CaptureCheckpoint | undefined,
): void {
  if (checkpoint === undefined) return;
  if (
    checkpoint.schemaVersion !== 1 ||
    checkpoint.sourceId !== ref.sourceId ||
    checkpoint.agent !== ref.agent ||
    checkpoint.adapter.agent !== ref.agent
  ) {
    throw new CheckpointMismatchError(
      `${ref.agent}: checkpoint belongs to a different source or schema`,
    );
  }
}
