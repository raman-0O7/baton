import type {
  AgentName,
  CollectionPolicy,
  IngestionAcknowledgement,
  OAuthScope,
  SourceEventPayload,
  WorkThreadSessionAssignment,
  WorkThreadState,
} from '@baton/protocol';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
};

export const tenants = pgTable('tenants', {
  tenantId: uuid('tenant_id').primaryKey(),
  kind: text('kind').notNull(),
  displayName: text('display_name').notNull(),
  ...timestamps,
});

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey(),
    primaryTenantId: uuid('primary_tenant_id')
      .notNull()
      .references(() => tenants.tenantId),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('users_issuer_subject_uidx').on(table.issuer, table.subject),
  ],
);

export const tenantMemberships = pgTable(
  'tenant_memberships',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.tenantId),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);

export const browserSessions = pgTable(
  'browser_sessions',
  {
    sessionId: uuid('session_id').primaryKey(),
    sessionHash: text('session_hash').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('browser_sessions_tenant_user_idx').on(table.tenantId, table.userId),
    index('browser_sessions_expiry_idx').on(table.expiresAt),
  ],
);

export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    grantId: uuid('grant_id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull(),
    userCodeHash: text('user_code_hash').notNull(),
    clientId: text('client_id').notNull(),
    deviceName: text('device_name').notNull(),
    platform: text('platform').notNull(),
    clientVersion: text('client_version').notNull(),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    status: text('status').notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedUserId: uuid('approved_user_id'),
    approvedTenantId: uuid('approved_tenant_id'),
    consumedDeviceId: uuid('consumed_device_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('device_authorizations_device_code_uidx').on(
      table.deviceCodeHash,
    ),
    uniqueIndex('device_authorizations_user_code_uidx').on(table.userCodeHash),
    index('device_authorizations_expiry_idx').on(table.expiresAt),
  ],
);

export const devices = pgTable(
  'devices',
  {
    deviceId: uuid('device_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    name: text('name').notNull(),
    platform: text('platform').notNull(),
    clientVersion: text('client_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('devices_tenant_device_uidx').on(
      table.tenantId,
      table.deviceId,
    ),
    index('devices_tenant_user_idx').on(table.tenantId, table.userId),
  ],
);

export const tokenFamilies = pgTable(
  'token_families',
  {
    familyId: uuid('family_id').primaryKey(),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('token_families_tenant_device_idx').on(
      table.tenantId,
      table.deviceId,
    ),
  ],
);

export const accessTokens = pgTable(
  'access_tokens',
  {
    tokenId: uuid('token_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => tokenFamilies.familyId),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('access_tokens_family_idx').on(table.familyId),
    index('access_tokens_expiry_idx').on(table.expiresAt),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenId: uuid('token_id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => tokenFamilies.familyId),
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    scopes: jsonb('scopes').$type<OAuthScope[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id'),
  },
  (table) => [
    index('refresh_tokens_family_idx').on(table.familyId),
    index('refresh_tokens_expiry_idx').on(table.expiresAt),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    auditEventId: uuid('audit_event_id').primaryKey(),
    tenantId: uuid('tenant_id'),
    actorUserId: uuid('actor_user_id'),
    actorDeviceId: uuid('actor_device_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: uuid('target_id'),
    requestId: text('request_id').notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('audit_events_tenant_time_idx').on(table.tenantId, table.occurredAt),
    index('audit_events_request_idx').on(table.requestId),
  ],
);

export const projects = pgTable(
  'projects',
  {
    tenantId: uuid('tenant_id').notNull(),
    projectId: uuid('project_id').notNull(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    displayName: text('display_name').notNull(),
    state: text('state').notNull(),
    collectionPolicy: jsonb('collection_policy')
      .$type<CollectionPolicy>()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.projectId] }),
    index('projects_tenant_updated_idx').on(table.tenantId, table.updatedAt),
  ],
);

export const projectInstallations = pgTable(
  'project_installations',
  {
    tenantId: uuid('tenant_id').notNull(),
    projectInstallationId: uuid('project_installation_id').notNull(),
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.projectInstallationId],
    }),
    foreignKey({
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.projectId],
      name: 'project_installations_project_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.deviceId],
      foreignColumns: [devices.tenantId, devices.deviceId],
      name: 'project_installations_device_fk',
    }),
    index('project_installations_tenant_project_idx').on(
      table.tenantId,
      table.projectId,
    ),
  ],
);

