import type { AuthPrincipal } from '@baton/auth';
import {
  currentCollectionDisclosureDigest,
  currentCollectionDisclosureVersion,
  type ApiErrorCode,
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
  type UpdateProjectRequest,
} from '@baton/protocol';

export interface IngestionRequestContext {
  principal: AuthPrincipal;
  requestId: string;
}

export interface IngestionStore {
  listProjects(context: IngestionRequestContext): Promise<ProjectList>;
  createProject(
    context: IngestionRequestContext,
    input: CreateProjectRequest,
  ): Promise<Project>;
  updateProject(
    context: IngestionRequestContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<Project>;
  recordConsent(
    context: IngestionRequestContext,
    projectId: string,
    input: CreateConsentRequest,
  ): Promise<ConsentRecord>;
  listConsents(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<ConsentList>;
  revokeConsent(
    context: IngestionRequestContext,
    projectId: string,
    consentRecordId: string,
  ): Promise<void>;
  ingestBatch(
    context: IngestionRequestContext,
    batch: IngestionBatch,
  ): Promise<IngestionAcknowledgement>;
  getCheckpoint(
    context: IngestionRequestContext,
    query: IngestionCheckpointQuery,
  ): Promise<IngestionCheckpoint | null>;
}

export class IngestionStoreError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireDevicePrincipal(
  context: IngestionRequestContext,
): string {
  if (context.principal.deviceId === null) {
    throw new IngestionStoreError(
      'invalid_request',
      400,
      'This operation must be performed by a registered device.',
    );
  }
  return context.principal.deviceId;
}

export function requireCurrentDisclosure(
  input: Pick<CreateConsentRequest, 'disclosureVersion' | 'disclosureDigest'>,
): void {
  if (
    input.disclosureVersion !== currentCollectionDisclosureVersion ||
    input.disclosureDigest !== currentCollectionDisclosureDigest
  ) {
    throw new IngestionStoreError(
      'conflict',
      409,
      'The project collection disclosure changed before consent was recorded.',
    );
  }
}
