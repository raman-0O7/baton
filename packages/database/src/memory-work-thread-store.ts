import { randomUUID } from 'node:crypto';

import type {
  AgentName,
  AssignWorkThreadSessionRequest,
  CreateWorkThreadRequest,
  EventReadback,
  SourceSessionList,
  ThreadSuggestion,
  ThreadSuggestionList,
  UpdateWorkThreadRequest,
  WorkThread,
  WorkThreadList,
  WorkThreadOverview,
  WorkThreadSession,
  WorkThreadSessionAssignment,
  WorkThreadSessionList,
} from '@baton/protocol';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import type { InMemoryIngestionStore } from './memory-ingestion-store.js';
import {
  buildReadbackPage,
  compareThreadEvents,
  deriveSourceSession,
  projectThreadState,
  rankSuggestions,
  scoreThreadSuggestion,
  type CandidateSession,
  type ThreadScoringInput,
  type WorkThreadReadQuery,
  type WorkThreadStore,
} from './work-thread-store.js';

interface StoredThread {
  tenantId: string;
  workThreadId: string;
  projectId: string;
  title: string;
  goal: string | null;
  state: WorkThread['state'];
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredThreadSession {
  tenantId: string;
  workThreadId: string;
  sourceSessionId: string;
  position: number;
  assignment: WorkThreadSessionAssignment;
  assignedAt: string;
}

/**
 * In-memory work-thread store used by API tests and the local dev harness. It
 * reads captured source sessions and events from an {@link InMemoryIngestionStore}
 * so a thread sees the same events the ingestion path stored, exactly as the
 * Postgres store reads shared tables.
 */
export class InMemoryWorkThreadStore implements WorkThreadStore {
  private readonly threads = new Map<string, StoredThread>();
  private readonly threadSessionLinks = new Map<string, StoredThreadSession>();
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly ingestion: InMemoryIngestionStore,
    private readonly now: () => number = Date.now,
  ) {}

