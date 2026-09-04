import type {
  AssignWorkThreadSessionRequest,
  CreateWorkThreadRequest,
  EventReadback,
  SourceEvent,
  SourceSession,
  SourceSessionList,
  ThreadDecision,
  ThreadError,
  ThreadFileActivity,
  ThreadSuggestion,
  ThreadSuggestionList,
  ThreadTask,
  UpdateWorkThreadRequest,
  WorkThread,
  WorkThreadList,
  WorkThreadOverview,
  WorkThreadSession,
  WorkThreadSessionList,
} from '@baton/protocol';

import type { IngestionRequestContext } from './ingestion-store.js';

export interface WorkThreadReadQuery {
  cursor?: string | null;
  limit?: number;
}

export interface WorkThreadStore {
  listWorkThreads(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<WorkThreadList>;
  createWorkThread(
    context: IngestionRequestContext,
    input: CreateWorkThreadRequest,
  ): Promise<WorkThread>;
  updateWorkThread(
    context: IngestionRequestContext,
    workThreadId: string,
    input: UpdateWorkThreadRequest,
  ): Promise<WorkThread>;
  listThreadSessions(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadSessionList>;
  assignSession(
    context: IngestionRequestContext,
    workThreadId: string,
    input: AssignWorkThreadSessionRequest,
  ): Promise<WorkThreadSession>;
  removeSession(
    context: IngestionRequestContext,
    workThreadId: string,
    sourceSessionId: string,
  ): Promise<void>;
  readWorkThreadEvents(
    context: IngestionRequestContext,
    workThreadId: string,
    query: WorkThreadReadQuery,
  ): Promise<EventReadback>;
  getWorkThreadOverview(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadOverview>;
  listProjectSourceSessions(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<SourceSessionList>;
  suggestThreads(
    context: IngestionRequestContext,
    projectId: string,
    sourceSessionId: string | null,
  ): Promise<ThreadSuggestionList>;
}

export const maxWorkThreadReadLimit = 500;
export const defaultWorkThreadReadLimit = 100;

/**
 * Deterministic total order over events within a thread: native sequence when
 * both sides expose it, then occurrence time, then event id as a stable tie
 * break. Matches the ingestion head-selection order so a thread reads the same
 * way regardless of which device delivered an event.
 */
export function compareThreadEvents(
  left: SourceEvent,
  right: SourceEvent,
): number {
  if (left.nativeSequence !== null && right.nativeSequence !== null) {
    const sequence = left.nativeSequence - right.nativeSequence;
    if (sequence !== 0) return sequence;
  }
  const occurred = left.occurredAt.localeCompare(right.occurredAt);
  if (occurred !== 0) return occurred;
  return left.eventId.localeCompare(right.eventId);
}

function encodeCursor(event: SourceEvent): string {
  return Buffer.from(`${event.occurredAt}|${event.eventId}`, 'utf8').toString(
    'base64url',
  );
}

interface DecodedCursor {
  occurredAt: string;
  eventId: string;
}

export function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    return {
      occurredAt: decoded.slice(0, separator),
      eventId: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

/**
 * Build a bounded readback page from a thread's fully ordered events. Events
 * must already be sorted with {@link compareThreadEvents}. The cursor is opaque
 * and encodes the last returned event; `hasMore`/`nextCursor` follow the
 * PageInfo contract (present exactly together).
 */
export function buildReadbackPage(
  workThread: WorkThread,
  sessions: WorkThreadSession[],
  orderedEvents: SourceEvent[],
  query: WorkThreadReadQuery,
): EventReadback {
  const limit = clampLimit(query.limit);
  const start = cursorOffset(orderedEvents, query.cursor ?? null);
  const slice = orderedEvents.slice(start, start + limit);
  const hasMore = start + limit < orderedEvents.length;
  const last = slice.at(-1);
  return {
    workThread,
    sourceSessions: sessions,
    events: slice,
    page: {
      hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return defaultWorkThreadReadLimit;
  if (!Number.isInteger(limit) || limit < 1) return defaultWorkThreadReadLimit;
  return Math.min(limit, maxWorkThreadReadLimit);
}

function cursorOffset(
  orderedEvents: SourceEvent[],
  cursor: string | null,
): number {
  if (cursor === null) return 0;
  const decoded = decodeCursor(cursor);
  if (decoded === null) return 0;
  const index = orderedEvents.findIndex(
    (event) =>
      event.eventId === decoded.eventId &&
      event.occurredAt === decoded.occurredAt,
  );
  return index === -1 ? orderedEvents.length : index + 1;
}

/**
 * Derive the API source-session DTO (title, activity window) from a stored
 * session and its events. Title comes from the first session-metadata event;
 * the activity window is the min/max occurrence time.
 */
export function deriveSourceSession(
  base: {
    sourceSessionId: string;
    projectId: string;
    sourceAgent: SourceSession['sourceAgent'];
    nativeSessionHash: string;
  },
  events: SourceEvent[],
): SourceSession {
  let title: string | null = null;
  let startedAt: string | null = null;
  let lastEventAt: string | null = null;
  for (const event of events) {
    if (
      title === null &&
      event.payload.kind === 'session_metadata' &&
      event.payload.title !== undefined
    ) {
      title = event.payload.title;
    }
    if (startedAt === null || event.occurredAt < startedAt)
      startedAt = event.occurredAt;
    if (lastEventAt === null || event.occurredAt > lastEventAt)
      lastEventAt = event.occurredAt;
  }
  return {
    sourceSessionId: base.sourceSessionId,
    projectId: base.projectId,
    sourceAgent: base.sourceAgent,
    nativeSessionHash: base.nativeSessionHash,
    title,
    startedAt,
    lastEventAt,
  };
}

/**
 * Materialize the current state of a thread from its immutable events. Every
 * derived item cites the event it came from. Tasks collapse to their latest
 * status (keyed by native task id when present, else text); file activity is
 * grouped by path. Nothing here is authoritative without its evidence.
 */
export function projectThreadState(
  workThread: WorkThread,
  sessions: WorkThreadSession[],
  orderedEvents: SourceEvent[],
): WorkThreadOverview {
  const taskByKey = new Map<string, ThreadTask>();
  const decisions: ThreadDecision[] = [];
  const errors: ThreadError[] = [];
  const fileByPath = new Map<
    string,
    { operations: Set<ThreadFileActivity['operations'][number]> } & Omit<
      ThreadFileActivity,
      'operations'
    >
  >();
  let lastActivityAt: string | null = null;

  for (const event of orderedEvents) {
    if (lastActivityAt === null || event.occurredAt > lastActivityAt)
      lastActivityAt = event.occurredAt;
    const payload = event.payload;
    switch (payload.kind) {
      case 'task': {
        const key = payload.nativeTaskId ?? payload.text;
        taskByKey.set(key, {
          text: payload.text,
          status: payload.status,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
        });
        break;
      }
      case 'decision':
        decisions.push({
          summary: payload.summary,
          rationale: payload.rationale ?? null,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
        });
        break;
      case 'error':
        errors.push({
          message: payload.message,
          command: payload.command ?? null,
          eventId: event.eventId,
          occurredAt: event.occurredAt,
        });
        break;
      case 'file_change': {
        const existing = fileByPath.get(payload.path);
        if (existing === undefined) {
          fileByPath.set(payload.path, {
            path: payload.path,
            operations: new Set([payload.operation]),
            changeCount: 1,
            lastEventId: event.eventId,
            lastOccurredAt: event.occurredAt,
          });
        } else {
          existing.operations.add(payload.operation);
          existing.changeCount += 1;
          existing.lastEventId = event.eventId;
          existing.lastOccurredAt = event.occurredAt;
        }
        break;
      }
      default:
        break;
    }
  }

  const fileActivities: ThreadFileActivity[] = [...fileByPath.values()]
    .map((entry) => ({
      path: entry.path,
      operations: [...entry.operations],
      changeCount: entry.changeCount,
      lastEventId: entry.lastEventId,
      lastOccurredAt: entry.lastOccurredAt,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    workThread,
    sessions,
    tasks: [...taskByKey.values()],
    decisions,
    fileActivities,
    errors,
    eventCount: orderedEvents.length,
    lastActivityAt,
  };
}

/**
 * Collect the distinct project-relative file paths a source session touched,
 * from both file-change events and path-bearing tool calls. Used for
 * conservative file-overlap scoring between sessions.
 */
export function fileFootprint(events: SourceEvent[]): Set<string> {
  const paths = new Set<string>();
  for (const event of events) {
    if (event.payload.kind === 'file_change') paths.add(event.payload.path);
  }
  return paths;
}

function gitBranch(events: SourceEvent[]): string | null {
  for (const event of events) {
    if (
      event.payload.kind === 'session_metadata' &&
      event.payload.gitBranch !== undefined
    ) {
      return event.payload.gitBranch;
    }
  }
  return null;
}

export interface ThreadScoringInput {
  workThread: WorkThread;
  /** Source session ids already assigned (any assignment) to this thread. */
  assignedSourceSessionIds: Set<string>;
  /** Events across all sessions currently in the thread, ordered. */
  events: SourceEvent[];
}

export interface CandidateSession {
  sourceSessionId: string;
  events: SourceEvent[];
}

const recentActivityWindowMs = 72 * 60 * 60 * 1000;

/**
 * Conservative, deterministic thread-suggestion scoring. Signals are additive
 * and bounded to [0,1]; a thread only surfaces when it shares concrete
 * evidence with the candidate (same session, overlapping files, same branch)
 * or is the project's sole active thread. Prose is never compared.
 */
export function scoreThreadSuggestion(
  thread: ThreadScoringInput,
  candidate: CandidateSession | null,
  context: { activeThreadCount: number; nowMs: number },
): ThreadSuggestion | null {
  const reasons: ThreadSuggestion['reasons'] = [];
  const sharedFilePaths: string[] = [];
  let score = 0;

  if (
    candidate !== null &&
    thread.assignedSourceSessionIds.has(candidate.sourceSessionId)
  ) {
    reasons.push('shared_source_session');
    score = 1;
  }

  if (candidate !== null && !reasons.includes('shared_source_session')) {
    const threadFiles = fileFootprint(thread.events);
    const candidateFiles = fileFootprint(candidate.events);
    for (const path of candidateFiles) {
      if (threadFiles.has(path)) sharedFilePaths.push(path);
    }
    if (sharedFilePaths.length > 0) {
      reasons.push('shared_files');
      score += Math.min(0.5, 0.15 * sharedFilePaths.length);
    }
    const threadBranch = gitBranch(thread.events);
    const candidateBranch = gitBranch(candidate.events);
    if (
      threadBranch !== null &&
      candidateBranch !== null &&
      threadBranch === candidateBranch
    ) {
      reasons.push('same_branch');
      score += 0.3;
    }
  }

  const lastActivity = lastOccurredAt(thread.events);
  if (
    lastActivity !== null &&
    context.nowMs - Date.parse(lastActivity) <= recentActivityWindowMs
  ) {
    reasons.push('recent_activity');
    score += 0.1;
  }

  if (
    thread.workThread.state === 'active' &&
    context.activeThreadCount === 1 &&
    reasons.length === 0
  ) {
    reasons.push('sole_active_thread');
    score += 0.15;
  }

  if (reasons.length === 0) return null;
  sharedFilePaths.sort();
  return {
    workThread: thread.workThread,
    score: Math.min(1, Number(score.toFixed(4))),
    reasons,
    sharedFilePaths: sharedFilePaths.slice(0, 50),
  };
}

function lastOccurredAt(events: SourceEvent[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (latest === null || event.occurredAt > latest) latest = event.occurredAt;
  }
  return latest;
}

/**
 * Rank suggestions highest score first, then most recent thread, then id, and
 * cap the list. Deterministic so the CLI and dashboard agree on the top pick.
 */
export function rankSuggestions(
  suggestions: ThreadSuggestion[],
): ThreadSuggestion[] {
  return [...suggestions]
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const updated = right.workThread.updatedAt.localeCompare(
        left.workThread.updatedAt,
      );
      if (updated !== 0) return updated;
      return left.workThread.workThreadId.localeCompare(
        right.workThread.workThreadId,
      );
    })
    .slice(0, 50);
}
