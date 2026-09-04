import { z } from 'zod';

import { AgentNameSchema } from './event.js';

export const WorkThreadStateSchema = z.enum([
  'active',
  'paused',
  'completed',
  'archived',
]);
export type WorkThreadState = z.infer<typeof WorkThreadStateSchema>;

export const WorkThreadSessionAssignmentSchema = z.enum([
  'suggested',
  'confirmed',
]);
export type WorkThreadSessionAssignment = z.infer<
  typeof WorkThreadSessionAssignmentSchema
>;

export const WorkThreadSchema = z
  .object({
    workThreadId: z.uuid(),
    projectId: z.uuid(),
    title: z.string().min(1).max(256),
    goal: z.string().max(4096).nullable(),
    state: WorkThreadStateSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type WorkThread = z.infer<typeof WorkThreadSchema>;

export const CreateWorkThreadRequestSchema = z
  .object({
    projectId: z.uuid(),
    title: z.string().min(1).max(256),
    goal: z.string().max(4096).nullable().default(null),
  })
  .strict();
export type CreateWorkThreadRequest = z.infer<
  typeof CreateWorkThreadRequestSchema
>;

export const UpdateWorkThreadRequestSchema = z
  .object({
    title: z.string().min(1).max(256).optional(),
    goal: z.string().max(4096).nullable().optional(),
    state: WorkThreadStateSchema.optional(),
  })
  .strict();
export type UpdateWorkThreadRequest = z.infer<
  typeof UpdateWorkThreadRequestSchema
>;

export const SourceSessionSchema = z
  .object({
    sourceSessionId: z.uuid(),
    projectId: z.uuid(),
    sourceAgent: AgentNameSchema,
    nativeSessionHash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().max(256).nullable(),
    startedAt: z.iso.datetime().nullable(),
    lastEventAt: z.iso.datetime().nullable(),
  })
  .strict();
export type SourceSession = z.infer<typeof SourceSessionSchema>;

export const SourceSessionListSchema = z
  .object({ sourceSessions: z.array(SourceSessionSchema).max(500) })
  .strict();
export type SourceSessionList = z.infer<typeof SourceSessionListSchema>;

export const WorkThreadSessionSchema = z
  .object({
    workThreadId: z.uuid(),
    sourceSession: SourceSessionSchema,
    position: z.int().nonnegative(),
    assignment: WorkThreadSessionAssignmentSchema,
    assignedAt: z.iso.datetime(),
  })
  .strict();
export type WorkThreadSession = z.infer<typeof WorkThreadSessionSchema>;

export const WorkThreadSessionListSchema = z
  .object({ sessions: z.array(WorkThreadSessionSchema).max(500) })
  .strict();
export type WorkThreadSessionList = z.infer<typeof WorkThreadSessionListSchema>;

export const AssignWorkThreadSessionRequestSchema = z
  .object({
    sourceSessionId: z.uuid(),
    assignment: WorkThreadSessionAssignmentSchema.default('confirmed'),
  })
  .strict();
export type AssignWorkThreadSessionRequest = z.infer<
  typeof AssignWorkThreadSessionRequestSchema
>;

export const WorkThreadListSchema = z
  .object({ workThreads: z.array(WorkThreadSchema).max(500) })
  .strict();
export type WorkThreadList = z.infer<typeof WorkThreadListSchema>;
