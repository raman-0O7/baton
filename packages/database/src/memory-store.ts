import type {
  ApproveMemoryRequest,
  Memory,
  MemoryCandidate,
  MemoryCandidateList,
  MemoryCategory,
  MemoryList,
  MemoryProvenance,
  MemoryScope,
  MemoryStatus,
  SoulDocument,
} from '@baton/protocol';

import type { IngestionRequestContext } from './ingestion-store.js';

export interface MemoryEvidence {
  eventId: string;
  projectId: string;
  workThreadId: string | null;
  text: string;
  role?: string;
}

export interface MemoryProposeInput {
  category: MemoryCategory;
  claim: string;
  scope: MemoryScope;
  evidence: MemoryEvidence[];
  provenance?: MemoryProvenance;
}

export const manualProvenance: MemoryProvenance = {
  provider: 'user',
  model: 'manual',
  promptVersion: 'manual-v1',
};

export function memorySignature(claim: string, scope: MemoryScope): string {
  const normalized = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${scope.type}:${scope.id ?? ''}:${normalized}`;
}

export interface MemoryScopeFilter {
  projectId?: string;
  workThreadId?: string;
}

export interface MemoryStore {
  /**
   * Validate and record a proposed memory. Prohibited, contradictory, narrow,
   * or over-broad proposals are recorded with the reason and a non-approvable
   * status; only acceptable or review-worthy candidates enter the inbox. An
   * identical proposal that was previously rejected is not regenerated.
   */
  proposeCandidate(
    context: IngestionRequestContext,
    input: MemoryProposeInput,
  ): Promise<MemoryCandidate>;
  listCandidates(
    context: IngestionRequestContext,
    statuses?: MemoryStatus[],
  ): Promise<MemoryCandidateList>;
  /**
   * Approve a candidate (optionally narrowing scope or editing the claim) into
   * an approved memory. Re-screens the final claim so an edit can never turn a
   * candidate into a prohibited sensitive assertion, and refuses to approve a
   * rejected/revoked candidate.
   */
  approveCandidate(
    context: IngestionRequestContext,
    candidateId: string,
    input: ApproveMemoryRequest,
  ): Promise<Memory>;
  rejectCandidate(
    context: IngestionRequestContext,
    candidateId: string,
  ): Promise<void>;
  /** Approved, unexpired memories only — the sole memories an agent may see. */
  listMemories(
    context: IngestionRequestContext,
    filter?: MemoryScopeFilter,
  ): Promise<MemoryList>;
  revokeMemory(
    context: IngestionRequestContext,
    memoryId: string,
  ): Promise<void>;
  renderSoulDocument(
    context: IngestionRequestContext,
    options: { tokenBudget: number; filter?: MemoryScopeFilter },
  ): Promise<SoulDocument>;
}

export function toMilli(confidence: number): number {
  return Math.max(0, Math.min(1000, Math.round(confidence * 1000)));
}

export function fromMilli(milli: number): number {
  return Number((milli / 1000).toFixed(4));
}

/** A memory is visible to agents only when approved and not past expiry. */
export function isLiveMemory(
  memory: { status: MemoryStatus; expiresAt: string | null },
  nowMs: number,
): boolean {
  if (memory.status !== 'approved') return false;
  return memory.expiresAt === null || Date.parse(memory.expiresAt) > nowMs;
}

export function matchesScopeFilter(
  scope: MemoryScope,
  filter: MemoryScopeFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (scope.type === 'global' || scope.type === 'organization') return true;
  if (scope.type === 'project') {
    return filter.projectId === undefined || scope.id === filter.projectId;
  }
  // work_thread scope
  return filter.workThreadId === undefined || scope.id === filter.workThreadId;
}
