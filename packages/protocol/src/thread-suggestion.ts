import { z } from 'zod';

import { WorkThreadSchema } from './work-thread.js';

/**
 * A conservative, deterministic suggestion that a source session belongs to an
 * existing work thread. Suggestions are advisory: the user must confirm a join
 * before the session's history is treated as part of the thread. Reasons make
 * the score explainable in the CLI and dashboard.
 */

export const ThreadSuggestionReasonSchema = z.enum([
  'shared_source_session',
  'shared_files',
  'same_branch',
  'recent_activity',
  'sole_active_thread',
]);
export type ThreadSuggestionReason = z.infer<
  typeof ThreadSuggestionReasonSchema
>;

export const ThreadSuggestionSchema = z
  .object({
    workThread: WorkThreadSchema,
    score: z.number().min(0).max(1),
    reasons: z.array(ThreadSuggestionReasonSchema).max(5),
    sharedFilePaths: z.array(z.string()).max(50),
  })
  .strict();
export type ThreadSuggestion = z.infer<typeof ThreadSuggestionSchema>;

export const ThreadSuggestionListSchema = z
  .object({
    sourceSessionId: z.uuid().nullable(),
    suggestions: z.array(ThreadSuggestionSchema).max(50),
  })
  .strict();
export type ThreadSuggestionList = z.infer<typeof ThreadSuggestionListSchema>;

export const ThreadSuggestionQuerySchema = z.object({
  sourceSessionId: z.uuid().optional(),
});
export type ThreadSuggestionQuery = z.infer<typeof ThreadSuggestionQuerySchema>;
