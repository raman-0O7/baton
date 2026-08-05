import { z } from 'zod';

/** Server-authoritative disclosure accepted for new Phase 2 consent records. */
export const currentCollectionDisclosureVersion =
  'hosted-project-enable-v1' as const;
export const currentCollectionDisclosureDigest =
  '87c2bb9096b0305ecf58be016f10cee6302df7e07618238712a18c43ffcd2307' as const;

export const CollectionCategorySchema = z.enum([
  'conversation_text',
  'plans_and_tasks',
  'command_arguments',
  'tool_results',
  'file_paths',
  'diffs',
  'session_metadata',
]);
export type CollectionCategory = z.infer<typeof CollectionCategorySchema>;

export const CollectionPolicySchema = z
  .object({
    policyVersion: z.string().min(1).max(64),
    allowedCategories: z.array(CollectionCategorySchema).min(1),
    excludedPathPatterns: z.array(z.string().min(1).max(512)).max(200),
    maxToolResultBytes: z.int().nonnegative().max(1_048_576),
    maxDiffBytes: z.int().nonnegative().max(1_048_576),
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.allowedCategories).size !== policy.allowedCategories.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['allowedCategories'],
        message: 'collection categories must be unique',
      });
    }
  });
export type CollectionPolicy = z.infer<typeof CollectionPolicySchema>;

export const ProjectStateSchema = z.enum(['enabled', 'paused', 'disabled']);

export const ProjectSchema = z
  .object({
    projectId: z.uuid(),
    displayName: z.string().min(1).max(128),
    state: ProjectStateSchema,
    collectionPolicy: CollectionPolicySchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;

export const CreateProjectRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128),
    collectionPolicy: CollectionPolicySchema,
  })
  .strict();
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const UpdateProjectRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    state: ProjectStateSchema.optional(),
    collectionPolicy: CollectionPolicySchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one project field must be updated',
  });
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;

export const ProjectListSchema = z
  .object({ projects: z.array(ProjectSchema).max(500) })
  .strict();
export type ProjectList = z.infer<typeof ProjectListSchema>;

export const ConsentCaptureSurfaceSchema = z.enum(['cli', 'dashboard']);

export const CreateConsentRequestSchema = z
  .object({
    projectInstallationId: z.uuid(),
    disclosureVersion: z.string().min(1).max(64),
    disclosureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    collectionPolicy: CollectionPolicySchema,
    cloudProcessingAcknowledged: z.literal(true),
    modelProcessingAcknowledged: z.literal(true),
    captureSurface: ConsentCaptureSurfaceSchema,
    historicalImport: z.boolean().default(false),
  })
  .strict();
export type CreateConsentRequest = z.infer<typeof CreateConsentRequestSchema>;

export const ConsentRecordSchema = z
  .object({
    consentRecordId: z.uuid(),
    projectId: z.uuid(),
    projectInstallationId: z.uuid(),
    deviceId: z.uuid(),
    disclosureVersion: z.string().min(1).max(64),
    disclosureDigest: z.string().regex(/^[a-f0-9]{64}$/),
    collectionPolicy: CollectionPolicySchema,
    cloudProcessingAcknowledged: z.literal(true),
    modelProcessingAcknowledged: z.literal(true),
    captureSurface: ConsentCaptureSurfaceSchema,
    historicalImport: z.boolean(),
    capturedAt: z.iso.datetime(),
    effectiveAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const ConsentListSchema = z
  .object({ consents: z.array(ConsentRecordSchema).max(500) })
  .strict();
export type ConsentList = z.infer<typeof ConsentListSchema>;
