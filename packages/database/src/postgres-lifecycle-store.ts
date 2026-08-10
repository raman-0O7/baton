import type {
  DeletionReceipt,
  Memory,
  Project,
  SourceEvent,
  WorkThread,
} from '@baton/protocol';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import {
  mergeCounts,
  type ExportContent,
  type LifecycleStore,
} from './lifecycle-store.js';
import {
  artifacts,
  chunks,
  consentRecords,
  identitySchema,
  ingestionBatches,
  ingestionCheckpoints,
  memories as memoriesTable,
  memoryCandidates,
  projectInstallations,
  projects,
  sourceEvents,
  sourceSessions,
  workThreads,
  workThreadSessions,
} from './schema.js';

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresLifecycleStore implements LifecycleStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async exportContent(
    context: IngestionRequestContext,
    projectId: string | null,
  ): Promise<ExportContent> {
    const tenantId = context.principal.tenantId;
    return this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      const projectRows = await tx
        .select()
        .from(projects)
        .where(eq(projects.tenantId, tenantId));
      const projectList: Project[] = projectRows
        .filter((row) => projectId === null || row.projectId === projectId)
        .map((row) => ({
          projectId: row.projectId,
          displayName: row.displayName,
          state: row.state as Project['state'],
          collectionPolicy: row.collectionPolicy,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));

      const threadRows = await tx
        .select()
        .from(workThreads)
        .where(
          projectId === null
            ? eq(workThreads.tenantId, tenantId)
            : and(
                eq(workThreads.tenantId, tenantId),
                eq(workThreads.projectId, projectId),
              ),
        );
      const threadList: WorkThread[] = threadRows.map((row) => ({
        workThreadId: row.workThreadId,
        projectId: row.projectId,
        title: row.title,
        goal: row.goal,
        state: row.state,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));

      const eventRows = await tx
        .select()
        .from(sourceEvents)
        .where(
          projectId === null
            ? eq(sourceEvents.tenantId, tenantId)
            : and(
                eq(sourceEvents.tenantId, tenantId),
                eq(sourceEvents.projectId, projectId),
              ),
        );
      const eventList: SourceEvent[] = eventRows.map((row) => ({
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
      }));

      const memoryRows = await tx
        .select()
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.tenantId, tenantId),
            eq(memoriesTable.status, 'approved'),
          ),
        );
      const memoryList: Memory[] = memoryRows
        .filter(
          (row) =>
            projectId === null ||
            (row.scopeType === 'project' && row.scopeId === projectId),
        )
        .map((row) => ({
          memoryId: row.memoryId,
          category: row.category,
          claim: row.claim,
          scope: { type: row.scopeType, id: row.scopeId },
          confidence: Number((row.confidence / 1000).toFixed(4)),
          status: row.status,
          evidenceEventIds: row.evidenceEventIds,
          provenance: row.provenance,
          firstObservedAt: row.firstObservedAt.toISOString(),
          lastConfirmedAt: row.lastConfirmedAt.toISOString(),
          expiresAt: row.expiresAt?.toISOString() ?? null,
        }));

      return {
        projects: projectList,
        workThreads: threadList,
        memories: memoryList,
        events: eventList,
      };
    });
  }

  async deleteProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<DeletionReceipt> {
    const tenantId = context.principal.tenantId;
    return this.db.transaction(
      async (tx) => {
        await setTenant(tx, tenantId);
        const [project] = await tx
          .select({ id: projects.projectId })
          .from(projects)
          .where(
            and(
              eq(projects.tenantId, tenantId),
              eq(projects.projectId, projectId),
            ),
          )
          .limit(1);
        if (project === undefined) {
          throw new IngestionStoreError(
            'not_found',
            404,
            'The project was not found.',
          );
        }
        const threadIds = (
          await tx
            .select({ id: workThreads.workThreadId })
            .from(workThreads)
            .where(
              and(
                eq(workThreads.tenantId, tenantId),
                eq(workThreads.projectId, projectId),
              ),
            )
        ).map((row) => row.id);
        const counts = mergeCounts(
          {
            chunks: await del(
              tx,
              chunks,
              and(
                eq(chunks.tenantId, tenantId),
                eq(chunks.projectId, projectId),
              ),
            ),
          },
          {
            work_thread_sessions:
              threadIds.length === 0
                ? 0
                : await del(
                    tx,
                    workThreadSessions,
                    and(
                      eq(workThreadSessions.tenantId, tenantId),
                      inArray(workThreadSessions.workThreadId, threadIds),
                    ),
                  ),
          },
          {
            work_threads: await del(
              tx,
              workThreads,
              and(
                eq(workThreads.tenantId, tenantId),
                eq(workThreads.projectId, projectId),
              ),
            ),
          },
          {
            source_events: await del(
              tx,
              sourceEvents,
              and(
                eq(sourceEvents.tenantId, tenantId),
                eq(sourceEvents.projectId, projectId),
              ),
            ),
          },
          {
            source_sessions: await del(
              tx,
              sourceSessions,
              and(
                eq(sourceSessions.tenantId, tenantId),
                eq(sourceSessions.projectId, projectId),
              ),
            ),
          },
          {
            ingestion_checkpoints: await del(
              tx,
              ingestionCheckpoints,
              and(
                eq(ingestionCheckpoints.tenantId, tenantId),
                eq(ingestionCheckpoints.projectId, projectId),
              ),
            ),
          },
          {
            ingestion_batches: await del(
              tx,
              ingestionBatches,
              and(
                eq(ingestionBatches.tenantId, tenantId),
                eq(ingestionBatches.projectId, projectId),
              ),
            ),
          },
          {
            consent_records: await del(
              tx,
              consentRecords,
              and(
                eq(consentRecords.tenantId, tenantId),
                eq(consentRecords.projectId, projectId),
              ),
            ),
          },
          {
            project_installations: await del(
              tx,
              projectInstallations,
              and(
                eq(projectInstallations.tenantId, tenantId),
                eq(projectInstallations.projectId, projectId),
              ),
            ),
          },
          {
            artifacts: await del(
              tx,
              artifacts,
              and(
                eq(artifacts.tenantId, tenantId),
                eq(artifacts.projectId, projectId),
              ),
            ),
          },
          {
            memories: await del(
              tx,
              memoriesTable,
              and(
                eq(memoriesTable.tenantId, tenantId),
                eq(memoriesTable.scopeType, 'project'),
                eq(memoriesTable.scopeId, projectId),
              ),
            ),
          },
          {
            memory_candidates: await del(
              tx,
              memoryCandidates,
              and(
                eq(memoryCandidates.tenantId, tenantId),
                eq(memoryCandidates.scopeType, 'project'),
                eq(memoryCandidates.scopeId, projectId),
              ),
            ),
          },
          {
            projects: await del(
              tx,
              projects,
              and(
                eq(projects.tenantId, tenantId),
                eq(projects.projectId, projectId),
              ),
            ),
          },
        );
        return this.receipt('project', projectId, counts);
      },
      { isolationLevel: 'serializable' },
    );
  }

  async deleteAccount(
    context: IngestionRequestContext,
  ): Promise<DeletionReceipt> {
    const tenantId = context.principal.tenantId;
    return this.db.transaction(
      async (tx) => {
        await setTenant(tx, tenantId);
        const counts = mergeCounts(
          { chunks: await del(tx, chunks, eq(chunks.tenantId, tenantId)) },
          {
            work_thread_sessions: await del(
              tx,
              workThreadSessions,
              eq(workThreadSessions.tenantId, tenantId),
            ),
          },
          {
            work_threads: await del(
              tx,
              workThreads,
              eq(workThreads.tenantId, tenantId),
            ),
          },
          {
            source_events: await del(
              tx,
              sourceEvents,
              eq(sourceEvents.tenantId, tenantId),
            ),
          },
          {
            source_sessions: await del(
              tx,
              sourceSessions,
              eq(sourceSessions.tenantId, tenantId),
            ),
          },
          {
            ingestion_checkpoints: await del(
              tx,
              ingestionCheckpoints,
              eq(ingestionCheckpoints.tenantId, tenantId),
            ),
          },
          {
            ingestion_batches: await del(
              tx,
              ingestionBatches,
              eq(ingestionBatches.tenantId, tenantId),
            ),
          },
          {
            consent_records: await del(
              tx,
              consentRecords,
              eq(consentRecords.tenantId, tenantId),
            ),
          },
          {
            project_installations: await del(
              tx,
              projectInstallations,
              eq(projectInstallations.tenantId, tenantId),
            ),
          },
          {
            artifacts: await del(
              tx,
              artifacts,
              eq(artifacts.tenantId, tenantId),
            ),
          },
          {
            memories: await del(
              tx,
              memoriesTable,
              eq(memoriesTable.tenantId, tenantId),
            ),
          },
          {
            memory_candidates: await del(
              tx,
              memoryCandidates,
              eq(memoryCandidates.tenantId, tenantId),
            ),
          },
          {
            projects: await del(tx, projects, eq(projects.tenantId, tenantId)),
          },
        );
        return this.receipt('account', null, counts);
      },
      { isolationLevel: 'serializable' },
    );
  }

  private receipt(
    scope: 'project' | 'account',
    targetId: string | null,
    deletedCounts: Record<string, number>,
  ): DeletionReceipt {
    return {
      scope,
      targetId,
      deletedAt: new Date(this.now()).toISOString(),
      deletedCounts,
      complete: true,
    };
  }
}

async function del(
  tx: Transaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  where: ReturnType<typeof eq> | ReturnType<typeof and>,
): Promise<number> {
  const deleted = await tx
    .delete(table)
    .where(where)
    .returning({
      marker: sql<number>`1`,
    });
  return deleted.length;
}

async function setTenant(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}
