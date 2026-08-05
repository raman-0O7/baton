import type { AgentName } from '@baton/protocol';

import type { CaptureCheckpoint, PhysicalCursor } from './types.js';

const prefix = 'cap:v1:';
const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Encode the local checkpoint for protocol `previous/proposedCursor`. */
export function encodeCaptureCheckpoint(checkpoint: CaptureCheckpoint): string {
  assertCaptureCheckpoint(checkpoint);
  const encoded = `${prefix}${Buffer.from(
    JSON.stringify({
      schemaVersion: checkpoint.schemaVersion,
      sourceId: checkpoint.sourceId,
      agent: checkpoint.agent,
      generation: checkpoint.generation,
      adapter: {
        schemaVersion: checkpoint.adapter.schemaVersion,
        agent: checkpoint.adapter.agent,
        eventCount: checkpoint.adapter.eventCount,
        prefixDigest: checkpoint.adapter.prefixDigest,
        snapshotDigest: checkpoint.adapter.snapshotDigest,
      },
      physical: checkpoint.physical,
      fingerprint: checkpoint.fingerprint,
    }),
  ).toString('base64url')}`;
  if (encoded.length > 2_048) {
    throw new RangeError(
      'capture checkpoint exceeds the ingestion cursor limit',
    );
  }
  return encoded;
}

export function decodeCaptureCheckpoint(encoded: string): CaptureCheckpoint {
  if (!encoded.startsWith(prefix) || encoded.length > 2_048) {
    throw new TypeError('invalid capture checkpoint envelope');
  }
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8'),
    );
  } catch {
    throw new TypeError('invalid capture checkpoint payload');
  }
  assertCaptureCheckpoint(value);
  return value;
}

export function assertCaptureCheckpoint(
  value: unknown,
): asserts value is CaptureCheckpoint {
  if (!isRecord(value)) invalid();
  if (
    !hasOnlyKeys(value, [
      'schemaVersion',
      'sourceId',
      'agent',
      'generation',
      'adapter',
      'physical',
      'fingerprint',
    ]) ||
    value.schemaVersion !== 1 ||
    !matchesUuid(value.sourceId) ||
    !isAgent(value.agent) ||
    !isNonnegativeInteger(value.generation) ||
    !isRecord(value.adapter) ||
    !hasOnlyKeys(value.adapter, [
      'schemaVersion',
      'agent',
      'eventCount',
      'prefixDigest',
      'snapshotDigest',
    ]) ||
    value.adapter.schemaVersion !== 1 ||
    value.adapter.agent !== value.agent ||
    !isNonnegativeInteger(value.adapter.eventCount) ||
    !matchesDigest(value.adapter.prefixDigest) ||
    !matchesDigest(value.adapter.snapshotDigest) ||
    !isPhysicalCursor(value.physical) ||
    !isRecord(value.fingerprint) ||
    !hasOnlyKeys(value.fingerprint, ['algorithm', 'digest', 'extent']) ||
    value.fingerprint.algorithm !== 'sha256' ||
    !matchesDigest(value.fingerprint.digest) ||
    !isNonnegativeInteger(value.fingerprint.extent)
  ) {
    invalid();
  }
}

function isPhysicalCursor(value: unknown): value is PhysicalCursor {
  if (!isRecord(value) || !matchesDigest(value.contentDigest)) {
    return false;
  }
  if (value.kind === 'jsonl') {
    return (
      hasOnlyKeys(value, ['kind', 'byteLength', 'contentDigest']) &&
      isNonnegativeInteger(value.byteLength)
    );
  }
  return (
    value.kind === 'sqlite' &&
    hasOnlyKeys(value, [
      'kind',
      'rowCount',
      'maxPartCreatedAt',
      'maxPartId',
      'contentDigest',
    ]) &&
    isNonnegativeInteger(value.rowCount) &&
    (value.maxPartCreatedAt === null ||
      isNonnegativeInteger(value.maxPartCreatedAt)) &&
    (value.maxPartId === null || typeof value.maxPartId === 'string')
  );
}

function isAgent(value: unknown): value is AgentName {
  return value === 'claudecode' || value === 'codex' || value === 'opencode';
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0;
}

function matchesDigest(value: unknown): value is string {
  return typeof value === 'string' && digestPattern.test(value);
}

function matchesUuid(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function invalid(): never {
  throw new TypeError('invalid capture checkpoint');
}
