import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { SourceSessionIdentitySchema } from '@baton/protocol';

import {
  CheckpointMismatchError,
  ClaudeCodeEventSource,
  CodexEventSource,
  ReconciliationSchedule,
  claudeProjectSlug,
  decodeCaptureCheckpoint,
  encodeCaptureCheckpoint,
  reconcileDue,
} from '../src/index.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

describe('Claude Code source discovery', () => {
  it('implements Claude path slugs including UTF-16 replacement and long hashes', () => {
    expect(claudeProjectSlug('/Users/x/my.app_v2')).toBe('-Users-x-my-app-v2');
    expect(claudeProjectSlug('/x/😀')).toBe('-x---');
    const longPath = `/${'long.segment/'.repeat(30)}`;
    const slug = claudeProjectSlug(longPath);
    expect(slug).toHaveLength(200 + 1 + slug.split('-').at(-1)!.length);
    expect(slug.slice(0, 200)).toBe(
      longPath.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200),
    );
  });

  it('enumerates only top-level JSONL sessions whose native cwd belongs to the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-claude-'));
    const projectRoot = '/home/user/project';
    const nativeDirectory = join(root, claudeProjectSlug(projectRoot));
    await mkdir(join(nativeDirectory, 'native-session', 'subagents'), {
      recursive: true,
    });
    const fixture = await fixtureText(
      'testdata/fixtures/claudecode/2026-07/session-basic.jsonl',
    );
    await Promise.all([
      writeFile(join(nativeDirectory, 'native-session.jsonl'), fixture),
      writeFile(
        join(nativeDirectory, 'native-session', 'subagents', 'agent-x.jsonl'),
        fixture,
      ),
      writeFile(join(nativeDirectory, 'notes.txt'), fixture),
      writeFile(
        join(nativeDirectory, 'collision.jsonl'),
        fixture.replaceAll('/home/user/project', '/home/other/project'),
      ),
    ]);

    const source = new ClaudeCodeEventSource({ projectsDirectory: root });
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      agent: 'claudecode',
      nativeSessionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      local: {
        kind: 'jsonl',
        path: join(nativeDirectory, 'native-session.jsonl'),
      },
    });
  });
});

describe('incremental JSONL capture', () => {
  it('checkpoints Claude appends and detects truncation and rewrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-claude-flow-'));
    const projectRoot = '/home/user/project';
    const directory = join(root, claudeProjectSlug(projectRoot));
    const path = join(directory, 'session.jsonl');
    await mkdir(directory, { recursive: true });
    const native = await fixtureText(
      'testdata/fixtures/claudecode/2026-07/session-basic.jsonl',
    );
    await writeFile(path, firstLines(native, 7));
    const source = new ClaudeCodeEventSource({ projectsDirectory: root });
    const [ref] = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    expect(ref).toBeDefined();

    const first = await source.readSince(ref!);
    expect(first).toMatchObject({
      mode: 'replace',
      reason: 'initial',
    });
    expect(first.events.map(({ key }) => key)).toEqual(['turn:0', 'turn:1']);
    expect(
      SourceSessionIdentitySchema.parse({
        sourceSessionId: first.sourceId,
        agent: first.agent,
        nativeSessionHash: first.nativeSessionHash,
        parserVersion: first.parserVersion,
      }),
    ).toBeDefined();
    const encodedCheckpoint = encodeCaptureCheckpoint(first.checkpoint);
    expect(encodedCheckpoint.length).toBeLessThanOrEqual(2_048);
    expect(decodeCaptureCheckpoint(encodedCheckpoint)).toEqual(
      first.checkpoint,
    );
    expect(() => decodeCaptureCheckpoint('cap:v1:e30')).toThrow(TypeError);

    await writeFile(path, firstLines(native, 11));
    const appended = await source.readSince(ref!, first.checkpoint);
    expect(appended).toMatchObject({ mode: 'append', reason: 'append' });
    expect(appended.events.map(({ key }) => key)).toEqual(['turn:2', 'turn:3']);

    const periodic = await source.readSince(ref!, appended.checkpoint, {
      reason: 'periodic_reconciliation',
    });
    expect(periodic).toMatchObject({
      mode: 'append',
      reason: 'periodic_reconciliation',
      events: [],
    });

    await writeFile(path, firstLines(native, 7));
    const truncated = await source.readSince(ref!, periodic.checkpoint);
    expect(truncated).toMatchObject({ mode: 'replace', reason: 'truncation' });
    expect(truncated.checkpoint.generation).toBe(1);

    const replacement = `${(
      await fixtureText(
        'testdata/hosted/adapters/specimens/claudecode-rewrite-after.jsonl',
      )
    ).replaceAll(
      '/workspace/synthetic-project',
      projectRoot,
    )}${' '.repeat(native.length)}`;
    await writeFile(path, replacement);
    const rewritten = await source.readSince(ref!, truncated.checkpoint);
    expect(rewritten).toMatchObject({ mode: 'replace', reason: 'rewrite' });
    expect(rewritten.events.map(({ payload }) => payload)).toContainEqual({
      kind: 'message',
      role: 'assistant',
      text: 'Use pgxpool.',
    });
  });

  it('rejects a checkpoint from another local source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-mismatch-'));
    const projectRoot = '/home/user/project';
    const directory = join(root, claudeProjectSlug(projectRoot));
    await mkdir(directory, { recursive: true });
    const native = await fixtureText(
      'testdata/fixtures/claudecode/2026-07/session-basic.jsonl',
    );
    await writeFile(join(directory, 'one.jsonl'), native);
    const second = native.replaceAll(
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
      'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    );
    await writeFile(join(directory, 'two.jsonl'), second);
    const source = new ClaudeCodeEventSource({ projectsDirectory: root });
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    const first = await source.readSince(refs[0]!);

    await expect(
      source.readSince(refs[1]!, first.checkpoint),
    ).rejects.toBeInstanceOf(CheckpointMismatchError);
  });
});

