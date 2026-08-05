import { randomUUID } from 'node:crypto';

import type { AuthPrincipal } from '@baton/auth';
import {
  canonicalJsonSha256,
  type CollectionPolicy,
  type ConsentList,
  type ConsentRecord,
  type CreateConsentRequest,
  type CreateProjectRequest,
  type IngestionAcknowledgement,
  type IngestionBatch,
  type IngestionCheckpoint,
  type IngestionCheckpointQuery,
  type Project,
  type ProjectList,
  type SourceEvent,
  type UpdateProjectRequest,
} from '@baton/protocol';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { validateEventCollectionPolicy } from './ingestion-policy.js';
import {
  IngestionStoreError,
  requireCurrentDisclosure,
  requireDevicePrincipal,
  type IngestionRequestContext,
  type IngestionStore,
} from './ingestion-store.js';
import {
  auditEvents,
  consentRecords,
  identitySchema,
  ingestionBatches,
  ingestionCheckpoints,
  projectInstallations,
  projects,
  sourceEvents,
  sourceSessions,
} from './schema.js';

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export class PostgresIngestionStore implements IngestionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  async listProjects(context: IngestionRequestContext): Promise<ProjectList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const rows = await tx
        .select()
        .from(projects)
        .where(eq(projects.tenantId, context.principal.tenantId))
        .orderBy(desc(projects.updatedAt));
      return { projects: rows.map(projectFromRow) };
    });
  }

  async createProject(
    context: IngestionRequestContext,
    input: CreateProjectRequest,
  ): Promise<Project> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const now = new Date(this.now());
      const [row] = await tx
        .insert(projects)
        .values({
          tenantId: context.principal.tenantId,
          projectId: randomUUID(),
          createdByUserId: context.principal.userId,
          displayName: input.displayName,
          state: 'enabled',
          collectionPolicy: input.collectionPolicy,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await appendAudit(
        tx,
        context,
        'project.created',
        'project',
        row!.projectId,
        {
          projectId: row!.projectId,
          policyVersion: input.collectionPolicy.policyVersion,
        },
        now,
      );
      return projectFromRow(row!);
    });
  }

  async updateProject(
    context: IngestionRequestContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      const now = new Date(this.now());
      const [row] = await tx
        .update(projects)
        .set({ ...input, updatedAt: now })
        .where(
          and(
            eq(projects.tenantId, context.principal.tenantId),
            eq(projects.projectId, projectId),
          ),
        )
        .returning();
      if (row === undefined) notFound('project');
      await appendAudit(
        tx,
        context,
        'project.updated',
        'project',
        projectId,
        {
          projectId,
          state: row.state,
          policyVersion: row.collectionPolicy.policyVersion,
        },
        now,
      );
      return projectFromRow(row);
    });
  }

  async recordConsent(
    context: IngestionRequestContext,
    projectId: string,
    input: CreateConsentRequest,
  ): Promise<ConsentRecord> {
    const deviceId = requireDevicePrincipal(context);
    requireCurrentDisclosure(input);
    return retrySerializable(() =>
      this.db.transaction(
        async (tx) => {
          await setTenant(tx, context.principal.tenantId);
          const project = await requireProject(
            tx,
            context.principal.tenantId,
            projectId,
          );
          if (!samePolicy(project.collectionPolicy, input.collectionPolicy)) {
            throw new IngestionStoreError(
              'conflict',
              409,
              'The project collection policy changed before consent was recorded.',
            );
          }
          const now = new Date(this.now());
          const [installation] = await tx
            .select()
            .from(projectInstallations)
            .where(
              and(
                eq(projectInstallations.tenantId, context.principal.tenantId),
                eq(
                  projectInstallations.projectInstallationId,
                  input.projectInstallationId,
                ),
              ),
            )
            .limit(1)
            .for('update');
          if (
            installation !== undefined &&
            (installation.projectId !== projectId ||
              installation.userId !== context.principal.userId ||
              installation.deviceId !== deviceId)
          ) {
            throw new IngestionStoreError(
              'conflict',
              409,
              'The project installation ID is already bound to another installation.',
            );
          }
          if (installation === undefined) {
            await tx.insert(projectInstallations).values({
              tenantId: context.principal.tenantId,
              projectInstallationId: input.projectInstallationId,
              projectId,
              userId: context.principal.userId,
              deviceId,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            await tx
              .update(projectInstallations)
              .set({ updatedAt: now })
              .where(
                and(
                  eq(projectInstallations.tenantId, context.principal.tenantId),
                  eq(
                    projectInstallations.projectInstallationId,
                    input.projectInstallationId,
                  ),
                ),
              );
          }
          await tx
            .update(consentRecords)
            .set({ revokedAt: now })
            .where(
              and(
                eq(consentRecords.tenantId, context.principal.tenantId),
                eq(
                  consentRecords.projectInstallationId,
                  input.projectInstallationId,
                ),
                isNull(consentRecords.revokedAt),
              ),
            );
          const [row] = await tx
            .insert(consentRecords)
            .values({
              tenantId: context.principal.tenantId,
              consentRecordId: randomUUID(),
              projectId,
              projectInstallationId: input.projectInstallationId,
              userId: context.principal.userId,
              deviceId,
              disclosureVersion: input.disclosureVersion,
              disclosureDigest: input.disclosureDigest,
              collectionPolicy: input.collectionPolicy,
              cloudProcessingAcknowledged: true,
              modelProcessingAcknowledged: true,
              captureSurface: input.captureSurface,
              historicalImport: input.historicalImport,
              capturedAt: now,
              effectiveAt: now,
              revokedAt: null,
            })
            .returning();
          await appendAudit(
            tx,
            context,
            'project.consent.recorded',
            'consent_record',
            row!.consentRecordId,
            {
              projectId,
              consentRecordId: row!.consentRecordId,
              projectInstallationId: input.projectInstallationId,
              disclosureVersion: input.disclosureVersion,
              policyVersion: input.collectionPolicy.policyVersion,
              historicalImport: input.historicalImport,
            },
            now,
          );
          return consentFromRow(row!);
        },
        { isolationLevel: 'serializable' },
      ),
    );
  }

  async listConsents(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<ConsentList> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const rows = await tx
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.tenantId, context.principal.tenantId),
            eq(consentRecords.projectId, projectId),
          ),
        )
        .orderBy(desc(consentRecords.capturedAt));
      return { consents: rows.map(consentFromRow) };
    });
  }

  async revokeConsent(
    context: IngestionRequestContext,
    projectId: string,
    consentRecordId: string,
  ): Promise<void> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, projectId);
      const [existing] = await tx
        .select()
        .from(consentRecords)
        .where(
          and(
            eq(consentRecords.tenantId, context.principal.tenantId),
            eq(consentRecords.projectId, projectId),
            eq(consentRecords.consentRecordId, consentRecordId),
          ),
        )
        .limit(1)
        .for('update');
      if (existing === undefined) notFound('consent');
      if (existing.revokedAt !== null) return;
      const now = new Date(this.now());
      await tx
        .update(consentRecords)
        .set({ revokedAt: now })
        .where(
          and(
            eq(consentRecords.tenantId, context.principal.tenantId),
            eq(consentRecords.projectId, projectId),
            eq(consentRecords.consentRecordId, consentRecordId),
          ),
        );
      await appendAudit(
        tx,
        context,
        'project.consent.revoked',
        'consent_record',
        consentRecordId,
        {
          projectId,
          consentRecordId,
          projectInstallationId: existing.projectInstallationId,
        },
        now,
      );
    });
  }

  async ingestBatch(
    context: IngestionRequestContext,
    batch: IngestionBatch,
  ): Promise<IngestionAcknowledgement> {
    const deviceId = requireDevicePrincipal(context);
    if (batch.deviceId !== deviceId) {
      throw new IngestionStoreError(
        'invalid_request',
        400,
        'The batch device does not match the authenticated device.',
      );
    }
    const digest = canonicalJsonSha256(batch);
    return retrySerializable(() =>
      this.db.transaction(
        async (tx) => {
          await setTenant(tx, context.principal.tenantId);
          const [replay] = await tx
            .select()
            .from(ingestionBatches)
            .where(
              and(
                eq(ingestionBatches.tenantId, context.principal.tenantId),
                eq(ingestionBatches.batchId, batch.batchId),
              ),
            )
            .limit(1)
            .for('update');
          if (replay !== undefined) {
            if (replay.requestDigest !== digest) {
              throw new IngestionStoreError(
                'conflict',
                409,
                'The batch ID was already used for different normalized events.',
              );
            }
            return replay.acknowledgement;
          }

          const project = await requireProject(
            tx,
            context.principal.tenantId,
            batch.projectId,
          );
          if (project.state !== 'enabled') {
            throw new IngestionStoreError(
              'project_disabled',
              403,
              'The project is not enabled for ingestion.',
            );
          }
          const [installation] = await tx
            .select()
            .from(projectInstallations)
            .where(
              and(
                eq(projectInstallations.tenantId, context.principal.tenantId),
                eq(projectInstallations.projectId, batch.projectId),
                eq(
                  projectInstallations.projectInstallationId,
                  batch.projectInstallationId,
                ),
                eq(projectInstallations.userId, context.principal.userId),
                eq(projectInstallations.deviceId, deviceId),
              ),
            )
            .limit(1);
          const [consent] = await tx
            .select()
            .from(consentRecords)
            .where(
              and(
                eq(consentRecords.tenantId, context.principal.tenantId),
                eq(consentRecords.consentRecordId, batch.consentRecordId),
                eq(consentRecords.projectId, batch.projectId),
                eq(
                  consentRecords.projectInstallationId,
                  batch.projectInstallationId,
                ),
                eq(consentRecords.userId, context.principal.userId),
                eq(consentRecords.deviceId, deviceId),
                isNull(consentRecords.revokedAt),
              ),
            )
            .limit(1);
          if (
            installation === undefined ||
            consent === undefined ||
            consent.collectionPolicy.policyVersion !== batch.policyVersion ||
            consent.disclosureVersion !== batch.disclosureVersion ||
            !samePolicy(consent.collectionPolicy, project.collectionPolicy)
          ) {
            throw consentRequired();
          }
          for (const event of batch.events) {
            validateEventCollectionPolicy(event, consent.collectionPolicy);
          }

          const [checkpoint] = await tx
            .select()
            .from(ingestionCheckpoints)
            .where(
              checkpointWhere(
                context.principal.tenantId,
                deviceId,
                batch.projectInstallationId,
                batch.source.sourceSessionId,
              ),
            )
            .limit(1)
            .for('update');
          if (
            (checkpoint?.acknowledgedCursor ?? null) !== batch.previousCursor ||
            (checkpoint?.headEventId ?? null) !== batch.expectedHeadEventId
          ) {
            throw checkpointDiverged();
          }

          const [source] = await tx
            .select()
            .from(sourceSessions)
            .where(
              and(
                eq(sourceSessions.tenantId, context.principal.tenantId),
                eq(
                  sourceSessions.sourceSessionId,
                  batch.source.sourceSessionId,
                ),
              ),
            )
            .limit(1)
            .for('update');
          if (
            source !== undefined &&
            (source.projectId !== batch.projectId ||
              source.agent !== batch.source.agent ||
              source.nativeSessionHash !== batch.source.nativeSessionHash)
          ) {
            throw checkpointDiverged();
          }
          const now = new Date(this.now());
          if (source === undefined) {
            await tx.insert(sourceSessions).values({
              tenantId: context.principal.tenantId,
              sourceSessionId: batch.source.sourceSessionId,
              projectId: batch.projectId,
              agent: batch.source.agent,
              nativeSessionHash: batch.source.nativeSessionHash,
              parserVersion: batch.source.parserVersion,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            await tx
              .update(sourceSessions)
              .set({
                parserVersion: batch.source.parserVersion,
                updatedAt: now,
              })
              .where(
                and(
                  eq(sourceSessions.tenantId, context.principal.tenantId),
                  eq(
                    sourceSessions.sourceSessionId,
                    batch.source.sourceSessionId,
                  ),
                ),
              );
          }

          const ids = batch.events.map((event) => event.eventId);
          const keys = batch.events.map((event) => event.idempotencyKey);
          const existing = await tx
            .select({
              eventId: sourceEvents.eventId,
              idempotencyKey: sourceEvents.idempotencyKey,
              contentHash: sourceEvents.contentHash,
              parentEventId: sourceEvents.parentEventId,
              nativeSequence: sourceEvents.nativeSequence,
              occurredAt: sourceEvents.occurredAt,
            })
            .from(sourceEvents)
            .where(
              and(
                eq(sourceEvents.tenantId, context.principal.tenantId),
                or(
                  inArray(sourceEvents.eventId, ids),
                  inArray(sourceEvents.idempotencyKey, keys),
                ),
              ),
            );
          const existingById = new Map(
            existing.map((event) => [event.eventId, event]),
          );
          const existingByKey = new Map(
            existing.map((event) => [event.idempotencyKey, event]),
          );
          const accepted: SourceEvent[] = [];
          const duplicateEventIds: string[] = [];
          for (const event of batch.events) {
            const duplicate =
              existingById.get(event.eventId) ??
              existingByKey.get(event.idempotencyKey);
            if (duplicate !== undefined) {
              if (
                duplicate.eventId !== event.eventId ||
                duplicate.idempotencyKey !== event.idempotencyKey ||
                duplicate.contentHash !== event.contentHash
              ) {
                throw checkpointDiverged();
              }
              duplicateEventIds.push(event.eventId);
            } else {
              accepted.push(event);
            }
          }
          if (accepted.length > 0) {
            await tx.insert(sourceEvents).values(
              accepted.map((event) => ({
                tenantId: context.principal.tenantId,
                projectId: batch.projectId,
                eventId: event.eventId,
                sourceSessionId: event.sourceSessionId,
                workThreadId: event.workThreadId,
                sourceAgent: event.sourceAgent,
                sourceDeviceId: event.sourceDeviceId,
                nativeSequence: event.nativeSequence,
                parentEventId: event.parentEventId,
                occurredAt: new Date(event.occurredAt),
                observedAt: new Date(event.observedAt),
                contentHash: event.contentHash,
                idempotencyKey: event.idempotencyKey,
                schemaVersion: event.schemaVersion,
                payload: event.payload,
                ingestedAt: now,
              })),
            );
          }

          const branchCreated = await detectsBranch(
            tx,
            context.principal.tenantId,
            batch.source.sourceSessionId,
            batch.events,
          );
          const currentHead =
            checkpoint?.headEventId === null ||
            checkpoint?.headEventId === undefined
              ? null
              : await findEventOrder(
                  tx,
                  context.principal.tenantId,
                  checkpoint.headEventId,
                );
          const headEventId = chooseHead(currentHead, batch.events);
          await tx
            .insert(ingestionCheckpoints)
            .values({
              tenantId: context.principal.tenantId,
              deviceId,
              projectId: batch.projectId,
              projectInstallationId: batch.projectInstallationId,
              sourceSessionId: batch.source.sourceSessionId,
              acknowledgedCursor: batch.proposedCursor,
              headEventId,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                ingestionCheckpoints.tenantId,
                ingestionCheckpoints.deviceId,
                ingestionCheckpoints.projectInstallationId,
                ingestionCheckpoints.sourceSessionId,
              ],
              set: {
                acknowledgedCursor: batch.proposedCursor,
                headEventId,
                updatedAt: now,
              },
            });
          const acknowledgement: IngestionAcknowledgement = {
            batchId: batch.batchId,
            acceptedEventIds: accepted.map((event) => event.eventId),
            duplicateEventIds,
            headEventId,
            acknowledgedCursor: batch.proposedCursor,
            branchCreated,
          };
          await tx.insert(ingestionBatches).values({
            tenantId: context.principal.tenantId,
            batchId: batch.batchId,
            requestDigest: digest,
            projectId: batch.projectId,
            projectInstallationId: batch.projectInstallationId,
            consentRecordId: batch.consentRecordId,
            userId: context.principal.userId,
            deviceId,
            sourceSessionId: batch.source.sourceSessionId,
            acknowledgement,
            createdAt: now,
          });
          await appendAudit(
            tx,
            context,
            'ingestion.batch.accepted',
            'ingestion_batch',
            batch.batchId,
            {
              batchId: batch.batchId,
              projectId: batch.projectId,
              projectInstallationId: batch.projectInstallationId,
              sourceSessionId: batch.source.sourceSessionId,
              acceptedEventCount: accepted.length,
              duplicateEventCount: duplicateEventIds.length,
              branchCreated,
            },
            now,
          );
          return acknowledgement;
        },
        { isolationLevel: 'serializable' },
      ),
    );
  }

  async getCheckpoint(
    context: IngestionRequestContext,
    query: IngestionCheckpointQuery,
  ): Promise<IngestionCheckpoint | null> {
    const deviceId = requireDevicePrincipal(context);
    return this.db.transaction(async (tx) => {
      await setTenant(tx, context.principal.tenantId);
      await requireProject(tx, context.principal.tenantId, query.projectId);
      const [installation] = await tx
        .select({ id: projectInstallations.projectInstallationId })
        .from(projectInstallations)
        .where(
          and(
            eq(projectInstallations.tenantId, context.principal.tenantId),
            eq(projectInstallations.projectId, query.projectId),
            eq(
              projectInstallations.projectInstallationId,
              query.projectInstallationId,
            ),
            eq(projectInstallations.userId, context.principal.userId),
            eq(projectInstallations.deviceId, deviceId),
          ),
        )
        .limit(1);
      if (installation === undefined) notFound('ingestion checkpoint');
      const [row] = await tx
        .select()
        .from(ingestionCheckpoints)
        .where(
          checkpointWhere(
            context.principal.tenantId,
            deviceId,
            query.projectInstallationId,
            query.sourceSessionId,
          ),
        )
        .limit(1);
      return row === undefined ? null : checkpointFromRow(row);
    });
  }
}

