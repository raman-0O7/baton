import { z } from 'zod';

export const ApiErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'insufficient_scope',
  'not_found',
  'conflict',
  'checkpoint_diverged',
  'payload_too_large',
  'rate_limited',
  'consent_required',
  'project_disabled',
  'authorization_pending',
  'slow_down',
  'access_denied',
  'expired_grant',
  'invalid_grant',
  'internal_error',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiProblemFieldSchema = z
  .object({
    path: z.string().min(1),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

/** Baton-wide RFC 9457-compatible error response. */
export const ApiProblemSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.int().min(400).max(599),
    code: ApiErrorCodeSchema,
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().min(1),
    errors: z.array(ApiProblemFieldSchema).max(100).optional(),
    retryAfterSeconds: z.int().nonnegative().optional(),
  })
  .strict();
export type ApiProblem = z.infer<typeof ApiProblemSchema>;