  async listWorkThreads(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<WorkThreadList> {
    return this.exclusive(() => {
      this.requireProject(context, projectId);
      return {
        workThreads: [...this.threads.values()]
          .filter(
            (thread) =>
              thread.tenantId === context.principal.tenantId &&
              thread.projectId === projectId,
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
          .map(threadResponse),
      };
    });
  }

  async createWorkThread(
    context: IngestionRequestContext,
    input: CreateWorkThreadRequest,
  ): Promise<WorkThread> {
    return this.exclusive(() => {
      this.requireProject(context, input.projectId);
      const now = new Date(this.now()).toISOString();
      const thread: StoredThread = {
        tenantId: context.principal.tenantId,
        workThreadId: randomUUID(),
        projectId: input.projectId,
        title: input.title,
        goal: input.goal,
        state: 'active',
        createdByUserId: context.principal.userId,
        createdAt: now,
        updatedAt: now,
      };
      this.threads.set(threadKey(thread.tenantId, thread.workThreadId), thread);
      return threadResponse(thread);
    });
  }

  async updateWorkThread(
    context: IngestionRequestContext,
    workThreadId: string,
    input: UpdateWorkThreadRequest,
  ): Promise<WorkThread> {
    return this.exclusive(() => {
      const thread = this.requireThread(context, workThreadId);
      if (input.title !== undefined) thread.title = input.title;
      if (input.goal !== undefined) thread.goal = input.goal;
      if (input.state !== undefined) thread.state = input.state;
      thread.updatedAt = new Date(this.now()).toISOString();
      return threadResponse(thread);
    });
  }

  async listThreadSessions(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadSessionList> {
    return this.exclusive(() => {
      this.requireThread(context, workThreadId);
      return { sessions: this.threadSessions(context, workThreadId) };
    });
  }

  async assignSession(
    context: IngestionRequestContext,
    workThreadId: string,
    input: AssignWorkThreadSessionRequest,
  ): Promise<WorkThreadSession> {
    return this.exclusive(() => {
      const thread = this.requireThread(context, workThreadId);
      const session = this.ingestion.sourceSessionById(
        context.principal.tenantId,
        input.sourceSessionId,
      );
      if (session === undefined) notFound('source session');
      if (session.projectId !== thread.projectId) {
        throw new IngestionStoreError(
          'conflict',
          409,
          'The source session belongs to a different project than the work thread.',
        );
      }
      const existingElsewhere = [...this.threadSessionLinks.values()].find(
        (link) =>
          link.tenantId === context.principal.tenantId &&
          link.sourceSessionId === input.sourceSessionId &&
          link.workThreadId !== workThreadId,
      );
      if (existingElsewhere !== undefined) {
        throw new IngestionStoreError(
          'conflict',
          409,
          'The source session is already assigned to another work thread.',
        );
      }
      const linkKey = threadSessionKey(
        context.principal.tenantId,
        workThreadId,
        input.sourceSessionId,
      );
      const now = new Date(this.now()).toISOString();
      const existing = this.threadSessionLinks.get(linkKey);
      const position =
        existing?.position ?? this.nextPosition(context, workThreadId);
      const link: StoredThreadSession = {
        tenantId: context.principal.tenantId,
        workThreadId,
        sourceSessionId: input.sourceSessionId,
        position,
        assignment: input.assignment,
        assignedAt: now,
      };
      this.threadSessionLinks.set(linkKey, link);
      thread.updatedAt = now;
      return this.sessionResponse(context, link, session);
    });
  }

  async removeSession(
    context: IngestionRequestContext,
    workThreadId: string,
    sourceSessionId: string,
  ): Promise<void> {
    return this.exclusive(() => {
      const thread = this.requireThread(context, workThreadId);
      const linkKey = threadSessionKey(
        context.principal.tenantId,
        workThreadId,
        sourceSessionId,
      );
      if (this.threadSessionLinks.delete(linkKey)) {
        thread.updatedAt = new Date(this.now()).toISOString();
      }
    });
  }

  async readWorkThreadEvents(
    context: IngestionRequestContext,
    workThreadId: string,
    query: WorkThreadReadQuery,
  ): Promise<EventReadback> {
    return this.exclusive(() => {
      const thread = this.requireThread(context, workThreadId);
      const sessions = this.threadSessions(context, workThreadId);
      const events = this.ingestion
        .eventsForSessions(
          context.principal.tenantId,
          sessions.map((session) => session.sourceSession.sourceSessionId),
        )
        .sort(compareThreadEvents);
      return buildReadbackPage(threadResponse(thread), sessions, events, query);
    });
  }

  async getWorkThreadOverview(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadOverview> {
    return this.exclusive(() => {
      const thread = this.requireThread(context, workThreadId);
      const sessions = this.threadSessions(context, workThreadId);
      const events = this.ingestion
        .eventsForSessions(
          context.principal.tenantId,
          sessions.map((session) => session.sourceSession.sourceSessionId),
        )
        .sort(compareThreadEvents);
      return projectThreadState(threadResponse(thread), sessions, events);
    });
  }

  async listProjectSourceSessions(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<SourceSessionList> {
    return this.exclusive(() => {
      this.requireProject(context, projectId);
      const sessions = this.ingestion.sourceSessionsForProject(
        context.principal.tenantId,
        projectId,
      );
      return {
        sourceSessions: sessions.map((session) =>
          deriveSourceSession(
            {
              sourceSessionId: session.sourceSessionId,
              projectId: session.projectId,
              sourceAgent: session.agent as AgentName,
              nativeSessionHash: session.nativeSessionHash,
            },
            this.ingestion.eventsForSessions(context.principal.tenantId, [
              session.sourceSessionId,
            ]),
          ),
        ),
      };
    });
  }

  async suggestThreads(
    context: IngestionRequestContext,
    projectId: string,
    sourceSessionId: string | null,
  ): Promise<ThreadSuggestionList> {
    return this.exclusive(() => {
      this.requireProject(context, projectId);
      let candidate: CandidateSession | null = null;
      if (sourceSessionId !== null) {
        const session = this.ingestion.sourceSessionById(
          context.principal.tenantId,
          sourceSessionId,
        );
        if (session === undefined || session.projectId !== projectId)
          notFound('source session');
        candidate = {
          sourceSessionId,
          events: this.ingestion.eventsForSessions(context.principal.tenantId, [
            sourceSessionId,
          ]),
        };
      }
      const threads = [...this.threads.values()].filter(
        (thread) =>
          thread.tenantId === context.principal.tenantId &&
          thread.projectId === projectId,
      );
      const activeThreadCount = threads.filter(
        (thread) => thread.state === 'active',
      ).length;
      const suggestions: ThreadSuggestion[] = [];
      for (const thread of threads) {
        const assignedSourceSessionIds = new Set(
          [...this.threadSessionLinks.values()]
            .filter(
              (link) =>
                link.tenantId === context.principal.tenantId &&
                link.workThreadId === thread.workThreadId,
            )
            .map((link) => link.sourceSessionId),
        );
        const events = this.ingestion
          .eventsForSessions(context.principal.tenantId, [
            ...assignedSourceSessionIds,
          ])
          .sort(compareThreadEvents);
        const scoring: ThreadScoringInput = {
          workThread: threadResponse(thread),
          assignedSourceSessionIds,
          events,
        };
        const suggestion = scoreThreadSuggestion(scoring, candidate, {
          activeThreadCount,
          nowMs: this.now(),
        });
        if (suggestion !== null) suggestions.push(suggestion);
      }
      return { sourceSessionId, suggestions: rankSuggestions(suggestions) };
    });
  }

  private threadSessions(
    context: IngestionRequestContext,
    workThreadId: string,
  ): WorkThreadSession[] {
    return [...this.threadSessionLinks.values()]
      .filter(
        (link) =>
          link.tenantId === context.principal.tenantId &&
          link.workThreadId === workThreadId,
      )
      .sort((left, right) => left.position - right.position)
      .flatMap((link) => {
        const session = this.ingestion.sourceSessionById(
          context.principal.tenantId,
          link.sourceSessionId,
        );
        if (session === undefined) return [];
        return [this.sessionResponse(context, link, session)];
      });
  }

  private sessionResponse(
    context: IngestionRequestContext,
    link: StoredThreadSession,
    session: {
      sourceSessionId: string;
      projectId: string;
      agent: string;
      nativeSessionHash: string;
    },
  ): WorkThreadSession {
    return {
      workThreadId: link.workThreadId,
      sourceSession: deriveSourceSession(
        {
          sourceSessionId: session.sourceSessionId,
          projectId: session.projectId,
          sourceAgent: session.agent as AgentName,
          nativeSessionHash: session.nativeSessionHash,
        },
        this.ingestion.eventsForSessions(context.principal.tenantId, [
          session.sourceSessionId,
        ]),
      ),
      position: link.position,
      assignment: link.assignment,
      assignedAt: link.assignedAt,
    };
  }

  private nextPosition(
    context: IngestionRequestContext,
    workThreadId: string,
  ): number {
    let max = -1;
    for (const link of this.threadSessionLinks.values()) {
      if (
        link.tenantId === context.principal.tenantId &&
        link.workThreadId === workThreadId
      ) {
        max = Math.max(max, link.position);
      }
    }
    return max + 1;
  }

  private requireProject(
    context: IngestionRequestContext,
    projectId: string,
  ): void {
    if (!this.ingestion.projectExists(context.principal.tenantId, projectId)) {
      notFound('project');
    }
  }

  private requireThread(
    context: IngestionRequestContext,
    workThreadId: string,
  ): StoredThread {
    const thread = this.threads.get(
      threadKey(context.principal.tenantId, workThreadId),
    );
    if (thread === undefined || thread.tenantId !== context.principal.tenantId)
      notFound('work thread');
    return thread;
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function threadResponse(thread: StoredThread): WorkThread {
  return {
    workThreadId: thread.workThreadId,
    projectId: thread.projectId,
    title: thread.title,
    goal: thread.goal,
    state: thread.state,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function threadKey(tenantId: string, workThreadId: string): string {
  return `${tenantId}:${workThreadId}`;
}

function threadSessionKey(
  tenantId: string,
  workThreadId: string,
  sourceSessionId: string,
): string {
  return `${tenantId}:${workThreadId}:${sourceSessionId}`;
}

function notFound(label: string): never {
  throw new IngestionStoreError(
    'not_found',
    404,
    `The ${label} was not found.`,
  );
}