async function requireProject(
  tx: Transaction,
  tenantId: string,
  projectId: string,
) {
  const [row] = await tx
    .select()
    .from(projects)
    .where(
      and(eq(projects.tenantId, tenantId), eq(projects.projectId, projectId)),
    )
    .limit(1)
    .for('update');
  if (row === undefined) notFound('project');
  return row;
}

function checkpointWhere(
  tenantId: string,
  deviceId: string,
  projectInstallationId: string,
  sourceSessionId: string,
) {
  return and(
    eq(ingestionCheckpoints.tenantId, tenantId),
    eq(ingestionCheckpoints.deviceId, deviceId),
    eq(ingestionCheckpoints.projectInstallationId, projectInstallationId),
    eq(ingestionCheckpoints.sourceSessionId, sourceSessionId),
  );
}

async function detectsBranch(
  tx: Transaction,
  tenantId: string,
  sourceSessionId: string,
  incoming: readonly SourceEvent[],
): Promise<boolean> {
  const parentIds = [
    ...new Set(
      incoming
        .map((event) => event.parentEventId)
        .filter((value): value is string => value !== null),
    ),
  ];
  if (parentIds.length === 0) return false;
  const stored = await tx
    .select({
      eventId: sourceEvents.eventId,
      parentEventId: sourceEvents.parentEventId,
    })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.tenantId, tenantId),
        eq(sourceEvents.sourceSessionId, sourceSessionId),
        inArray(sourceEvents.parentEventId, parentIds),
      ),
    );
  const children = new Map<string, Set<string>>();
  for (const event of [...stored, ...incoming]) {
    if (event.parentEventId === null) continue;
    const set = children.get(event.parentEventId) ?? new Set<string>();
    set.add(event.eventId);
    children.set(event.parentEventId, set);
  }
  return [...children.values()].some((set) => set.size > 1);
}

