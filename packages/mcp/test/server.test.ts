import type {
  RetrievalResult,
  ThreadContext,
  ThreadSuggestionList,
  WorkThread,
  WorkThreadOverview,
} from '@baton/protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import type { BatonReadClient } from '../src/client.js';
import { createBatonMcpServer } from '../src/server.js';

const projectId = '018f0f90-9000-7000-8000-000000000001';
const workThreadId = '018f0f90-3000-7000-8000-000000000001';
const token = 'bat_at_secret';

const thread: WorkThread = {
  workThreadId,
  projectId,
  title: 'Implement hosted authentication',
  goal: 'Cross-agent device login',
  state: 'active',
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T12:00:00.000Z',
};

const stub: BatonReadClient = {
  async workThreads() {
    return [thread];
  },
  async suggestThreads(): Promise<ThreadSuggestionList> {
    return { sourceSessionId: null, suggestions: [] };
  },
  async workThreadOverview(): Promise<WorkThreadOverview> {
    return {
      workThread: thread,
      sessions: [],
      tasks: [],
      decisions: [],
      fileActivities: [],
      errors: [],
      eventCount: 0,
      lastActivityAt: null,
    };
  },
  async searchRetrieval(): Promise<RetrievalResult> {
    return {
      query: 'q',
      projectId,
      workThreadId: null,
      lexicalFallback: true,
      chunks: [],
    };
  },
  async approvedMemories() {
    return [];
  },
  async workThreadContext(): Promise<ThreadContext> {
    return {
      workThreadId,
      query: 'greet',
      bootstrap: {
        text: 'Work thread abc: Implement hosted authentication (active). Use the Baton MCP tools with this work thread id.',
        tokenEstimate: 20,
        citations: [],
        includedChunkIds: [],
        truncated: false,
      },
      evidence: {
        text: 'Relevant evidence:\n- Renamed Greet to Hello [#1]',
        tokenEstimate: 12,
        citations: [
          {
            marker: '#1',
            chunkId: 'chunk_abc',
            kind: 'message',
            sourceEventIds: ['018f0f90-4000-7000-8000-000000000001'],
            occurredAt: '2026-07-01T10:00:00.000Z',
          },
        ],
        includedChunkIds: ['chunk_abc'],
        truncated: false,
      },
    };
  },
};

describe('baton MCP server over a live transport', () => {
  async function connect() {
    const server = createBatonMcpServer(stub, token);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(clientTransport);
    return { client, server };
  }

  it('advertises only read tools', async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      'baton_get_approved_memories',
      'baton_get_thread_context',
      'baton_get_thread_overview',
      'baton_list_threads',
      'baton_search_context',
      'baton_suggest_threads',
    ]);
    // No write/mutation tools are exposed.
    expect(
      names.some((name) => /create|update|delete|write|ingest/.test(name)),
    ).toBe(false);
    await client.close();
    await server.close();
  });

  it('resumes a thread with cited context, not a full transcript', async () => {
    const { client, server } = await connect();
    const result = (await client.callTool({
      name: 'baton_get_thread_context',
      arguments: { workThreadId, query: 'greet', tokenBudget: 400 },
    })) as { content: Array<{ type: string; text: string }> };
    const body = result.content.map((item) => item.text).join('\n');
    expect(body).toContain('Implement hosted authentication');
    expect(body).toContain('Renamed Greet to Hello');
    expect(body).toContain('[#1]'); // citation marker present
    expect(body).not.toContain(token); // token never surfaced to the agent
    await client.close();
    await server.close();
  });

  it('validates tool input and rejects a malformed project id', async () => {
    const { client, server } = await connect();
    const result = (await client.callTool({
      name: 'baton_list_threads',
      arguments: { projectId: 'not-a-uuid' },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    await client.close();
    await server.close();
  });
});
