import { z } from 'zod';

import { AccountSchema } from './auth.js';
import { SourceEventSchema } from './event.js';
import { MemorySchema } from './memory.js';
import { ProjectSchema } from './project.js';
import { WorkThreadSchema } from './work-thread.js';

/**
 * Deletion is a workflow, not a single statement. A receipt reports what was
 * removed across every store so completion is observable and auditable.
 */
export const DeletionReceiptSchema = z
  .object({
    scope: z.enum(['project', 'account']),
    targetId: z.string().nullable(),
    deletedAt: z.iso.datetime(),
    deletedCounts: z.record(z.string(), z.int().nonnegative()),
    complete: z.boolean(),
  })
  .strict();
export type DeletionReceipt = z.infer<typeof DeletionReceiptSchema>;

/**
 * A documented, user-inspectable export archive. It carries the user's own
 * normalized events, work threads, approved memories, and project metadata —
 * never another tenant's data and never opaque model internals.
 */
export const ExportArchiveSchema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.enum(['project', 'account']),
    exportedAt: z.iso.datetime(),
    account: AccountSchema,
    projects: z.array(ProjectSchema).max(1000),
    workThreads: z.array(WorkThreadSchema).max(5000),
    memories: z.array(MemorySchema).max(5000),
    events: z.array(SourceEventSchema).max(50000),
  })
  .strict();
export type ExportArchive = z.infer<typeof ExportArchiveSchema>;

export const ExportQuerySchema = z.object({
  projectId: z.uuid().optional(),
});
export type ExportQuery = z.infer<typeof ExportQuerySchema>;
