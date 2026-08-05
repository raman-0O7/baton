import { z } from 'zod';

import { AgentNameSchema } from './event.js';

export const ChunkKindSchema = z.enum([
  'message',
  'tool_use',
  'file_change',
  'task',
  'decision',
  'error',
]);
export type ChunkKind = z.infer<typeof ChunkKindSchema>;

export const RetrievedChunkSchema = z
  .object({
    chunkId: z.string().min(1).max(128),
    workThreadId: z.uuid().nullable(),
    sourceSessionId: z.uuid(),
    sourceAgent: AgentNameSchema,
    kind: ChunkKindSchema,
    text: z.string(),
    filePaths: z.array(z.string()).max(50),
    occurredAt: z.iso.datetime(),
    tokenEstimate: z.int().nonnegative(),
    sourceEventIds: z.array(z.string()).max(50),
    score: z.number(),
  })
  .strict();
export type RetrievedChunk = z.infer<typeof RetrievedChunkSchema>;

export const RetrievalResultSchema = z
  .object({
    query: z.string(),
    projectId: z.uuid(),
    workThreadId: z.uuid().nullable(),
    chunks: z.array(RetrievedChunkSchema).max(200),
    lexicalFallback: z.literal(true),
  })
  .strict();
export type RetrievalResult = z.infer<typeof RetrievalResultSchema>;

export const RetrievalSearchQuerySchema = z.object({
  projectId: z.uuid(),
  workThreadId: z.uuid().optional(),
  query: z.string().min(1).max(1024),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type RetrievalSearchQuery = z.infer<typeof RetrievalSearchQuerySchema>;

export const CitationSchema = z
  .object({
    marker: z.string(),
    chunkId: z.string().min(1).max(128),
    kind: ChunkKindSchema,
    sourceEventIds: z.array(z.string()).max(50),
    occurredAt: z.iso.datetime(),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

export const CompiledDocumentSchema = z
  .object({
    text: z.string(),
    tokenEstimate: z.int().nonnegative(),
    citations: z.array(CitationSchema).max(200),
    includedChunkIds: z.array(z.string()).max(200),
    truncated: z.boolean(),
  })
  .strict();
export type CompiledDocument = z.infer<typeof CompiledDocumentSchema>;

export const ThreadContextSchema = z
  .object({
    workThreadId: z.uuid(),
    query: z.string().nullable(),
    bootstrap: CompiledDocumentSchema,
    evidence: CompiledDocumentSchema,
  })
  .strict();
export type ThreadContext = z.infer<typeof ThreadContextSchema>;

export const ThreadContextQuerySchema = z.object({
  query: z.string().min(1).max(1024).optional(),
  tokenBudget: z.coerce.number().int().min(64).max(8000).optional(),
});
export type ThreadContextQuery = z.infer<typeof ThreadContextQuerySchema>;

export const ProjectReindexResultSchema = z
  .object({ projectId: z.uuid(), indexedChunks: z.int().nonnegative() })
  .strict();
export type ProjectReindexResult = z.infer<typeof ProjectReindexResultSchema>;
