import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

import type { AgentName } from '@baton/protocol';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sourceIdentity(
  agent: AgentName,
  projectId: string,
  nativeSessionId: string,
): string {
  const digest = sha256(`${agent}\0${projectId}\0${nativeSessionId}`);
  const variantNibble = (
    (Number.parseInt(digest.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  const uuidHex = `${digest.slice(0, 12)}8${digest.slice(
    13,
    16,
  )}${variantNibble}${digest.slice(17, 32)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(
    12,
    16,
  )}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
}

/** A local native identity can be correlated without exposing the native ID. */
export function nativeSessionHash(
  agent: AgentName,
  nativeSessionId: string,
): string {
  return sha256(`${agent}\0${nativeSessionId}`);
}

/** True when candidate is the project root or one of its descendants. */
export function pathBelongsToProject(
  projectRoot: string,
  candidate: string,
): boolean {
  const normalizedRoot = resolve(projectRoot);
  const normalizedCandidate = resolve(candidate);
  const difference = relative(normalizedRoot, normalizedCandidate);
  return (
    difference === '' ||
    (!difference.startsWith('..') && !isAbsolute(difference))
  );
}

export function stableBySourceId<T extends { sourceId: string }>(
  refs: T[],
): T[] {
  return refs.sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId),
  );
}
