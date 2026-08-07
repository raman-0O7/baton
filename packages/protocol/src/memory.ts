import { z } from 'zod';

/**
 * Layered personal memory. Memories are structured, evidence-backed, and
 * user-approved. `SOUL.md` is a rendering of approved memories, never the
 * source of truth. Nothing here reaches an agent until a user approves it.
 */

export const MemoryScopeTypeSchema = z.enum([
  'global',
  'organization',
  'project',
  'work_thread',
]);
export type MemoryScopeType = z.infer<typeof MemoryScopeTypeSchema>;

export const MemoryScopeSchema = z
  .object({ type: MemoryScopeTypeSchema, id: z.uuid().nullable() })
  .strict()
  .superRefine((scope, context) => {
    if (scope.type === 'global' && scope.id !== null) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'global scope must not carry an id',
      });
    }
  });
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

export const MemoryCategorySchema = z.enum([
  'communication_preference',
  'engineering_workflow',
  'tooling_preference',
  'process_preference',
]);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

export const MemoryStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'revoked',
  'expired',
  'needs_review',
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryVerdictSchema = z.enum(['accept', 'reject', 'needs_review']);
export type MemoryVerdict = z.infer<typeof MemoryVerdictSchema>;

export const MemoryReasonCodeSchema = z.enum([
  'repeated_explicit_preference',
  'scope_too_broad',
  'one_time_narrow_instruction',
  'contradictory_contextual_evidence',
  'sensitive_health_inference_prohibited',
  'sensitive_political_inference_prohibited',
  'sensitive_religion_inference_prohibited',
  'sensitive_identity_inference_prohibited',
  'sensitive_credential_prohibited',
  'unsupported_evidence',
  'duplicate_candidate',
]);
export type MemoryReasonCode = z.infer<typeof MemoryReasonCodeSchema>;

export const MemoryProvenanceSchema = z
  .object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(128),
  })
  .strict();
export type MemoryProvenance = z.infer<typeof MemoryProvenanceSchema>;

export const MemoryCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    category: MemoryCategorySchema,
    claim: z.string().min(1).max(1024),
    scope: MemoryScopeSchema,
    confidence: z.number().min(0).max(1),
    status: MemoryStatusSchema,
    reasonCode: MemoryReasonCodeSchema.nullable(),
    evidenceEventIds: z.array(z.string()).min(1).max(50),
    provenance: MemoryProvenanceSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const MemorySchema = z
  .object({
    memoryId: z.uuid(),
    category: MemoryCategorySchema,
    claim: z.string().min(1).max(1024),
    scope: MemoryScopeSchema,
    confidence: z.number().min(0).max(1),
    status: MemoryStatusSchema,
    evidenceEventIds: z.array(z.string()).min(1).max(50),
    provenance: MemoryProvenanceSchema,
    firstObservedAt: z.iso.datetime(),
    lastConfirmedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Memory = z.infer<typeof MemorySchema>;

export const MemoryCandidateListSchema = z
  .object({ candidates: z.array(MemoryCandidateSchema).max(500) })
  .strict();
export type MemoryCandidateList = z.infer<typeof MemoryCandidateListSchema>;

export const MemoryListSchema = z
  .object({ memories: z.array(MemorySchema).max(500) })
  .strict();
export type MemoryList = z.infer<typeof MemoryListSchema>;

export const MemoryEvidenceInputSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    workThreadId: z.uuid().nullable().default(null),
    text: z.string().min(1).max(8192),
  })
  .strict();
export type MemoryEvidenceInput = z.infer<typeof MemoryEvidenceInputSchema>;

export const ProposeMemoryRequestSchema = z
  .object({
    category: MemoryCategorySchema,
    claim: z.string().min(1).max(1024),
    scope: MemoryScopeSchema,
    evidence: z.array(MemoryEvidenceInputSchema).min(1).max(50),
  })
  .strict();
export type ProposeMemoryRequest = z.infer<typeof ProposeMemoryRequestSchema>;

export const MemoryCandidateQuerySchema = z.object({
  status: z
    .enum(['proposed', 'needs_review', 'approved', 'rejected'])
    .optional(),
});
export type MemoryCandidateQuery = z.infer<typeof MemoryCandidateQuerySchema>;

export const SoulQuerySchema = z.object({
  tokenBudget: z.coerce.number().int().min(64).max(8000).optional(),
});
export type SoulQuery = z.infer<typeof SoulQuerySchema>;

export const ApproveMemoryRequestSchema = z
  .object({
    /** Optionally narrow the scope and/or edit the claim on approval. */
    scope: MemoryScopeSchema.optional(),
    claim: z.string().min(1).max(1024).optional(),
    expiresAt: z.iso.datetime().nullable().optional(),
  })
  .strict();
export type ApproveMemoryRequest = z.infer<typeof ApproveMemoryRequestSchema>;

export const RejectMemoryRequestSchema = z
  .object({ reason: z.string().max(1024).optional() })
  .strict();
export type RejectMemoryRequest = z.infer<typeof RejectMemoryRequestSchema>;

export const SoulDocumentSchema = z
  .object({
    text: z.string(),
    tokenEstimate: z.int().nonnegative(),
    memoryIds: z.array(z.uuid()).max(500),
    truncated: z.boolean(),
  })
  .strict();
export type SoulDocument = z.infer<typeof SoulDocumentSchema>;
