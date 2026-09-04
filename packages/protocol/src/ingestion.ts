import { z } from 'zod';

import {
  type AgentName,
  AgentNameSchema,
  SourceEventInputSchema,
  SourceEventSchema,
  protocolVersion,
} from './event.js';

export const SourceSessionIdentitySchema = z
  .object({
    sourceSessionId: z.uuid(),
    agent: AgentNameSchema,
    nativeSessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    parserVersion: z.string().min(1).max(64),
  })
  .strict();

const IngestionBatchBaseShape = {
  schemaVersion: z.literal(protocolVersion),
  batchId: z.uuid(),
  deviceId: z.uuid(),
  projectId: z.uuid(),
  projectInstallationId: z.uuid(),
  consentRecordId: z.uuid(),
  policyVersion: z.string().min(1).max(64),
  disclosureVersion: z.string().min(1).max(64),
  source: SourceSessionIdentitySchema,
  expectedHeadEventId: z.uuid().nullable(),
  previousCursor: z.string().min(1).max(2048).nullable(),
  proposedCursor: z.string().min(1).max(2048),
} as const;

/** Pre-integrity local form accepted only by the mandatory scrubber. */
export const IngestionBatchDraftSchema = z
  .object({
    ...IngestionBatchBaseShape,
    events: z.array(SourceEventInputSchema).min(1).max(500),
  })
  .strict()
  .superRefine((batch, context) => {
    validateEventAttribution(batch, context);
  });
export type IngestionBatchDraft = z.infer<typeof IngestionBatchDraftSchema>;

export const IngestionBatchSchema = z
  .object({
    ...IngestionBatchBaseShape,
    events: z.array(SourceEventSchema).min(1).max(500),
  })
  .strict()
  .superRefine((batch, context) => {
    validateEventAttribution(batch, context);

    const eventIds = new Set<string>();
    const idempotencyKeys = new Set<string>();

    for (const [index, event] of batch.events.entries()) {
      if (eventIds.has(event.eventId)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'eventId'],
          message: 'event IDs must be unique within a batch',
        });
      }
      if (idempotencyKeys.has(event.idempotencyKey)) {
        context.addIssue({
          code: 'custom',
          path: ['events', index, 'idempotencyKey'],
          message: 'idempotency keys must be unique within a batch',
        });
      }

      eventIds.add(event.eventId);
      idempotencyKeys.add(event.idempotencyKey);
    }
  });

export type IngestionBatch = z.infer<typeof IngestionBatchSchema>;

interface AttributedEvent {
  sourceSessionId: string;
  sourceDeviceId: string;
  sourceAgent: AgentName;
}

function validateEventAttribution(
  batch: {
    deviceId: string;
    source: { sourceSessionId: string; agent: AgentName };
    events: AttributedEvent[];
  },
  context: z.RefinementCtx,
): void {
  if (batch.source.sourceSessionId !== batch.events[0]?.sourceSessionId) {
    context.addIssue({
      code: 'custom',
      path: ['events'],
      message: 'all events must belong to the declared source session',
    });
  }

  for (const [index, event] of batch.events.entries()) {
    if (event.sourceSessionId !== batch.source.sourceSessionId) {
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'sourceSessionId'],
        message: 'event source session does not match the batch source',
      });
    }
    if (event.sourceDeviceId !== batch.deviceId) {
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'sourceDeviceId'],
        message: 'event source device does not match the batch device',
      });
    }
    if (event.sourceAgent !== batch.source.agent) {
      context.addIssue({
        code: 'custom',
        path: ['events', index, 'sourceAgent'],
        message: 'event source agent does not match the batch source',
      });
    }
  }
}

export const IngestionAcknowledgementSchema = z
  .object({
    batchId: z.uuid(),
    acceptedEventIds: z.array(z.uuid()),
    duplicateEventIds: z.array(z.uuid()),
    headEventId: z.uuid().nullable(),
    acknowledgedCursor: z.string().min(1).max(2048),
    branchCreated: z.boolean(),
  })
  .strict();

export type IngestionAcknowledgement = z.infer<
  typeof IngestionAcknowledgementSchema
>;

export const IngestionCheckpointQuerySchema = z
  .object({
    projectId: z.uuid(),
    projectInstallationId: z.uuid(),
    sourceSessionId: z.uuid(),
  })
  .strict();
export type IngestionCheckpointQuery = z.infer<
  typeof IngestionCheckpointQuerySchema
>;

export const IngestionCheckpointSchema = z
  .object({
    projectId: z.uuid(),
    projectInstallationId: z.uuid(),
    sourceSessionId: z.uuid(),
    deviceId: z.uuid(),
    acknowledgedCursor: z.string().min(1).max(2048),
    headEventId: z.uuid().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type IngestionCheckpoint = z.infer<typeof IngestionCheckpointSchema>;

export const maxIngestionCompressedBytes = 256 * 1024;
export const maxIngestionDecompressedBytes = 2 * 1024 * 1024;
