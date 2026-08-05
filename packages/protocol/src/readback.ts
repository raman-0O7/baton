import { z } from 'zod';

import { SourceEventSchema } from './event.js';
import { WorkThreadSchema, WorkThreadSessionSchema } from './work-thread.js';

export const PageInfoSchema = z
  .object({
    nextCursor: z.string().min(1).max(2048).nullable(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((page, context) => {
    if (page.hasMore !== (page.nextCursor !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'nextCursor must be present exactly when hasMore is true',
      });
    }
  });

export const EventReadbackSchema = z
  .object({
    workThread: WorkThreadSchema,
    sourceSessions: z.array(WorkThreadSessionSchema).max(500),
    events: z.array(SourceEventSchema).max(500),
    page: PageInfoSchema,
  })
  .strict();
export type EventReadback = z.infer<typeof EventReadbackSchema>;

export const WorkThreadEventsQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type WorkThreadEventsQuery = z.infer<typeof WorkThreadEventsQuerySchema>;
