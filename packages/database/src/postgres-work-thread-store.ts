import { randomUUID } from 'node:crypto';

import {
  type AssignWorkThreadSessionRequest,
  type CreateWorkThreadRequest,
  type EventReadback,
  type SourceEvent,
  type SourceSessionList,
  type ThreadSuggestion,
  type ThreadSuggestionList,
  type UpdateWorkThreadRequest,
  type WorkThread,
  type WorkThreadList,
  type WorkThreadOverview,
  type WorkThreadSession,
  type WorkThreadSessionList,
} from '@baton/protocol';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import {
  auditEvents,
  identitySchema,
  projects,
  sourceEvents,
  sourceSessions,
  workThreads,
  workThreadSessions,
} from './schema.js';
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

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const maxSuggestionThreads = 100;
const maxSessionsPerProject = 500;

export class PostgresWorkThreadStore implements WorkThreadStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async listWorkThreads(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<WorkThreadList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const rows = await tx
        .select()
        .from(workThreads)
        .where(
          and(
            eq(workThreads.tenantId, context.principal.tenantId),
            eq(workThreads.projectId, projectId),
          ),
        )
        .orderBy(desc(workThreads.updatedAt));
      return { workThreads: rows.map(workThreadFromRow) };
    });
  }

  async createWorkThread(
    context: IngestionRequestContext,
    input: CreateWorkThreadRequest,
  ): Promise<WorkThread> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, input.projectId);
      const now = new Date(this.now());
      const [row] = await tx
        .insert(workThreads)
        .values({
          tenantId: context.principal.tenantId,
          workThreadId: randomUUID(),
          projectId: input.projectId,
          title: input.title,
          goal: input.goal,
          state: 'active',
          createdByUserId: context.principal.userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await appendAudit(
        tx,
        context,
        'work_thread.created',
        'work_thread',
        row!.workThreadId,
        { projectId: input.projectId, workThreadId: row!.workThreadId },
        now,
      );
      return workThreadFromRow(row!);
    });
  }

  async updateWorkThread(
    context: IngestionRequestContext,
    workThreadId: string,
    input: UpdateWorkThreadRequest,
  ): Promise<WorkThread> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const now = new Date(this.now());
      const patch: Partial<typeof workThreads.$inferInsert> = {
        updatedAt: now,
      };
      if (input.title !== undefined) patch.title = input.title;
      if (input.goal !== undefined) patch.goal = input.goal;
      if (input.state !== undefined) patch.state = input.state;
      const [row] = await tx
        .update(workThreads)
        .set(patch)
        .where(
          and(
            eq(workThreads.tenantId, context.principal.tenantId),
            eq(workThreads.workThreadId, workThreadId),
          ),
        )
        .returning();
      if (row === undefined) notFound('work thread');
      await appendAudit(
        tx,
        context,
        'work_thread.updated',
        'work_thread',
        workThreadId,
        { workThreadId, state: row.state },
        now,
      );
      return workThreadFromRow(row);
    });
  }

  async listThreadSessions(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadSessionList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireThread(tx, context.principal.tenantId, workThreadId);
      return {
        sessions: await this.threadSessions(
          tx,
          context.principal.tenantId,
          workThreadId,
        ),
      };
    });
  }

  async assignSession(
    context: IngestionRequestContext,
    workThreadId: string,
    input: AssignWorkThreadSessionRequest,
  ): Promise<WorkThreadSession> {
    return this.db.transaction(
      async (tx) => {
        await setTenant(tx, context.principal.tenantId);
        const thread = await requireThread(
          tx,
          context.principal.tenantId,
          workThreadId,
        );
        const [session] = await tx
          .select()
          .from(sourceSessions)
          .where(
            and(
              eq(sourceSessions.tenantId, context.principal.tenantId),
              eq(sourceSessions.sourceSessionId, input.sourceSessionId),
            ),
          )
          .limit(1);
        if (session === undefined) notFound('source session');
        if (session.projectId !== thread.projectId) {
          throw new IngestionStoreError(
            'conflict',
            409,
            'The source session belongs to a different project than the work thread.',
          );
        }
        const [existing] = await tx
          .select()
          .from(workThreadSessions)
          .where(
            and(
              eq(workThreadSessions.tenantId, context.principal.tenantId),
              eq(workThreadSessions.sourceSessionId, input.sourceSessionId),
            ),
          )
          .limit(1)
          .for('update');
        const now = new Date(this.now());
        if (existing !== undefined && existing.workThreadId !== workThreadId) {
          throw new IngestionStoreError(
            'conflict',
            409,
            'The source session is already assigned to another work thread.',
          );
        }
        let position = existing?.position ?? 0;
        if (existing === undefined) {
          const [{ value } = { value: 0 }] = await tx
            .select({
              value: sql<number>`coalesce(max(${workThreadSessions.position}) + 1, 0)`,
            })
            .from(workThreadSessions)
            .where(
              and(
                eq(workThreadSessions.tenantId, context.principal.tenantId),
                eq(workThreadSessions.workThreadId, workThreadId),
              ),
            );
          position = Number(value);
        }
        await tx
          .insert(workThreadSessions)
          .values({
            tenantId: context.principal.tenantId,
            workThreadId,
            sourceSessionId: input.sourceSessionId,
            position,
            assignment: input.assignment,
            assignedByUserId: context.principal.userId,
            assignedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              workThreadSessions.tenantId,
              workThreadSessions.workThreadId,
              workThreadSessions.sourceSessionId,
            ],
            set: { assignment: input.assignment, assignedAt: now },
          });
        await tx
          .update(workThreads)
          .set({ updatedAt: now })
          .where(
            and(
              eq(workThreads.tenantId, context.principal.tenantId),
              eq(workThreads.workThreadId, workThreadId),
            ),
          );
        await appendAudit(
          tx,
          context,
          'work_thread.session.assigned',
          'work_thread',
          workThreadId,
          {
            workThreadId,
            sourceSessionId: input.sourceSessionId,
            assignment: input.assignment,
          },
          now,
        );
        const events = await this.eventsForSessions(
          tx,
          context.principal.tenantId,
          [input.sourceSessionId],
        );
        return {
          workThreadId,
          sourceSession: deriveSourceSession(
            {
              sourceSessionId: session.sourceSessionId,
              projectId: session.projectId,
              sourceAgent: session.agent,
              nativeSessionHash: session.nativeSessionHash,
            },
            events,
          ),
          position,
          assignment: input.assignment,
          assignedAt: now.toISOString(),
        };
      },
      { isolationLevel: 'serializable' },
    );
  }

  async removeSession(
    context: IngestionRequestContext,
    workThreadId: string,
    sourceSessionId: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireThread(tx, context.principal.tenantId, workThreadId);
      const deleted = await tx
        .delete(workThreadSessions)
        .where(
          and(
            eq(workThreadSessions.tenantId, context.principal.tenantId),
            eq(workThreadSessions.workThreadId, workThreadId),
            eq(workThreadSessions.sourceSessionId, sourceSessionId),
          ),
        )
        .returning({ id: workThreadSessions.sourceSessionId });
      if (deleted.length === 0) return;
      const now = new Date(this.now());
      await tx
        .update(workThreads)
        .set({ updatedAt: now })
        .where(
          and(
            eq(workThreads.tenantId, context.principal.tenantId),
            eq(workThreads.workThreadId, workThreadId),
          ),
        );
      await appendAudit(
        tx,
        context,
        'work_thread.session.removed',
        'work_thread',
        workThreadId,
        { workThreadId, sourceSessionId },
        now,
      );
    });
  }

  async readWorkThreadEvents(
    context: IngestionRequestContext,
    workThreadId: string,
    query: WorkThreadReadQuery,
  ): Promise<EventReadback> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const thread = await requireThread(
        tx,
        context.principal.tenantId,
        workThreadId,
      );
      const sessions = await this.threadSessions(
        tx,
        context.principal.tenantId,
        workThreadId,
      );
      const events = await this.eventsForSessions(
        tx,
        context.principal.tenantId,
        sessions.map((session) => session.sourceSession.sourceSessionId),
      );
      events.sort(compareThreadEvents);
      return buildReadbackPage(
        workThreadFromRow(thread),
        sessions,
        events,
        query,
      );
    });
  }

  async getWorkThreadOverview(
    context: IngestionRequestContext,
    workThreadId: string,
  ): Promise<WorkThreadOverview> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const thread = await requireThread(
        tx,
        context.principal.tenantId,
        workThreadId,
      );
      const sessions = await this.threadSessions(
        tx,
        context.principal.tenantId,
        workThreadId,
      );
      const events = await this.eventsForSessions(
        tx,
        context.principal.tenantId,
        sessions.map((session) => session.sourceSession.sourceSessionId),
      );
      events.sort(compareThreadEvents);
      return projectThreadState(workThreadFromRow(thread), sessions, events);
    });
  }

  async listProjectSourceSessions(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<SourceSessionList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const rows = await tx
        .select()
        .from(sourceSessions)
        .where(
          and(
            eq(sourceSessions.tenantId, context.principal.tenantId),
            eq(sourceSessions.projectId, projectId),
          ),
        )
        .orderBy(desc(sourceSessions.updatedAt))
        .limit(maxSessionsPerProject);
      const events = await this.eventsForSessions(
        tx,
        context.principal.tenantId,
        rows.map((row) => row.sourceSessionId),
      );
      const eventsBySession = groupBySession(events);
      return {
        sourceSessions: rows.map((row) =>
          deriveSourceSession(
            {
              sourceSessionId: row.sourceSessionId,
              projectId: row.projectId,
              sourceAgent: row.agent,
              nativeSessionHash: row.nativeSessionHash,
            },
            eventsBySession.get(row.sourceSessionId) ?? [],
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
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const threadRows = await tx
        .select()
        .from(workThreads)
        .where(
          and(
            eq(workThreads.tenantId, context.principal.tenantId),
            eq(workThreads.projectId, projectId),
          ),
        )
        .orderBy(desc(workThreads.updatedAt))
        .limit(maxSuggestionThreads);

      let candidate: CandidateSession | null = null;
      if (sourceSessionId !== null) {
        const [session] = await tx
          .select()
          .from(sourceSessions)
          .where(
            and(
              eq(sourceSessions.tenantId, context.principal.tenantId),
              eq(sourceSessions.sourceSessionId, sourceSessionId),
              eq(sourceSessions.projectId, projectId),
            ),
          )
          .limit(1);
        if (session === undefined) notFound('source session');
        candidate = {
          sourceSessionId,
          events: await this.eventsForSessions(tx, context.principal.tenantId, [
            sourceSessionId,
          ]),
        };
      }

      const activeThreadCount = threadRows.filter(
        (row) => row.state === 'active',
      ).length;
      const suggestions: ThreadSuggestion[] = [];
      for (const row of threadRows) {
        const links = await tx
          .select({ sourceSessionId: workThreadSessions.sourceSessionId })
          .from(workThreadSessions)
          .where(
            and(
              eq(workThreadSessions.tenantId, context.principal.tenantId),
              eq(workThreadSessions.workThreadId, row.workThreadId),
            ),
          );
        const assignedSourceSessionIds = new Set(
          links.map((link) => link.sourceSessionId),
        );
        const events = await this.eventsForSessions(
          tx,
          context.principal.tenantId,
          [...assignedSourceSessionIds],
        );
        events.sort(compareThreadEvents);
        const scoring: ThreadScoringInput = {
          workThread: workThreadFromRow(row),
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

  private async threadSessions(
    tx: Transaction,
    tenantId: string,
    workThreadId: string,
  ): Promise<WorkThreadSession[]> {
    const rows = await tx
      .select({
        sourceSessionId: workThreadSessions.sourceSessionId,
        position: workThreadSessions.position,
        assignment: workThreadSessions.assignment,
        assignedAt: workThreadSessions.assignedAt,
        projectId: sourceSessions.projectId,
        agent: sourceSessions.agent,
        nativeSessionHash: sourceSessions.nativeSessionHash,
      })
      .from(workThreadSessions)
      .innerJoin(
        sourceSessions,
        and(
          eq(sourceSessions.tenantId, workThreadSessions.tenantId),
          eq(
            sourceSessions.sourceSessionId,
            workThreadSessions.sourceSessionId,
          ),
        ),
      )
      .where(
        and(
          eq(workThreadSessions.tenantId, tenantId),
          eq(workThreadSessions.workThreadId, workThreadId),
        ),
      )
      .orderBy(asc(workThreadSessions.position));
    const events = await this.eventsForSessions(
      tx,
      tenantId,
      rows.map((row) => row.sourceSessionId),
    );
    const eventsBySession = groupBySession(events);
    return rows.map((row) => ({
      workThreadId,
      sourceSession: deriveSourceSession(
        {
          sourceSessionId: row.sourceSessionId,
          projectId: row.projectId,
          sourceAgent: row.agent,
          nativeSessionHash: row.nativeSessionHash,
        },
        eventsBySession.get(row.sourceSessionId) ?? [],
      ),
      position: row.position,
      assignment: row.assignment,
      assignedAt: row.assignedAt.toISOString(),
    }));
  }

  private async eventsForSessions(
    tx: Transaction,
    tenantId: string,
    sourceSessionIds: string[],
  ): Promise<SourceEvent[]> {
    if (sourceSessionIds.length === 0) return [];
    const rows = await tx
      .select()
      .from(sourceEvents)
      .where(
        and(
          eq(sourceEvents.tenantId, tenantId),
          inArray(sourceEvents.sourceSessionId, sourceSessionIds),
        ),
      );
    return rows.map(sourceEventFromRow);
  }
}

function groupBySession(events: SourceEvent[]): Map<string, SourceEvent[]> {
  const grouped = new Map<string, SourceEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.sourceSessionId) ?? [];
    list.push(event);
    grouped.set(event.sourceSessionId, list);
  }
  return grouped;
}

async function requireProject(
  tx: Transaction,
  tenantId: string,
  projectId: string,
): Promise<typeof projects.$inferSelect> {
  const [row] = await tx
    .select()
    .from(projects)
    .where(
      and(eq(projects.tenantId, tenantId), eq(projects.projectId, projectId)),
    )
    .limit(1);
  if (row === undefined) notFound('project');
  return row;
}

async function requireThread(
  tx: Transaction,
  tenantId: string,
  workThreadId: string,
): Promise<typeof workThreads.$inferSelect> {
  const [row] = await tx
    .select()
    .from(workThreads)
    .where(
      and(
        eq(workThreads.tenantId, tenantId),
        eq(workThreads.workThreadId, workThreadId),
      ),
    )
    .limit(1)
    .for('update');
  if (row === undefined) notFound('work thread');
  return row;
}

function workThreadFromRow(row: typeof workThreads.$inferSelect): WorkThread {
  return {
    workThreadId: row.workThreadId,
    projectId: row.projectId,
    title: row.title,
    goal: row.goal,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sourceEventFromRow(
  row: typeof sourceEvents.$inferSelect,
): SourceEvent {
  return {
    eventId: row.eventId,
    idempotencyKey: row.idempotencyKey,
    contentHash: row.contentHash,
    sourceSessionId: row.sourceSessionId,
    workThreadId: row.workThreadId,
    sourceAgent: row.sourceAgent,
    sourceDeviceId: row.sourceDeviceId,
    nativeSequence: row.nativeSequence,
    parentEventId: row.parentEventId,
    occurredAt: row.occurredAt.toISOString(),
    observedAt: row.observedAt.toISOString(),
    schemaVersion: row.schemaVersion as SourceEvent['schemaVersion'],
    payload: row.payload,
  };
}

async function appendAudit(
  tx: Transaction,
  context: IngestionRequestContext,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, string | number | boolean | null>,
  occurredAt: Date,
): Promise<void> {
  await tx.insert(auditEvents).values({
    auditEventId: randomUUID(),
    tenantId: context.principal.tenantId,
    actorUserId: context.principal.userId,
    actorDeviceId: context.principal.deviceId,
    action,
    targetType,
    targetId,
    requestId: context.requestId,
    metadata,
    occurredAt,
  });
}

async function setTenant(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}

function notFound(label: string): never {
  throw new IngestionStoreError(
    'not_found',
    404,
    `The ${label} was not found.`,
  );
}