describe('Codex discovery and capture', () => {
  it('filters date-sharded rollouts by session_meta cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-codex-'));
    const shard = join(root, '2026', '07', '09');
    await mkdir(shard, { recursive: true });
    const native = await fixtureText(
      'testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T10-00-00-aaaa1111-bbbb-4ccc-8ddd-eeee00000001.jsonl',
    );
    await Promise.all([
      writeFile(join(shard, 'rollout-valid.jsonl'), native),
      writeFile(
        join(shard, 'rollout-other.jsonl'),
        native.replaceAll('/home/user/project', '/home/other/project'),
      ),
      writeFile(join(root, 'rollout-not-sharded.jsonl'), native),
      writeFile(join(shard, 'other.jsonl'), native),
    ]);
    const source = new CodexEventSource({ sessionsDirectory: root });
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: '/home/user/project',
    });

    expect(refs).toHaveLength(1);
    const first = await source.readSince(refs[0]!);
    const repeated = await source.readSince(refs[0]!);
    expect(first.events).toEqual(repeated.events);
    expect(first.checkpoint).toEqual(repeated.checkpoint);
    expect(JSON.stringify(first)).not.toContain('/home/user/project');
    expect(JSON.stringify(first)).not.toContain('cli_version');
    expect(JSON.stringify(first)).not.toContain('originator');
  });

  it('emits only newly appended Codex semantics from a physical extension', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-codex-flow-'));
    const shard = join(root, '2026', '07', '09');
    await mkdir(shard, { recursive: true });
    const native = await fixtureText(
      'testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T11-00-00-bbbb2222-cccc-4ddd-8eee-ffff00000002.jsonl',
    );
    const path = join(shard, 'rollout-flow.jsonl');
    await writeFile(path, firstLines(native, 3));
    const source = new CodexEventSource({ sessionsDirectory: root });
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: '/home/user/project',
    });
    const initial = await source.readSince(refs[0]!);
    await writeFile(path, native);

    const appended = await source.readSince(refs[0]!, initial.checkpoint);
    expect(appended).toMatchObject({ mode: 'append', reason: 'append' });
    expect(new Set(appended.events.map(({ key }) => key))).toEqual(
      new Set(['turn:2', 'tool_call:0', 'tool_result:0', 'file_op:0']),
    );
  });

  it('runs periodic reconciliation even without a watch notification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-capture-reconcile-'));
    const shard = join(root, '2026', '07', '09');
    await mkdir(shard, { recursive: true });
    const native = await fixtureText(
      'testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T10-00-00-aaaa1111-bbbb-4ccc-8ddd-eeee00000001.jsonl',
    );
    await writeFile(join(shard, 'rollout-valid.jsonl'), native);
    const source = new CodexEventSource({ sessionsDirectory: root });
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: '/home/user/project',
    });
    const initial = await source.readSince(refs[0]!);
    const checkpoints = new Map([[refs[0]!.sourceId, initial.checkpoint]]);
    const schedule = new ReconciliationSchedule({ intervalMs: 30_000 });

    const firstPass = await reconcileDue(
      source,
      refs,
      checkpoints,
      schedule,
      100_000,
    );
    expect(firstPass[0]?.reason).toBe('periodic_reconciliation');
    expect(
      await reconcileDue(source, refs, checkpoints, schedule, 120_000),
    ).toEqual([]);
    expect(
      await reconcileDue(source, refs, checkpoints, schedule, 130_000),
    ).toHaveLength(1);
  });
});

async function fixtureText(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), 'utf8');
}

function firstLines(content: string, count: number): string {
  return `${content.split('\n').slice(0, count).join('\n')}\n`;
}
