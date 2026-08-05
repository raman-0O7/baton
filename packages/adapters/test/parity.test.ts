import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SourceEventSchema } from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  ClaudeCodeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  adapterFor,
  materializeSourceEvent,
  type AdapterEvent,
} from '../src/index.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

interface Manifest {
  fixtures: Array<{
    id: string;
    agent: 'claudecode' | 'codex' | 'opencode';
    nativeFixture: string;
  }>;
}

interface ExpectedCorpus {
  cases: Array<{
    id: string;
    events: Array<Omit<AdapterEvent, 'identity'>>;
  }>;
}

async function jsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')) as T;
}

function publicSemantics(event: AdapterEvent): Omit<AdapterEvent, 'identity'> {
  const { identity: _identity, ...semantics } = event;
  return semantics;
}

describe('adapter parity corpus', () => {
  it('maps all six pinned native fixtures to the locked semantic events', async () => {
    const [manifest, expected] = await Promise.all([
      jsonFile<Manifest>('testdata/hosted/adapters/manifest-v1.json'),
      jsonFile<ExpectedCorpus>(
        'testdata/hosted/adapters/expected-events-v1.json',
      ),
    ]);

    for (const fixture of manifest.fixtures) {
      const native = await readFile(
        resolve(repositoryRoot, fixture.nativeFixture),
        'utf8',
      );
      const expectedCase = expected.cases.find(({ id }) => id === fixture.id);
      expect(expectedCase, fixture.id).toBeDefined();
      const result = adapterFor(fixture.agent).readSince({ content: native });

      expect(result.mode, fixture.id).toBe('replace');
      expect(result.events.map(publicSemantics), fixture.id).toEqual(
        expectedCase!.events,
      );
    }
  });

  it('materializes adapter semantics into a validated canonical event', () => {
    const event = materializeSourceEvent(
      {
        key: 'turn:0',
        identity: 'codex:message:line:2',
        occurredAt: '2026-08-01T10:00:00Z',
        sourcePointer: '/turns/0',
        nativeLocator: { line: 2 },
        payload: { kind: 'message', role: 'user', text: 'Continue Baton.' },
      },
      {
        sourceSessionId: '018f0f90-1111-7111-8111-111111111111',
        workThreadId: null,
        sourceDeviceId: '018f0f90-2222-7222-8222-222222222222',
        sourceAgent: 'codex',
        observedAt: '2026-08-01T10:00:01Z',
      },
    );

    expect(SourceEventSchema.safeParse(event).success).toBe(true);
  });
});

describe('incremental adapter convergence', () => {
  it('emits only appended Claude Code semantic events', async () => {
    const adapter = new ClaudeCodeAdapter();
    const content = await readFile(
      resolve(
        repositoryRoot,
        'testdata/fixtures/claudecode/2026-07/session-basic.jsonl',
      ),
      'utf8',
    );
    const first = adapter.readSince({ content: firstLines(content, 7) });
    const second = adapter.readSince(
      { content: firstLines(content, 11) },
      first.cursor,
    );

    expect(first.events.map(({ key }) => key)).toEqual(['turn:0', 'turn:1']);
    expect(second.mode).toBe('append');
    expect(second.events.map(({ key }) => key)).toEqual(['turn:2', 'turn:3']);
    expect(second.snapshotEvents).toEqual(adapter.parseSnapshot({ content }));
  });

  it('converges Codex appends even when projection groups event kinds', async () => {
    const adapter = new CodexAdapter();
    const content = await readFile(
      resolve(
        repositoryRoot,
        'testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T11-00-00-bbbb2222-cccc-4ddd-8eee-ffff00000002.jsonl',
      ),
      'utf8',
    );
    const first = adapter.readSince({ content: firstLines(content, 3) });
    const second = adapter.readSince({ content }, first.cursor);

    expect(second.mode).toBe('append');
    expect(new Set(second.events.map(({ key }) => key))).toEqual(
      new Set(['turn:2', 'tool_call:0', 'tool_result:0', 'file_op:0']),
    );
    expect(second.snapshotEvents).toEqual(adapter.parseSnapshot({ content }));
  });

  it('does not acknowledge an incomplete JSONL record', async () => {
    const adapter = new CodexAdapter();
    const content = await readFile(
      resolve(
        repositoryRoot,
        'testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T10-00-00-aaaa1111-bbbb-4ccc-8ddd-eeee00000001.jsonl',
      ),
      'utf8',
    );
    const lines = content.split('\n');
    const before = adapter.readSince({ content: firstLines(content, 4) });
    const partialAssistant = `${lines.slice(0, 4).join('\n')}\n${lines[4]!.slice(0, lines[4]!.indexOf('Use os.ReadDir') + 14)}`;
    const partial = adapter.readSince(
      { content: partialAssistant },
      before.cursor,
    );
    const completed = adapter.readSince(
      { content: firstLines(content, 5) },
      partial.cursor,
    );

    expect(partial.mode).toBe('append');
    expect(partial.events).toEqual([]);
    expect(completed.events.map(({ key }) => key)).toEqual(['turn:1']);
  });

  it('uses one OpenCode row snapshot and does not skip equal-time IDs', async () => {
    const adapter = new OpenCodeAdapter();
    const content = await readFile(
      resolve(
        repositoryRoot,
        'testdata/fixtures/opencode/2026-07-db/session-tools.sql',
      ),
      'utf8',
    );
    const first = adapter.readSince({
      content,
      visibleNativeIds: new Set(['prt_t1a', 'prt_t2a']),
    });
    const second = adapter.readSince(
      {
        content,
        visibleNativeIds: new Set(['prt_t1a', 'prt_t2a', 'prt_t2b', 'prt_t2c']),
      },
      first.cursor,
    );

    expect(first.events.map(({ key }) => key)).toEqual(['turn:0', 'turn:1']);
    expect(second.mode).toBe('append');
    expect(new Set(second.events.map(({ key }) => key))).toEqual(
      new Set([
        'tool_call:0',
        'tool_result:0',
        'file_op:0',
        'tool_call:1',
        'tool_result:1',
      ]),
    );
  });

  it('detects a truncation/rewrite and replaces stale semantics', async () => {
    const adapter = new ClaudeCodeAdapter();
    const [beforeContent, afterContent] = await Promise.all([
      readFile(
        resolve(
          repositoryRoot,
          'testdata/hosted/adapters/specimens/claudecode-rewrite-before.jsonl',
        ),
        'utf8',
      ),
      readFile(
        resolve(
          repositoryRoot,
          'testdata/hosted/adapters/specimens/claudecode-rewrite-after.jsonl',
        ),
        'utf8',
      ),
    ]);
    const before = adapter.readSince({ content: beforeContent });
    const after = adapter.readSince({ content: afterContent }, before.cursor);

    expect(after.mode).toBe('replace');
    expect(after.events.map(({ payload }) => payload)).toContainEqual({
      kind: 'message',
      role: 'assistant',
      text: 'Use pgxpool.',
    });
    expect(after.events.map(({ payload }) => payload)).not.toContainEqual({
      kind: 'message',
      role: 'assistant',
      text: 'Use database/sql.',
    });
  });
});

function firstLines(content: string, count: number): string {
  return `${content.split('\n').slice(0, count).join('\n')}\n`;
}
