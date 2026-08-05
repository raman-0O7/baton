import { z } from 'zod';

import { canonicalJsonSha256 } from './canonical-json.js';

export const protocolVersion = 1 as const;

export const AgentNameSchema = z.enum(['claudecode', 'codex', 'opencode']);
export type AgentName = z.infer<typeof AgentNameSchema>;

export const MessagePayloadSchema = z
  .object({
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant', 'system']),
    text: z.string(),
  })
  .strict();

export const ToolCallPayloadSchema = z
  .object({
    kind: z.literal('tool_call'),
    toolCallId: z.string().min(1),
    name: z.string().min(1),
    inputSummary: z.string().optional(),
  })
  .strict();

export const ToolResultPayloadSchema = z
  .object({
    kind: z.literal('tool_result'),
    toolCallId: z.string().min(1),
    outputSummary: z.string().optional(),
    isError: z.boolean().default(false),
  })
  .strict();

export const FileChangePayloadSchema = z
  .object({
    kind: z.literal('file_change'),
    path: z.string().min(1),
    operation: z.enum(['create', 'edit', 'delete']),
    diff: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict();

export const TaskPayloadSchema = z
  .object({
    kind: z.literal('task'),
    nativeTaskId: z.string().optional(),
    text: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();

export const DecisionPayloadSchema = z
  .object({
    kind: z.literal('decision'),
    summary: z.string().min(1),
    rationale: z.string().optional(),
  })
  .strict();

export const ErrorPayloadSchema = z
  .object({
    kind: z.literal('error'),
    message: z.string().min(1),
    command: z.string().optional(),
  })
  .strict();

export const SessionMetadataPayloadSchema = z
  .object({
    kind: z.literal('session_metadata'),
    title: z.string().optional(),
    model: z.string().optional(),
    gitBranch: z.string().optional(),
  })
  .strict();

export const SourceEventPayloadSchema = z.discriminatedUnion('kind', [
  MessagePayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  FileChangePayloadSchema,
  TaskPayloadSchema,
  DecisionPayloadSchema,
  ErrorPayloadSchema,
  SessionMetadataPayloadSchema,
]);
export type SourceEventPayload = z.infer<typeof SourceEventPayloadSchema>;

const SourceEventInputShape = {
  sourceSessionId: z.uuid(),
  workThreadId: z.uuid().nullable().default(null),
  sourceAgent: AgentNameSchema,
  sourceDeviceId: z.uuid(),
  nativeSequence: z.int().nonnegative().nullable().default(null),
  parentEventId: z.uuid().nullable().default(null),
  occurredAt: z.iso.datetime(),
  observedAt: z.iso.datetime(),
  schemaVersion: z.literal(protocolVersion),
  payload: SourceEventPayloadSchema,
} as const;

/**
 * Adapter output before Baton adds deterministic integrity and retry fields.
 */
export const SourceEventInputSchema = z.object(SourceEventInputShape).strict();
export type SourceEventInput = z.infer<typeof SourceEventInputSchema>;

export const SourceEventIdempotencyInputSchema = SourceEventInputSchema.pick({
  sourceSessionId: true,
  sourceAgent: true,
  nativeSequence: true,
  occurredAt: true,
  payload: true,
  schemaVersion: true,
});
export type SourceEventIdempotencyInput = z.infer<
  typeof SourceEventIdempotencyInputSchema
>;

const SourceEventBaseSchema = z
  .object({
    ...SourceEventInputShape,
    eventId: z.uuid(),
    idempotencyKey: z.string().regex(/^evt:v1:[a-f0-9]{64}$/),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const SourceEventSchema = SourceEventBaseSchema.superRefine(
  (event, context) => {
    const expectedContentHash = computeSourceEventContentHash(event.payload);
    if (event.contentHash !== expectedContentHash) {
      context.addIssue({
        code: 'custom',
        path: ['contentHash'],
        message: 'content hash does not match the canonical event payload',
      });
    }

    const expectedIdempotencyKey = deriveSourceEventIdempotencyKey(event);
    if (event.idempotencyKey !== expectedIdempotencyKey) {
      context.addIssue({
        code: 'custom',
        path: ['idempotencyKey'],
        message: 'idempotency key does not match the canonical source event',
      });
    }

    const expectedEventId = deriveSourceEventId(event);
    if (event.eventId !== expectedEventId) {
      context.addIssue({
        code: 'custom',
        path: ['eventId'],
        message: 'event ID does not match the canonical source event',
      });
    }
  },
);
export type SourceEvent = z.infer<typeof SourceEventSchema>;

/**
 * Hash only the normalized event content. Observation/device metadata does not
 * change content identity.
 */
export function computeSourceEventContentHash(
  payload: SourceEventPayload,
): string {
  const normalizedPayload = SourceEventPayloadSchema.parse(payload);
  return canonicalJsonSha256({
    schemaVersion: protocolVersion,
    payload: normalizedPayload,
  });
}

/**
 * Derive the retry identity of a native event.
 *
 * Event IDs, device IDs, observation timestamps, thread assignment and parent
 * links are intentionally excluded: a second device observing the same native
 * event must derive the same key.
 */
export function deriveSourceEventIdempotencyKey(
  input: SourceEventIdempotencyInput,
): string {
  const normalized = SourceEventIdempotencyInputSchema.parse({
    sourceSessionId: input.sourceSessionId,
    sourceAgent: input.sourceAgent,
    nativeSequence: input.nativeSequence,
    occurredAt: input.occurredAt,
    payload: input.payload,
    schemaVersion: input.schemaVersion,
  });
  return `evt:v1:${canonicalJsonSha256({
    sourceSessionId: normalized.sourceSessionId,
    sourceAgent: normalized.sourceAgent,
    nativeSequence: normalized.nativeSequence,
    occurredAt: normalized.occurredAt,
    contentHash: computeSourceEventContentHash(normalized.payload),
    schemaVersion: normalized.schemaVersion,
  })}`;
}

/**
 * Derive an RFC 9562 UUIDv8 from the event's idempotency digest.
 *
 * UUIDv8 reserves the version and variant bits while allowing Baton to use the
 * remaining 122 bits for deterministic, application-defined identity.
 */
export function deriveSourceEventId(
  input: SourceEventIdempotencyInput,
): string {
  const digest = deriveSourceEventIdempotencyKey(input).slice('evt:v1:'.length);
  const variantNibble = (
    (Number.parseInt(digest.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  const uuidHex = `${digest.slice(0, 12)}8${digest.slice(
    13,
    16,
  )}${variantNibble}${digest.slice(17, 32)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(
    12,
    16,
  )}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
}

/** Validate adapter output and add canonical hash/idempotency fields. */
export function createSourceEvent(input: SourceEventInput): SourceEvent {
  const normalized = SourceEventInputSchema.parse(input);
  return SourceEventSchema.parse({
    ...normalized,
    eventId: deriveSourceEventId(normalized),
    contentHash: computeSourceEventContentHash(normalized.payload),
    idempotencyKey: deriveSourceEventIdempotencyKey(normalized),
  });
}
