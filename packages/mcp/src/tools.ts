import { z } from 'zod';

import type { BatonReadClient } from './client.js';

export interface McpTextContent {
  type: 'text';
  text: string;
}

export interface McpToolResult {
  content: McpTextContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface BatonMcpTool {
  name: string;
  title: string;
  description: string;
  /** Zod object schema, used to validate inbound tool input. */
  inputSchema: z.ZodType;
  /** Raw Zod shape, used to register the tool with the MCP SDK. */
  inputShape: z.ZodRawShape;
  handle(
    client: BatonReadClient,
    accessToken: string,
    input: unknown,
  ): Promise<McpToolResult>;
}

const uuid = z.uuid();
const maxSearchLimit = 50;
const defaultTokenBudget = 2000;
const maxTokenBudget = 4000;
const minTokenBudget = 64;

function clampTokenBudget(value: number | undefined): number {
  if (value === undefined) return defaultTokenBudget;
  return Math.min(maxTokenBudget, Math.max(minTokenBudget, Math.trunc(value)));
}

function text(value: string): McpTextContent[] {
  return [{ type: 'text', text: value }];
}

/**
 * Wrap a handler so a failed upstream call becomes a structured tool error
 * carrying only the API problem's public detail — never the access token or an
 * internal stack. A tool that cannot see a project (wrong tenant) surfaces the
 * API's not_found, so a confused-deputy attempt reveals nothing.
 */
async function guard(
  operation: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  try {
    return await operation();
  } catch (error) {
    return { content: text(safeErrorMessage(error)), isError: true };
  }
}

function safeErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'problem' in error &&
    typeof (error as { problem: unknown }).problem === 'object' &&
    (error as { problem: Record<string, unknown> }).problem !== null
  ) {
    const problem = (error as { problem: Record<string, unknown> }).problem;
    const detail =
      typeof problem.detail === 'string'
        ? problem.detail
        : typeof problem.title === 'string'
          ? problem.title
          : 'The request was rejected.';
    return `Baton could not complete this request: ${detail}`;
  }
  return 'Baton could not complete this request.';
}

const listThreadsShape = {
  projectId: uuid,
  status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
} satisfies z.ZodRawShape;
const listThreadsInput = z.object(listThreadsShape).strict();

const suggestThreadsShape = {
  projectId: uuid,
  sourceSessionId: uuid.optional(),
} satisfies z.ZodRawShape;
const suggestThreadsInput = z.object(suggestThreadsShape).strict();

const threadOverviewShape = { workThreadId: uuid } satisfies z.ZodRawShape;
const threadOverviewInput = z.object(threadOverviewShape).strict();

const searchContextShape = {
  projectId: uuid,
  query: z.string().min(1).max(1024),
  workThreadId: uuid.optional(),
  limit: z.number().int().min(1).max(maxSearchLimit).optional(),
} satisfies z.ZodRawShape;
const searchContextInput = z.object(searchContextShape).strict();

const threadContextShape = {
  workThreadId: uuid,
  query: z.string().min(1).max(1024).optional(),
  tokenBudget: z.number().int().optional(),
} satisfies z.ZodRawShape;
const threadContextInput = z.object(threadContextShape).strict();

