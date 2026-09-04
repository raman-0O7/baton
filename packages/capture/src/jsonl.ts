import { open, readFile, stat } from 'node:fs/promises';

import type { IncrementalAdapter } from '@baton/adapters';
import type { AgentName } from '@baton/protocol';

import { sha256 } from './identity.js';
import {
  type CaptureCheckpoint,
  type EventBatch,
  type EventSource,
  type Fingerprint,
  type ProjectBinding,
  type ReadOptions,
  type ReadReason,
  type SourceSessionRef,
  SourceChangedDuringReadError,
  assertCheckpoint,
  assertRef,
} from './types.js';

interface StableFile {
  content: string;
  bytes: Uint8Array;
}

export abstract class JsonlEventSource implements EventSource {
  abstract readonly name: AgentName;
  protected abstract readonly adapter: IncrementalAdapter;

  get parserVersion(): string {
    return this.adapter.formatVersion;
  }

  abstract discover(project: ProjectBinding): Promise<SourceSessionRef[]>;

  async readSince(
    ref: SourceSessionRef,
    cursor?: CaptureCheckpoint,
    options: ReadOptions = {},
  ): Promise<EventBatch> {
    assertRef(ref, this.name, 'jsonl');
    assertCheckpoint(ref, cursor);
    const file = await stableRead(ref.local.path, ref.sourceId);
    const contentDigest = sha256(file.bytes);
    const priorPhysical = cursor?.physical;
    const physicalReason =
      priorPhysical?.kind === 'jsonl'
        ? classifyJsonlChange(file.bytes, contentDigest, priorPhysical)
        : 'initial';
    const adapterResult = this.adapter.readSince(
      { content: file.content },
      cursor?.adapter,
    );
    const reason = reconcileReason(
      physicalReason,
      adapterResult.mode,
      options.reason,
    );
    const fingerprint = fileFingerprint(file.bytes, contentDigest);
    const generation =
      cursor === undefined
        ? 0
        : adapterResult.mode === 'replace'
          ? cursor.generation + 1
          : cursor.generation;

    return {
      sourceId: ref.sourceId,
      nativeSessionHash: ref.nativeSessionHash,
      agent: this.name,
      parserVersion: this.parserVersion,
      mode: adapterResult.mode,
      reason,
      events: adapterResult.events,
      checkpoint: {
        schemaVersion: 1,
        sourceId: ref.sourceId,
        agent: this.name,
        generation,
        adapter: adapterResult.cursor,
        physical: {
          kind: 'jsonl',
          byteLength: file.bytes.byteLength,
          contentDigest,
        },
        fingerprint,
      },
    };
  }

  async fingerprint(ref: SourceSessionRef): Promise<Fingerprint> {
    assertRef(ref, this.name, 'jsonl');
    const file = await stableRead(ref.local.path, ref.sourceId);
    return fileFingerprint(file.bytes);
  }
}

function fileFingerprint(
  bytes: Uint8Array,
  digest = sha256(bytes),
): Fingerprint {
  return { algorithm: 'sha256', digest, extent: bytes.byteLength };
}

async function stableRead(
  path: string,
  sourceId: string,
  attempts = 3,
): Promise<StableFile> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await stat(path, { bigint: true });
    const bytes = await readFile(path);
    const after = await stat(path, { bigint: true });
    if (
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      BigInt(bytes.byteLength) === after.size
    ) {
      return { content: bytes.toString('utf8'), bytes };
    }
  }
  throw new SourceChangedDuringReadError(sourceId);
}

function classifyJsonlChange(
  bytes: Uint8Array,
  digest: string,
  prior: Extract<CaptureCheckpoint['physical'], { kind: 'jsonl' }>,
): 'append' | 'unchanged' | 'truncation' | 'rewrite' {
  if (bytes.byteLength < prior.byteLength) return 'truncation';
  if (bytes.byteLength === prior.byteLength) {
    return digest === prior.contentDigest ? 'unchanged' : 'rewrite';
  }
  const prefix = bytes.subarray(0, prior.byteLength);
  return sha256(prefix) === prior.contentDigest ? 'append' : 'rewrite';
}

function reconcileReason(
  physical: 'initial' | 'append' | 'unchanged' | 'truncation' | 'rewrite',
  adapterMode: 'append' | 'replace',
  requested: ReadOptions['reason'],
): ReadReason {
  if (physical === 'unchanged' && requested === 'periodic_reconciliation') {
    return 'periodic_reconciliation';
  }
  if (
    adapterMode === 'replace' &&
    physical !== 'initial' &&
    physical !== 'truncation' &&
    physical !== 'rewrite'
  ) {
    return 'semantic_reconciliation';
  }
  return physical;
}

export interface JsonlMetadata {
  nativeSessionId: string;
  cwd: string;
}

/**
 * Read only the bounded head of a JSONL file to discover its session identity.
 * Discovery never serializes or returns the native records.
 */
export async function readJsonlMetadata(
  path: string,
  select: (record: Record<string, unknown>) => JsonlMetadata | undefined,
  maxBytes = 1024 * 1024,
): Promise<JsonlMetadata | undefined> {
  const handle = await open(path, 'r');
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (position < maxBytes) {
      const size = Math.min(64 * 1024, maxBytes - position);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      position += bytesRead;
      const content = Buffer.concat(chunks).toString('utf8');
      const complete = content.slice(0, content.lastIndexOf('\n') + 1);
      for (const line of complete.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const value: unknown = JSON.parse(line);
          if (isRecord(value)) {
            const metadata = select(value);
            if (metadata !== undefined) return metadata;
          }
        } catch {
          // A malformed native line is skipped just like the semantic adapters.
        }
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