export const consentRecords = pgTable(
  'consent_records',
  {
    tenantId: uuid('tenant_id').notNull(),
    consentRecordId: uuid('consent_record_id').notNull(),
    projectId: uuid('project_id').notNull(),
    projectInstallationId: uuid('project_installation_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    disclosureVersion: text('disclosure_version').notNull(),
    disclosureDigest: text('disclosure_digest').notNull(),
    collectionPolicy: jsonb('collection_policy')
      .$type<CollectionPolicy>()
      .notNull(),
    cloudProcessingAcknowledged: boolean(
      'cloud_processing_acknowledged',
    ).notNull(),
    modelProcessingAcknowledged: boolean(
      'model_processing_acknowledged',
    ).notNull(),
    captureSurface: text('capture_surface').notNull(),
    historicalImport: boolean('historical_import').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.consentRecordId] }),
    foreignKey({
      columns: [table.tenantId, table.projectInstallationId],
      foreignColumns: [
        projectInstallations.tenantId,
        projectInstallations.projectInstallationId,
      ],
      name: 'consent_records_installation_fk',
    }),
    index('consent_records_active_installation_idx').on(
      table.tenantId,
      table.projectInstallationId,
      table.revokedAt,
    ),
  ],
);

export const sourceSessions = pgTable(
  'source_sessions',
  {
    tenantId: uuid('tenant_id').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    projectId: uuid('project_id').notNull(),
    agent: text('agent').$type<AgentName>().notNull(),
    nativeSessionHash: text('native_session_hash').notNull(),
    parserVersion: text('parser_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.sourceSessionId] }),
    foreignKey({
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.projectId],
      name: 'source_sessions_project_fk',
    }),
    index('source_sessions_tenant_project_idx').on(
      table.tenantId,
      table.projectId,
    ),
  ],
);

export const sourceEvents = pgTable(
  'source_events',
  {
    tenantId: uuid('tenant_id').notNull(),
    eventId: uuid('event_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    workThreadId: uuid('work_thread_id'),
    sourceAgent: text('source_agent').$type<AgentName>().notNull(),
    sourceDeviceId: uuid('source_device_id').notNull(),
    nativeSequence: integer('native_sequence'),
    parentEventId: uuid('parent_event_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    contentHash: text('content_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payload: jsonb('payload').$type<SourceEventPayload>().notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.eventId] }),
    foreignKey({
      columns: [table.tenantId, table.sourceSessionId],
      foreignColumns: [sourceSessions.tenantId, sourceSessions.sourceSessionId],
      name: 'source_events_session_fk',
    }),
    uniqueIndex('source_events_tenant_idempotency_uidx').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index('source_events_tenant_session_sequence_idx').on(
      table.tenantId,
      table.sourceSessionId,
      table.nativeSequence,
    ),
    index('source_events_tenant_parent_idx').on(
      table.tenantId,
      table.parentEventId,
    ),
  ],
);

export const ingestionBatches = pgTable(
  'ingestion_batches',
  {
    tenantId: uuid('tenant_id').notNull(),
    batchId: uuid('batch_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    projectId: uuid('project_id').notNull(),
    projectInstallationId: uuid('project_installation_id').notNull(),
    consentRecordId: uuid('consent_record_id').notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    acknowledgement: jsonb('acknowledgement')
      .$type<IngestionAcknowledgement>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.batchId] }),
    index('ingestion_batches_tenant_session_idx').on(
      table.tenantId,
      table.sourceSessionId,
      table.createdAt,
    ),
  ],
);