export const batonMcpTools: BatonMcpTool[] = [
  {
    name: 'baton_list_threads',
    title: 'List work threads',
    description:
      'List the work threads in a Baton project, optionally filtered by status. Requires an explicit projectId.',
    inputSchema: listThreadsInput,
    inputShape: listThreadsShape,
    handle: (client, token, raw) =>
      guard(async () => {
        const input = listThreadsInput.parse(raw);
        const threads = (await client.workThreads(input.projectId, token))
          .filter((thread) =>
            input.status === undefined ? true : thread.state === input.status,
          )
          .map((thread) => ({
            workThreadId: thread.workThreadId,
            title: thread.title,
            state: thread.state,
            updatedAt: thread.updatedAt,
          }));
        const lines =
          threads.length === 0
            ? 'No work threads match.'
            : threads
                .map(
                  (thread) =>
                    `- ${thread.title} [${thread.state}] (${thread.workThreadId})`,
                )
                .join('\n');
        return { content: text(lines), structuredContent: { threads } };
      }),
  },
  {
    name: 'baton_suggest_threads',
    title: 'Suggest continuable threads',
    description:
      'Rank the work threads a project (or a specific source session) is most likely continuing, with explainable reasons.',
    inputSchema: suggestThreadsInput,
    inputShape: suggestThreadsShape,
    handle: (client, token, raw) =>
      guard(async () => {
        const input = suggestThreadsInput.parse(raw);
        const result = await client.suggestThreads(
          input.projectId,
          input.sourceSessionId ?? null,
          token,
        );
        const lines =
          result.suggestions.length === 0
            ? 'No thread suggestions.'
            : result.suggestions
                .map(
                  (suggestion) =>
                    `- ${suggestion.workThread.title} (score ${suggestion.score.toFixed(2)}; ${suggestion.reasons.join(', ')})`,
                )
                .join('\n');
        return {
          content: text(lines),
          structuredContent: {
            suggestions: result.suggestions,
            sourceSessionId: result.sourceSessionId,
          },
        };
      }),
  },
  {
    name: 'baton_get_thread_overview',
    title: 'Get thread overview',
    description:
      'Read the materialized state of a work thread: goal, open tasks, decisions, changed files, and sources. Each item cites source events.',
    inputSchema: threadOverviewInput,
    inputShape: threadOverviewShape,
    handle: (client, token, raw) =>
      guard(async () => {
        const input = threadOverviewInput.parse(raw);
        const overview = await client.workThreadOverview(
          input.workThreadId,
          token,
        );
        const openTasks = overview.tasks.filter(
          (task) => task.status !== 'completed',
        );
        const lines = [
          `Thread: ${overview.workThread.title} (${overview.workThread.state})`,
          `Goal: ${overview.workThread.goal ?? '—'}`,
          `Sources: ${
            [
              ...new Set(
                overview.sessions.map((s) => s.sourceSession.sourceAgent),
              ),
            ].join(', ') || 'none'
          }`,
          `Open tasks: ${openTasks.length}; decisions: ${overview.decisions.length}; changed files: ${overview.fileActivities.length}`,
        ].join('\n');
        return { content: text(lines), structuredContent: { overview } };
      }),
  },
  {
    name: 'baton_search_context',
    title: 'Search work context',
    description:
      'Lexically search normalized evidence chunks within a project (optionally scoped to a work thread). Returns cited chunks, never a full transcript.',
    inputSchema: searchContextInput,
    inputShape: searchContextShape,
    handle: (client, token, raw) =>
      guard(async () => {
        const input = searchContextInput.parse(raw);
        const result = await client.searchRetrieval(
          {
            projectId: input.projectId,
            ...(input.workThreadId === undefined
              ? {}
              : { workThreadId: input.workThreadId }),
            query: input.query,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          token,
        );
        const lines =
          result.chunks.length === 0
            ? 'No matching evidence.'
            : result.chunks
                .map(
                  (chunk, index) =>
                    `[#${index + 1}] (${chunk.kind}) ${chunk.text} — evidence ${chunk.sourceEventIds.join(', ')}`,
                )
                .join('\n');
        return {
          content: text(lines),
          structuredContent: { chunks: result.chunks },
        };
      }),
  },
  {
    name: 'baton_get_thread_context',
    title: 'Compile thread continuation context',
    description:
      'Compile a compact, fully cited continuation context for a work thread: a bootstrap plus budgeted evidence. This is the primary way to resume a thread in a fresh agent.',
    inputSchema: threadContextInput,
    inputShape: threadContextShape,
    handle: (client, token, raw) =>
      guard(async () => {
        const input = threadContextInput.parse(raw);
        const context = await client.workThreadContext(
          input.workThreadId,
          {
            ...(input.query === undefined ? {} : { query: input.query }),
            tokenBudget: clampTokenBudget(input.tokenBudget),
          },
          token,
        );
        const body = `${context.bootstrap.text}\n\n${context.evidence.text}`;
        return { content: text(body), structuredContent: { context } };
      }),
  },
];

export const batonMcpToolsByName = new Map(
  batonMcpTools.map((tool) => [tool.name, tool]),
);

/**
 * Validate and dispatch a tool call by name. Unknown tools and invalid input
 * become structured tool errors rather than thrown exceptions, so a hostile
 * client cannot crash the server or probe for internals.
 */
export async function runBatonMcpTool(
  name: string,
  client: BatonReadClient,
  accessToken: string,
  input: unknown,
): Promise<McpToolResult> {
  const tool = batonMcpToolsByName.get(name);
  if (tool === undefined) {
    return { content: text(`Unknown tool: ${name}`), isError: true };
  }
  const parsed = tool.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      content: text('The tool input is invalid for this Baton tool.'),
      isError: true,
    };
  }
  return tool.handle(client, accessToken, parsed.data);
}
