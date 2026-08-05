import { randomUUID } from 'node:crypto';

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

import { validateEventCollectionPolicy } from './ingestion-policy.js';
import {
  IngestionStoreError,
  requireCurrentDisclosure,
  requireDevicePrincipal,
  type IngestionRequestContext,
  type IngestionStore,
} from './ingestion-store.js';

interface StoredProject extends Project {
  tenantId: string;
  createdByUserId: string;
}

interface StoredConsent extends ConsentRecord {
  tenantId: string;
  userId: string;
}

interface StoredInstallation {
  tenantId: string;
  projectInstallationId: string;
  projectId: string;
  userId: string;
  deviceId: string;
}

export interface StoredSourceSession {
  tenantId: string;
  projectId: string;
  sourceSessionId: string;
  agent: string;
  nativeSessionHash: string;
  parserVersion: string;
}

interface StoredBatch {
  digest: string;
  acknowledgement: IngestionAcknowledgement;
}

interface StoredAudit {
  tenantId: string;
  action: string;
  metadata: Record<string, string | number | boolean | null>;
}

export class InMemoryIngestionStore implements IngestionStore {
  private readonly projects = new Map<string, StoredProject>();
  private readonly installations = new Map<string, StoredInstallation>();
  private readonly consents = new Map<string, StoredConsent>();
  private readonly sourceSessions = new Map<string, StoredSourceSession>();
  private readonly eventsById = new Map<string, SourceEvent>();
  private readonly eventIdByIdempotency = new Map<string, string>();
  private readonly batches = new Map<string, StoredBatch>();
  private readonly checkpoints = new Map<string, IngestionCheckpoint>();
  private readonly audits: StoredAudit[] = [];
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  async listProjects(context: IngestionRequestContext): Promise<ProjectList> {
    return this.exclusive(() => ({
      projects: [...this.projects.values()]
        .filter((project) => project.tenantId === context.principal.tenantId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map(projectResponse),
    }));
  }

  async createProject(
    context: IngestionRequestContext,
    input: CreateProjectRequest,
  ): Promise<Project> {
    return this.exclusive(() => {
      const now = new Date(this.now()).toISOString();
      const stored: StoredProject = {
        tenantId: context.principal.tenantId,
        createdByUserId: context.principal.userId,
        projectId: randomUUID(),
        displayName: input.displayName,
        state: 'enabled',
        collectionPolicy: structuredClone(input.collectionPolicy),
        createdAt: now,
        updatedAt: now,
      };
      this.projects.set(projectKey(stored.tenantId, stored.projectId), stored);
      this.audit(context, 'project.created', {
        projectId: stored.projectId,
        policyVersion: stored.collectionPolicy.policyVersion,
      });
      return projectResponse(stored);
    });
  }

  async updateProject(
    context: IngestionRequestContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project> {
    return this.exclusive(() => {
      const project = this.requireProject(context, projectId);
      if (input.displayName !== undefined)
        project.displayName = input.displayName;
      if (input.state !== undefined) project.state = input.state;
      if (input.collectionPolicy !== undefined) {
        project.collectionPolicy = structuredClone(input.collectionPolicy);
      }
      project.updatedAt = new Date(this.now()).toISOString();
      this.audit(context, 'project.updated', {
        projectId,
        state: project.state,
        policyVersion: project.collectionPolicy.policyVersion,
      });
      return projectResponse(project);
    });
  }

  async recordConsent(
    context: IngestionRequestContext,
    projectId: string,
    input: CreateConsentRequest,
  ): Promise<ConsentRecord> {
    return this.exclusive(() => {
      const deviceId = requireDevicePrincipal(context);
      const project = this.requireProject(context, projectId);
      requireCurrentDisclosure(input);
      if (!samePolicy(project.collectionPolicy, input.collectionPolicy)) {
        throw new IngestionStoreError(
          'conflict',
          409,
          'The project collection policy changed before consent was recorded.',
        );
      }
      const installationKey = installationMapKey(
        context.principal.tenantId,
        input.projectInstallationId,
      );
      const existingInstallation = this.installations.get(installationKey);
      if (
        existingInstallation !== undefined &&
        (existingInstallation.projectId !== projectId ||
          existingInstallation.userId !== context.principal.userId ||
          existingInstallation.deviceId !== deviceId)
      ) {
        throw new IngestionStoreError(
          'conflict',
          409,
          'The project installation ID is already bound to another installation.',
        );
      }
      this.installations.set(installationKey, {
        tenantId: context.principal.tenantId,
        projectInstallationId: input.projectInstallationId,
        projectId,
        userId: context.principal.userId,
        deviceId,
      });
      const now = new Date(this.now()).toISOString();
      for (const consent of this.consents.values()) {
        if (
          consent.tenantId === context.principal.tenantId &&
          consent.projectInstallationId === input.projectInstallationId &&
          consent.revokedAt === null
        ) {
          consent.revokedAt = now;
        }
      }
      const consent: StoredConsent = {
        tenantId: context.principal.tenantId,
        userId: context.principal.userId,
        consentRecordId: randomUUID(),
        projectId,
        projectInstallationId: input.projectInstallationId,
        deviceId,
        disclosureVersion: input.disclosureVersion,
        disclosureDigest: input.disclosureDigest,
        collectionPolicy: structuredClone(input.collectionPolicy),
        cloudProcessingAcknowledged: true,
        modelProcessingAcknowledged: true,
        captureSurface: input.captureSurface,
        historicalImport: input.historicalImport,
        capturedAt: now,
        effectiveAt: now,
        revokedAt: null,
      };
      this.consents.set(
        consentKey(consent.tenantId, consent.consentRecordId),
        consent,
      );
      this.audit(context, 'project.consent.recorded', {
        projectId,
        consentRecordId: consent.consentRecordId,
        projectInstallationId: consent.projectInstallationId,
        disclosureVersion: consent.disclosureVersion,
        policyVersion: consent.collectionPolicy.policyVersion,
        historicalImport: consent.historicalImport,
      });
      return consentResponse(consent);
    });
  }

  async listConsents(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<ConsentList> {
    return this.exclusive(() => {
      this.requireProject(context, projectId);
      return {
        consents: [...this.consents.values()]
          .filter(
            (consent) =>
              consent.tenantId === context.principal.tenantId &&
              consent.projectId === projectId,
          )
          .sort((left, right) =>
            right.capturedAt.localeCompare(left.capturedAt),
          )
          .map(consentResponse),
      };
    });
  }

  async revokeConsent(
    context: IngestionRequestContext,
    projectId: string,
    consentRecordId: string,
  ): Promise<void> {
    return this.exclusive(() => {
      this.requireProject(context, projectId);
      const consent = this.consents.get(
        consentKey(context.principal.tenantId, consentRecordId),
      );
      if (consent === undefined || consent.projectId !== projectId)
        notFound('consent');
      if (consent.revokedAt === null) {
        consent.revokedAt = new Date(this.now()).toISOString();
        this.audit(context, 'project.consent.revoked', {
          projectId,
          consentRecordId,
          projectInstallationId: consent.projectInstallationId,
        });
      }
    });
  }

  async ingestBatch(
    context: IngestionRequestContext,
    batch: IngestionBatch,
  ): Promise<IngestionAcknowledgement> {
    return this.exclusive(() => {
      const deviceId = requireDevicePrincipal(context);
      if (batch.deviceId !== deviceId) {
        throw new IngestionStoreError(
          'invalid_request',
          400,
          'The batch device does not match the authenticated device.',
        );
      }
      const digest = canonicalJsonSha256(batch);
      const batchMapKey = batchKey(context.principal.tenantId, batch.batchId);
      const replay = this.batches.get(batchMapKey);
      if (replay !== undefined) {
        if (replay.digest !== digest) {
          throw new IngestionStoreError(
            'conflict',
            409,
            'The batch ID was already used for different normalized events.',
          );
        }
        return structuredClone(replay.acknowledgement);
      }

      const project = this.requireProject(context, batch.projectId);
      if (project.state !== 'enabled') {
        throw new IngestionStoreError(
          'project_disabled',
          403,
          'The project is not enabled for ingestion.',
        );
      }
      const installation = this.installations.get(
        installationMapKey(
          context.principal.tenantId,
          batch.projectInstallationId,
        ),
      );
      if (
        installation === undefined ||
        installation.projectId !== batch.projectId ||
        installation.userId !== context.principal.userId ||
        installation.deviceId !== deviceId
      ) {
        throw consentRequired();
      }
      const consent = this.consents.get(
        consentKey(context.principal.tenantId, batch.consentRecordId),
      );
      if (
        consent === undefined ||
        consent.revokedAt !== null ||
        consent.projectId !== batch.projectId ||
        consent.projectInstallationId !== batch.projectInstallationId ||
        consent.userId !== context.principal.userId ||
        consent.deviceId !== deviceId ||
        consent.collectionPolicy.policyVersion !== batch.policyVersion ||
        consent.disclosureVersion !== batch.disclosureVersion ||
        !samePolicy(consent.collectionPolicy, project.collectionPolicy)
      ) {
        throw consentRequired();
      }
      for (const event of batch.events) {
        validateEventCollectionPolicy(event, consent.collectionPolicy);
      }

      const checkpointMapKey = checkpointKey(
        context.principal.tenantId,
        deviceId,
        batch.projectInstallationId,
        batch.source.sourceSessionId,
      );
      const checkpoint = this.checkpoints.get(checkpointMapKey);
      if (
        (checkpoint?.acknowledgedCursor ?? null) !== batch.previousCursor ||
        (checkpoint?.headEventId ?? null) !== batch.expectedHeadEventId
      ) {
        throw checkpointDiverged();
      }

      const sourceMapKey = sourceSessionKey(
        context.principal.tenantId,
        batch.source.sourceSessionId,
      );
      const source = this.sourceSessions.get(sourceMapKey);
      if (
        source !== undefined &&
        (source.projectId !== batch.projectId ||
          source.agent !== batch.source.agent ||
          source.nativeSessionHash !== batch.source.nativeSessionHash)
      ) {
        throw checkpointDiverged();
      }
      const acceptedEventIds: string[] = [];
      const duplicateEventIds: string[] = [];
      const acceptedEvents: SourceEvent[] = [];
      const existingAndIncoming = new Map<string, SourceEvent>();
      for (const [key, event] of this.eventsById) {
        if (key.startsWith(`${context.principal.tenantId}:`)) {
          existingAndIncoming.set(event.eventId, event);
        }
      }
      for (const event of batch.events) {
        const eventKey = tenantEntityKey(
          context.principal.tenantId,
          event.eventId,
        );
        const idempotencyMapKey = tenantEntityKey(
          context.principal.tenantId,
          event.idempotencyKey,
        );
        const existingId = this.eventIdByIdempotency.get(idempotencyMapKey);
        const existing =
          this.eventsById.get(eventKey) ??
          (existingId === undefined
            ? undefined
            : this.eventsById.get(
                tenantEntityKey(context.principal.tenantId, existingId),
              ));
        if (existing !== undefined) {
          if (
            existing.eventId !== event.eventId ||
            existing.idempotencyKey !== event.idempotencyKey ||
            existing.contentHash !== event.contentHash
          ) {
            throw checkpointDiverged();
          }
          duplicateEventIds.push(event.eventId);
          existingAndIncoming.set(existing.eventId, existing);
          continue;
        }
        acceptedEvents.push(event);
        acceptedEventIds.push(event.eventId);
      }

      this.sourceSessions.set(sourceMapKey, {
        tenantId: context.principal.tenantId,
        projectId: batch.projectId,
        sourceSessionId: batch.source.sourceSessionId,
        agent: batch.source.agent,
        nativeSessionHash: batch.source.nativeSessionHash,
        parserVersion: batch.source.parserVersion,
      });
      for (const event of acceptedEvents) {
        const stored = structuredClone(event);
        this.eventsById.set(
          tenantEntityKey(context.principal.tenantId, event.eventId),
          stored,
        );
        this.eventIdByIdempotency.set(
          tenantEntityKey(context.principal.tenantId, event.idempotencyKey),
          event.eventId,
        );
        existingAndIncoming.set(event.eventId, stored);
      }

      const branchCreated = detectsBranch(
        existingAndIncoming.values(),
        batch.source.sourceSessionId,
      );
      const headEventId = chooseHead(
        checkpoint?.headEventId ?? null,
        batch.events,
        existingAndIncoming,
      );
      const updatedAt = new Date(this.now()).toISOString();
      const nextCheckpoint: IngestionCheckpoint = {
        projectId: batch.projectId,
        projectInstallationId: batch.projectInstallationId,
        sourceSessionId: batch.source.sourceSessionId,
        deviceId,
        acknowledgedCursor: batch.proposedCursor,
        headEventId,
        updatedAt,
      };
      this.checkpoints.set(checkpointMapKey, nextCheckpoint);
      const acknowledgement: IngestionAcknowledgement = {
        batchId: batch.batchId,
        acceptedEventIds,
        duplicateEventIds,
        headEventId,
        acknowledgedCursor: batch.proposedCursor,
        branchCreated,
      };
      this.batches.set(batchMapKey, {
        digest,
        acknowledgement: structuredClone(acknowledgement),
      });
      this.audit(context, 'ingestion.batch.accepted', {
        batchId: batch.batchId,
        projectId: batch.projectId,
        projectInstallationId: batch.projectInstallationId,
        sourceSessionId: batch.source.sourceSessionId,
        acceptedEventCount: acceptedEventIds.length,
        duplicateEventCount: duplicateEventIds.length,
        branchCreated,
      });
      return acknowledgement;
    });
  }

  async getCheckpoint(
    context: IngestionRequestContext,
    query: IngestionCheckpointQuery,
  ): Promise<IngestionCheckpoint | null> {
    return this.exclusive(() => {
      const deviceId = requireDevicePrincipal(context);
      this.requireProject(context, query.projectId);
      const installation = this.installations.get(
        installationMapKey(
          context.principal.tenantId,
          query.projectInstallationId,
        ),
      );
      if (
        installation === undefined ||
        installation.projectId !== query.projectId ||
        installation.deviceId !== deviceId ||
        installation.userId !== context.principal.userId
      ) {
        throw new IngestionStoreError(
          'not_found',
          404,
          'The ingestion checkpoint was not found.',
        );
      }
      return structuredClone(
        this.checkpoints.get(
          checkpointKey(
            context.principal.tenantId,
            deviceId,
            query.projectInstallationId,
            query.sourceSessionId,
          ),
        ) ?? null,
      );
    });
  }

  eventCount(tenantId: string): number {
    return [...this.eventsById.keys()].filter((key) =>
      key.startsWith(`${tenantId}:`),
    ).length;
  }

  projectExists(tenantId: string, projectId: string): boolean {
    const project = this.projects.get(projectKey(tenantId, projectId));
    return project !== undefined && project.tenantId === tenantId;
  }

  sourceSessionsForProject(
    tenantId: string,
    projectId: string,
  ): StoredSourceSession[] {
    return [...this.sourceSessions.values()].filter(
      (session) =>
        session.tenantId === tenantId && session.projectId === projectId,
    );
  }

  sourceSessionById(
    tenantId: string,
    sourceSessionId: string,
  ): StoredSourceSession | undefined {
    const session = this.sourceSessions.get(
      sourceSessionKey(tenantId, sourceSessionId),
    );
    return session?.tenantId === tenantId ? session : undefined;
  }

  eventsForSessions(
    tenantId: string,
    sourceSessionIds: readonly string[],
  ): SourceEvent[] {
    const wanted = new Set(sourceSessionIds);
    const events: SourceEvent[] = [];
    for (const [key, event] of this.eventsById) {
      if (key.startsWith(`${tenantId}:`) && wanted.has(event.sourceSessionId)) {
        events.push(structuredClone(event));
      }
    }
    return events;
  }

  auditMetadata(tenantId: string): StoredAudit[] {
    return structuredClone(
      this.audits.filter((event) => event.tenantId === tenantId),
    );
  }

  private requireProject(
    context: IngestionRequestContext,
    projectId: string,
  ): StoredProject {
    const project = this.projects.get(
      projectKey(context.principal.tenantId, projectId),
    );
    if (project === undefined) notFound('project');
    return project;
  }

  private audit(
    context: IngestionRequestContext,
    action: string,
    metadata: StoredAudit['metadata'],
  ): void {
    this.audits.push({
      tenantId: context.principal.tenantId,
      action,
      metadata,
    });
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

function projectResponse(project: StoredProject): Project {
  return structuredClone({
    projectId: project.projectId,
    displayName: project.displayName,
    state: project.state,
    collectionPolicy: project.collectionPolicy,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

function consentResponse(consent: StoredConsent): ConsentRecord {
  const { tenantId: _tenantId, userId: _userId, ...response } = consent;
  return structuredClone(response);
}

function chooseHead(
  currentHeadId: string | null,
  incoming: readonly SourceEvent[],
  events: ReadonlyMap<string, SourceEvent>,
): string | null {
  let head =
    currentHeadId === null ? null : (events.get(currentHeadId) ?? null);
  for (const event of incoming) {
    if (head === null || compareEventOrder(event, head) > 0) head = event;
  }
  return head?.eventId ?? null;
}

function compareEventOrder(left: SourceEvent, right: SourceEvent): number {
  if (left.nativeSequence !== null && right.nativeSequence !== null) {
    const sequence = left.nativeSequence - right.nativeSequence;
    if (sequence !== 0) return sequence;
  }
  const occurred = left.occurredAt.localeCompare(right.occurredAt);
  return occurred === 0 ? left.eventId.localeCompare(right.eventId) : occurred;
}

function detectsBranch(
  events: Iterable<SourceEvent>,
  sourceSessionId: string,
): boolean {
  const children = new Map<string, Set<string>>();
  for (const event of events) {
    if (
      event.sourceSessionId !== sourceSessionId ||
      event.parentEventId === null
    )
      continue;
    const siblings = children.get(event.parentEventId) ?? new Set<string>();
    siblings.add(event.eventId);
    children.set(event.parentEventId, siblings);
  }
  return [...children.values()].some((siblings) => siblings.size > 1);
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

function tenantEntityKey(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

const projectKey = tenantEntityKey;
const installationMapKey = tenantEntityKey;
const consentKey = tenantEntityKey;
const sourceSessionKey = tenantEntityKey;
const batchKey = tenantEntityKey;

function checkpointKey(
  tenantId: string,
  deviceId: string,
  installationId: string,
  sourceSessionId: string,
): string {
  return `${tenantId}:${deviceId}:${installationId}:${sourceSessionId}`;
}
