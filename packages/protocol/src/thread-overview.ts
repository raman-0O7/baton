import { z } from 'zod';

import { WorkThreadSchema, WorkThreadSessionSchema } from './work-thread.js';

/**
 * Materialized work-thread state. Every field is a deterministic projection of
 * the thread's immutable source events; nothing here is authoritative on its
 * own. Each item carries the source event it was derived from so a reader can
 * always retrieve the original evidence.
 */

export const ThreadTaskSchema = z
  .object({
    text: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type ThreadTask = z.infer<typeof ThreadTaskSchema>;

export const ThreadDecisionSchema = z
  .object({
    summary: z.string(),
    rationale: z.string().nullable(),
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type ThreadDecision = z.infer<typeof ThreadDecisionSchema>;

export const ThreadFileActivitySchema = z
  .object({
    path: z.string(),
    operations: z.array(z.enum(['create', 'edit', 'delete'])).max(3),
    changeCount: z.int().nonnegative(),
    lastEventId: z.uuid(),
    lastOccurredAt: z.iso.datetime(),
  })
  .strict();
export type ThreadFileActivity = z.infer<typeof ThreadFileActivitySchema>;

export const ThreadErrorSchema = z
  .object({
    message: z.string(),
    command: z.string().nullable(),
    eventId: z.uuid(),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type ThreadError = z.infer<typeof ThreadErrorSchema>;

export const WorkThreadOverviewSchema = z
  .object({
    workThread: WorkThreadSchema,
    sessions: z.array(WorkThreadSessionSchema).max(500),
    tasks: z.array(ThreadTaskSchema).max(200),
    decisions: z.array(ThreadDecisionSchema).max(200),
    fileActivities: z.array(ThreadFileActivitySchema).max(500),
    errors: z.array(ThreadErrorSchema).max(200),
    eventCount: z.int().nonnegative(),
    lastActivityAt: z.iso.datetime().nullable(),
  })
  .strict();
export type WorkThreadOverview = z.infer<typeof WorkThreadOverviewSchema>;
