import { randomUUID } from 'node:crypto';

import {
  createSourceEvent,
  type SourceEvent,
  type SourceEventPayload,
  type WorkThread,
  type WorkThreadSession,
} from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildReadbackPage,
  compareThreadEvents,
  decodeCursor,
  deriveSourceSession,
  projectThreadState,
  rankSuggestions,
  scoreThreadSuggestion,
  type ThreadScoringInput,
} from '../src/work-thread-store.js';

const sessionA = '80000000-0000-4000-8000-0000000000a1';
const sessionB = '80000000-0000-4000-8000-0000000000b2';
const deviceA = '80000000-0000-4000-8000-0000000000d1';
const deviceB = '80000000-0000-4000-8000-0000000000d2';

function event(
  payload: SourceEventPayload,
  overrides: {
    sourceSessionId?: string;
    sourceAgent?: SourceEvent['sourceAgent'];
    sourceDeviceId?: string;
    occurredAt?: string;
    nativeSequence?: number | null;
  } = {},
): SourceEvent {
  const occurredAt = overrides.occurredAt ?? '2026-07-01T10:00:00.000Z';
  return createSourceEvent({
    sourceSessionId: overrides.sourceSessionId ?? sessionA,
    workThreadId: null,
    sourceAgent: overrides.sourceAgent ?? 'claudecode',
    sourceDeviceId: overrides.sourceDeviceId ?? deviceA,
    nativeSequence: overrides.nativeSequence ?? null,
    parentEventId: null,
    occurredAt,
    observedAt: occurredAt,
    schemaVersion: 1,
    payload,
  });
}

const workThread: WorkThread = {
  workThreadId: randomUUID(),
  projectId: randomUUID(),
  title: 'Implement hosted authentication',
  goal: null,
  state: 'active',
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
};

describe('projectThreadState', () => {
  it('materializes tasks, decisions, files, and errors with evidence links', () => {
    const events = [
      event({ kind: 'message', role: 'user', text: 'Start auth work.' }),
      event(
        {
          kind: 'task',
          nativeTaskId: 't1',
          text: 'Add login',
          status: 'pending',
        },
        { occurredAt: '2026-07-01T10:01:00.000Z' },
      ),
      event(
        {
          kind: 'task',
          nativeTaskId: 't1',
          text: 'Add login',
          status: 'completed',
        },
        { occurredAt: '2026-07-01T10:05:00.000Z' },
      ),
      event(
        {
          kind: 'file_change',
          path: 'src/auth.ts',
          operation: 'create',
          summary: 'new file',
        },
        { occurredAt: '2026-07-01T10:02:00.000Z' },
      ),
      event(
        { kind: 'file_change', path: 'src/auth.ts', operation: 'edit' },
        { occurredAt: '2026-07-01T10:03:00.000Z' },
      ),
      event(
        {
          kind: 'decision',
          summary: 'Use OAuth device flow',
          rationale: 'CLI',
        },
        { occurredAt: '2026-07-01T10:04:00.000Z' },
      ),
      event(
        { kind: 'error', message: 'build failed', command: 'go build' },
        { occurredAt: '2026-07-01T10:06:00.000Z' },
      ),
    ].sort(compareThreadEvents);

    const overview = projectThreadState(workThread, [], events);

    // Task collapses to its latest status, keyed by native id.
    expect(overview.tasks).toHaveLength(1);
    expect(overview.tasks[0]).toMatchObject({
      text: 'Add login',
      status: 'completed',
    });
    expect(overview.decisions).toHaveLength(1);
    expect(overview.decisions[0]).toMatchObject({
      summary: 'Use OAuth device flow',
      rationale: 'CLI',
    });
    expect(overview.errors[0]).toMatchObject({
      message: 'build failed',
      command: 'go build',
    });
    expect(overview.fileActivities).toHaveLength(1);
    expect(overview.fileActivities[0]).toMatchObject({
      path: 'src/auth.ts',
      operations: ['create', 'edit'],
      changeCount: 2,
    });
    expect(overview.eventCount).toBe(events.length);
    expect(overview.lastActivityAt).toBe('2026-07-01T10:06:00.000Z');
    // Every derived item cites a real event.
    const ids = new Set(events.map((event) => event.eventId));
    for (const item of [
      ...overview.tasks,
      ...overview.decisions,
      ...overview.errors,
    ]) {
      expect(ids.has(item.eventId)).toBe(true);
    }
  });
});