interface EventOrder {
  eventId: string;
  nativeSequence: number | null;
  occurredAt: Date;
}

async function findEventOrder(
  tx: Transaction,
  tenantId: string,
  eventId: string,
): Promise<EventOrder | null> {
  const [row] = await tx
    .select({
      eventId: sourceEvents.eventId,
      nativeSequence: sourceEvents.nativeSequence,
      occurredAt: sourceEvents.occurredAt,
    })
    .from(sourceEvents)
    .where(
      and(
        eq(sourceEvents.tenantId, tenantId),
        eq(sourceEvents.eventId, eventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

function chooseHead(
  current: EventOrder | null,
  incoming: readonly SourceEvent[],
): string | null {
  let head = current;
  for (const event of incoming) {
    const candidate: EventOrder = {
      eventId: event.eventId,
      nativeSequence: event.nativeSequence,
      occurredAt: new Date(event.occurredAt),
    };
    if (head === null || compareEventOrder(candidate, head) > 0)
      head = candidate;
  }
  return head?.eventId ?? null;
}

function compareEventOrder(left: EventOrder, right: EventOrder): number {
  if (left.nativeSequence !== null && right.nativeSequence !== null) {
    const sequence = left.nativeSequence - right.nativeSequence;
    if (sequence !== 0) return sequence;
  }
  const occurred = left.occurredAt.getTime() - right.occurredAt.getTime();
  return occurred === 0 ? left.eventId.localeCompare(right.eventId) : occurred;
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

function projectFromRow(row: typeof projects.$inferSelect): Project {
  return {
    projectId: row.projectId,
    displayName: row.displayName,
    state: row.state as Project['state'],
    collectionPolicy: row.collectionPolicy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function consentFromRow(
  row: typeof consentRecords.$inferSelect,
): ConsentRecord {
  return {
    consentRecordId: row.consentRecordId,
    projectId: row.projectId,
    projectInstallationId: row.projectInstallationId,
    deviceId: row.deviceId,
    disclosureVersion: row.disclosureVersion,
    disclosureDigest: row.disclosureDigest,
    collectionPolicy: row.collectionPolicy,
    cloudProcessingAcknowledged: true,
    modelProcessingAcknowledged: true,
    captureSurface: row.captureSurface as ConsentRecord['captureSurface'],
    historicalImport: row.historicalImport,
    capturedAt: row.capturedAt.toISOString(),
    effectiveAt: row.effectiveAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function checkpointFromRow(
  row: typeof ingestionCheckpoints.$inferSelect,
): IngestionCheckpoint {
  return {
    projectId: row.projectId,
    projectInstallationId: row.projectInstallationId,
    sourceSessionId: row.sourceSessionId,
    deviceId: row.deviceId,
    acknowledgedCursor: row.acknowledgedCursor,
    headEventId: row.headEventId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function samePolicy(left: CollectionPolicy, right: CollectionPolicy): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function consentRequired(): IngestionStoreError {
  return new IngestionStoreError(
    'consent_required',
    403,
    'Active consent for this exact project installation is required.',
  );
}

function checkpointDiverged(): IngestionStoreError {
  return new IngestionStoreError(
    'checkpoint_diverged',
    409,
    'The source checkpoint has diverged; reconcile before retrying.',
  );
}

function notFound(label: string): never {
  throw new IngestionStoreError(
    'not_found',
    404,
    `The ${label} was not found.`,
  );
}

async function retrySerializable<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 1 || !isSerializationFailure(error)) throw error;
    }
  }
}

function isSerializationFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === '40001' || error.code === '40P01')
  );
}
