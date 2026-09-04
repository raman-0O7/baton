import { createHash } from 'node:crypto';

import type { AgentName, SourceEventInput } from '@baton/protocol';

import type {
  InstallationRecord,
  ProjectIdentity,
} from './installation-map.js';

export interface ProjectBinding {
  projectIdentity: ProjectIdentity;
  projectInstallationId: string;
  cloudProjectId: string;
  deviceId: string;
  displayName: string;
  /** This value is local-only and must never cross the CloudUploader boundary. */
  canonicalLocalPath: string;
}

export interface SourceSessionRef {
  /** Stable local source identity; native paths may be used but never upload. */
  key: string;
  sourceSessionId: string;
  nativeSessionHash: string;
  parserVersion: string;
}

export interface SourceReadLimit {
  maxEvents: number;
  /** A hint only; the coordinator enforces the compressed wire limit. */
  targetUncompressedBytes: number;
}

export interface SourceReadResult {
  events: SourceEventInput[];
  previousCursor: string | null;
  proposedCursor: string;
  hasMore: boolean;
}

/**
 * Agent capture dependency. Implementations own native filesystem/SQLite
 * semantics; the sync package owns consent, policy, retries, and checkpoints.
 */
export interface EventSource {
  readonly name: AgentName;
  discover(binding: ProjectBinding): Promise<SourceSessionRef[]>;
  readSince(
    binding: ProjectBinding,
    ref: SourceSessionRef,
    cursor: string | null,
    limit: SourceReadLimit,
  ): Promise<SourceReadResult>;
  /** Cursor at enable time. Used to exclude all historical content. */
  currentCursor(
    binding: ProjectBinding,
    ref: SourceSessionRef,
  ): Promise<string | null>;
  fingerprint(binding: ProjectBinding, ref: SourceSessionRef): Promise<string>;
}

export interface SourceChangeWatcher {
  watch(
    binding: ProjectBinding,
    onSettledChange: () => void,
  ): Promise<{ close(): Promise<void> }>;
}

export function bindingFromInstallation(
  installation: InstallationRecord,
): ProjectBinding {
  return {
    projectIdentity: installation.projectIdentity,
    projectInstallationId: installation.projectInstallationId,
    cloudProjectId: installation.cloudProjectId,
    deviceId: installation.deviceId,
    displayName: installation.displayName,
    canonicalLocalPath: installation.canonicalLocalPath,
  };
}

/** Hash native locators before using them as map keys. */
export function sourceCheckpointKey(
  agent: AgentName,
  ref: SourceSessionRef,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        agent,
        key: ref.key,
        sourceSessionId: ref.sourceSessionId,
      }),
      'utf8',
    )
    .digest('hex');
  return `source:v1:${digest}`;
}