describe('buildReadbackPage', () => {
  const events = Array.from({ length: 5 }, (_, index) =>
    event(
      { kind: 'message', role: 'user', text: `turn ${index}` },
      { occurredAt: `2026-07-01T10:0${index}:00.000Z`, nativeSequence: index },
    ),
  ).sort(compareThreadEvents);

  it('paginates deterministically and follows the PageInfo contract', () => {
    const first = buildReadbackPage(workThread, [], events, { limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.page.hasMore).toBe(true);
    expect(first.page.nextCursor).not.toBeNull();

    const second = buildReadbackPage(workThread, [], events, {
      limit: 2,
      cursor: first.page.nextCursor,
    });
    expect(second.events.map((e) => e.eventId)).toEqual(
      events.slice(2, 4).map((e) => e.eventId),
    );

    const third = buildReadbackPage(workThread, [], events, {
      limit: 2,
      cursor: second.page.nextCursor,
    });
    expect(third.events).toHaveLength(1);
    expect(third.page.hasMore).toBe(false);
    expect(third.page.nextCursor).toBeNull();
  });

  it('decodes its own cursor', () => {
    const page = buildReadbackPage(workThread, [], events, { limit: 1 });
    const decoded = decodeCursor(page.page.nextCursor!);
    expect(decoded).not.toBeNull();
    expect(decoded!.eventId).toBe(events[0]!.eventId);
  });
});

describe('deriveSourceSession', () => {
  it('takes title from session metadata and the activity window from events', () => {
    const events = [
      event(
        {
          kind: 'session_metadata',
          title: 'Auth work',
          gitBranch: 'feat/auth',
        },
        { occurredAt: '2026-07-01T10:00:00.000Z' },
      ),
      event(
        { kind: 'message', role: 'assistant', text: 'done' },
        { occurredAt: '2026-07-01T10:30:00.000Z' },
      ),
    ];
    const derived = deriveSourceSession(
      {
        sourceSessionId: sessionA,
        projectId: workThread.projectId,
        sourceAgent: 'claudecode',
        nativeSessionHash: 'a'.repeat(64),
      },
      events,
    );
    expect(derived.title).toBe('Auth work');
    expect(derived.startedAt).toBe('2026-07-01T10:00:00.000Z');
    expect(derived.lastEventAt).toBe('2026-07-01T10:30:00.000Z');
  });
});

describe('scoreThreadSuggestion', () => {
  const nowMs = Date.parse('2026-07-01T11:00:00.000Z');

  function threadInput(
    events: SourceEvent[],
    assigned: string[],
  ): ThreadScoringInput {
    return {
      workThread,
      assignedSourceSessionIds: new Set(assigned),
      events,
    };
  }

  it('scores a shared source session as a certain continuation', () => {
    const events = [event({ kind: 'message', role: 'user', text: 'hi' })];
    const suggestion = scoreThreadSuggestion(
      threadInput(events, [sessionA]),
      { sourceSessionId: sessionA, events },
      { activeThreadCount: 3, nowMs },
    );
    expect(suggestion?.score).toBe(1);
    expect(suggestion?.reasons).toContain('shared_source_session');
  });

  it('scores file overlap and same branch across a new session', () => {
    const threadEvents = [
      event(
        { kind: 'session_metadata', gitBranch: 'feat/auth' },
        { occurredAt: '2026-07-01T10:00:00.000Z' },
      ),
      event(
        { kind: 'file_change', path: 'src/auth.ts', operation: 'edit' },
        { occurredAt: '2026-07-01T10:30:00.000Z' },
      ),
    ];
    const candidateEvents = [
      event(
        { kind: 'session_metadata', gitBranch: 'feat/auth' },
        {
          sourceSessionId: sessionB,
          sourceAgent: 'codex',
          sourceDeviceId: deviceB,
        },
      ),
      event(
        { kind: 'file_change', path: 'src/auth.ts', operation: 'edit' },
        {
          sourceSessionId: sessionB,
          sourceAgent: 'codex',
          sourceDeviceId: deviceB,
        },
      ),
    ];
    const suggestion = scoreThreadSuggestion(
      threadInput(threadEvents, [sessionA]),
      { sourceSessionId: sessionB, events: candidateEvents },
      { activeThreadCount: 2, nowMs },
    );
    expect(suggestion).not.toBeNull();
    expect(suggestion!.reasons).toEqual(
      expect.arrayContaining(['shared_files', 'same_branch']),
    );
    expect(suggestion!.sharedFilePaths).toContain('src/auth.ts');
    expect(suggestion!.score).toBeGreaterThan(0.4);
  });

  it('returns null when there is no concrete shared evidence', () => {
    const threadEvents = [
      event(
        { kind: 'file_change', path: 'src/one.ts', operation: 'edit' },
        { occurredAt: '2026-01-01T10:00:00.000Z' },
      ),
    ];
    const candidateEvents = [
      event(
        { kind: 'file_change', path: 'src/two.ts', operation: 'edit' },
        { sourceSessionId: sessionB },
      ),
    ];
    const suggestion = scoreThreadSuggestion(
      threadInput(threadEvents, [sessionA]),
      { sourceSessionId: sessionB, events: candidateEvents },
      { activeThreadCount: 3, nowMs },
    );
    expect(suggestion).toBeNull();
  });

  it('ranks suggestions by score then recency deterministically', () => {
    const ranked = rankSuggestions([
      {
        workThread: {
          ...workThread,
          workThreadId: 'a',
          updatedAt: '2026-07-01T10:00:00.000Z',
        },
        score: 0.3,
        reasons: ['recent_activity'],
        sharedFilePaths: [],
      },
      {
        workThread: {
          ...workThread,
          workThreadId: 'b',
          updatedAt: '2026-07-01T11:00:00.000Z',
        },
        score: 0.9,
        reasons: ['shared_files'],
        sharedFilePaths: [],
      },
    ]);
    expect(ranked.map((s) => s.workThread.workThreadId)).toEqual(['b', 'a']);
  });
});