export const ingestionCheckpoints = pgTable(
  'ingestion_checkpoints',
  {
    tenantId: uuid('tenant_id').notNull(),
    deviceId: uuid('device_id').notNull(),
    projectId: uuid('project_id').notNull(),
    projectInstallationId: uuid('project_installation_id').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    acknowledgedCursor: text('acknowledged_cursor').notNull(),
    headEventId: uuid('head_event_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.tenantId,
        table.deviceId,
        table.projectInstallationId,
        table.sourceSessionId,
      ],
    }),
    foreignKey({
      columns: [table.tenantId, table.projectInstallationId],
      foreignColumns: [
        projectInstallations.tenantId,
        projectInstallations.projectInstallationId,
      ],
      name: 'ingestion_checkpoints_installation_fk',
    }),
    index('ingestion_checkpoints_tenant_project_idx').on(
      table.tenantId,
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const artifacts = pgTable(
  'artifacts',
  {
    tenantId: uuid('tenant_id').notNull(),
    artifactId: uuid('artifact_id').notNull(),
    projectId: uuid('project_id').notNull(),
    sourceEventId: uuid('source_event_id'),
    artifactClass: text('artifact_class').notNull(),
    objectKey: text('object_key').notNull(),
    contentHash: text('content_hash').notNull(),
    byteCount: integer('byte_count').notNull(),
    mediaType: text('media_type').notNull(),
    lifecycleState: text('lifecycle_state').notNull(),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.artifactId] }),
    uniqueIndex('artifacts_object_key_uidx').on(table.objectKey),
    index('artifacts_tenant_project_idx').on(table.tenantId, table.projectId),
  ],
);

export const workThreads = pgTable(
  'work_threads',
  {
    tenantId: uuid('tenant_id').notNull(),
    workThreadId: uuid('work_thread_id').notNull(),
    projectId: uuid('project_id').notNull(),
    title: text('title').notNull(),
    goal: text('goal'),
    state: text('state').$type<WorkThreadState>().notNull(),
    createdByUserId: uuid('created_by_user_id').notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.workThreadId] }),
    foreignKey({
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.projectId],
      name: 'work_threads_project_fk',
    }),
    index('work_threads_tenant_project_idx').on(
      table.tenantId,
      table.projectId,
      table.updatedAt,
    ),
  ],
);

export const workThreadSessions = pgTable(
  'work_thread_sessions',
  {
    tenantId: uuid('tenant_id').notNull(),
    workThreadId: uuid('work_thread_id').notNull(),
    sourceSessionId: uuid('source_session_id').notNull(),
    position: integer('position').notNull(),
    assignment: text('assignment')
      .$type<WorkThreadSessionAssignment>()
      .notNull(),
    assignedByUserId: uuid('assigned_by_user_id').notNull(),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.workThreadId, table.sourceSessionId],
    }),
    foreignKey({
      columns: [table.tenantId, table.workThreadId],
      foreignColumns: [workThreads.tenantId, workThreads.workThreadId],
      name: 'work_thread_sessions_thread_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.sourceSessionId],
      foreignColumns: [sourceSessions.tenantId, sourceSessions.sourceSessionId],
      name: 'work_thread_sessions_session_fk',
    }),
    uniqueIndex('work_thread_sessions_tenant_session_uidx').on(
      table.tenantId,
      table.sourceSessionId,
    ),
  ],
);

export const chunks = pgTable(
  'chunks',
  {
    tenantId: uuid('tenant_id').notNull(),
    chunkId: text('chunk_id').notNull(),
    projectId: uuid('project_id').notNull(),
    workThreadId: uuid('work_thread_id'),
    sourceSessionId: uuid('source_session_id').notNull(),
    sourceAgent: text('source_agent').$type<AgentName>().notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    filePaths: jsonb('file_paths').$type<string[]>().notNull(),
    sourceEventIds: jsonb('source_event_ids').$type<string[]>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    tokenEstimate: integer('token_estimate').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.chunkId] }),
    foreignKey({
      columns: [table.tenantId, table.projectId],
      foreignColumns: [projects.tenantId, projects.projectId],
      name: 'chunks_project_fk',
    }),
    index('chunks_tenant_project_thread_idx').on(
      table.tenantId,
      table.projectId,
      table.workThreadId,
    ),
  ],
);

export const identitySchema = {
  tenants,
  users,
  tenantMemberships,
  browserSessions,
  deviceAuthorizations,
  devices,
  tokenFamilies,
  accessTokens,
  refreshTokens,
  auditEvents,
  projects,
  projectInstallations,
  consentRecords,
  sourceSessions,
  sourceEvents,
  ingestionBatches,
  ingestionCheckpoints,
  artifacts,
  workThreads,
  workThreadSessions,
  chunks,
};
