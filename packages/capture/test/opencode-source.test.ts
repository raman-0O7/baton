import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  DatabaseSyncOpenCodeProvider,
  OpenCodeEventSource,
  type OpenCodeSessionSnapshot,
  type OpenCodeSnapshotProvider,
} from '../src/index.js';

const projectRoot = '/home/user/project';

describe('OpenCode incremental source', () => {
  it('polls a transactional provider and preserves equal-time row IDs', async () => {
    const provider = new MutableProvider(baseSnapshot());
    const source = new OpenCodeEventSource(provider);
    const [ref] = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const initial = await source.readSince(ref!);
    expect(initial.events.map(({ key }) => key)).toEqual(['turn:0', 'turn:1']);
    expect(initial).toMatchObject({
      mode: 'replace',
      reason: 'initial',
      parserVersion: '2026-07-db',
    });
    expect(initial.nativeSessionHash).toMatch(/^[a-f0-9]{64}$/);

    provider.snapshot.parts.push(
      toolPart('prt_tool_b', 'call-b', 'read', 1_783_000_010_000),
      toolPart('prt_tool_a', 'call-a', 'bash', 1_783_000_010_000),
    );
    const appended = await source.readSince(ref!, initial.checkpoint);

    expect(appended).toMatchObject({ mode: 'append', reason: 'append' });
    expect(appended.events.map(({ key }) => key)).toEqual([
      'tool_call:0',
      'tool_result:0',
      'tool_call:1',
      'tool_result:1',
    ]);
    expect(appended.checkpoint.physical).toMatchObject({
      kind: 'sqlite',
      maxPartCreatedAt: 1_783_000_010_000,
      maxPartId: 'prt_tool_b',
    });

    const periodic = await source.readSince(ref!, appended.checkpoint, {
      reason: 'periodic_reconciliation',
    });
    expect(periodic).toMatchObject({
      mode: 'append',
      reason: 'periodic_reconciliation',
      events: [],
    });
  });

  it('detects row rewrites and truncation and emits normalized replacement events', async () => {
    const provider = new MutableProvider(baseSnapshot());
    const source = new OpenCodeEventSource(provider);
    const [ref] = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    const initial = await source.readSince(ref!);
    provider.snapshot.parts[1] = textPart(
      'prt_assistant',
      'msg_assistant',
      'Prefer os.ReadDirContext.',
      1_783_000_005_000,
    );

    const rewritten = await source.readSince(ref!, initial.checkpoint);
    expect(rewritten).toMatchObject({ mode: 'replace', reason: 'rewrite' });
    expect(rewritten.events.map(({ payload }) => payload)).toContainEqual({
      kind: 'message',
      role: 'assistant',
      text: 'Prefer os.ReadDirContext.',
    });

    provider.snapshot.parts.pop();
    const truncated = await source.readSince(ref!, rewritten.checkpoint);
    expect(truncated).toMatchObject({ mode: 'replace', reason: 'truncation' });
  });

  it('keeps native rows, database paths, and project paths out of the batch', async () => {
    const provider = new MutableProvider(baseSnapshot());
    const source = new OpenCodeEventSource(provider);
    const [ref] = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    const batch = await source.readSince(ref!);
    const encoded = JSON.stringify(batch);

    expect(encoded).not.toContain(provider.databasePath);
    expect(encoded).not.toContain(projectRoot);
    expect(encoded).not.toContain('project_id');
    expect(encoded).not.toContain('time_updated');
    expect(encoded).not.toContain('ses_capture');
  });
});

describe('DatabaseSync OpenCode provider', () => {
  it('enumerates by directory and reads one consistent, read-only snapshot', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'baton-capture-opencode-db-'),
    );
    const databasePath = join(directory, 'opencode.db');
    seedDatabase(databasePath);
    const provider = new DatabaseSyncOpenCodeProvider({ databasePath });

    await expect(provider.listSessions(projectRoot)).resolves.toEqual([
      { nativeSessionId: 'ses_capture', directory: projectRoot },
    ]);
    const snapshot = await provider.readSession('ses_capture');
    expect(snapshot.messages.map(({ id }) => id)).toEqual([
      'msg_user',
      'msg_assistant',
    ]);
    expect(snapshot.parts.map(({ id }) => id)).toEqual([
      'prt_user',
      'prt_assistant',
    ]);

    const source = new OpenCodeEventSource(provider);
    const refs = await source.discover({
      projectId: 'project-1',
      rootPath: projectRoot,
    });
    await expect(source.readSince(refs[0]!)).resolves.toMatchObject({
      agent: 'opencode',
      mode: 'replace',
    });
  });
});

class MutableProvider implements OpenCodeSnapshotProvider {
  readonly databasePath = '/private/local/opencode.db';

  constructor(public snapshot: OpenCodeSessionSnapshot) {}

  async listSessions(root: string) {
    return this.snapshot.session.directory === root
      ? [
          {
            nativeSessionId: this.snapshot.session.id,
            directory: this.snapshot.session.directory,
          },
        ]
      : [];
  }

  async readSession(nativeSessionId: string) {
    if (nativeSessionId !== this.snapshot.session.id) {
      throw new Error('unknown test session');
    }
    return structuredClone(this.snapshot);
  }
}

function baseSnapshot(): OpenCodeSessionSnapshot {
  return {
    session: {
      id: 'ses_capture',
      projectId: 'prj_local',
      slug: 'capture',
      directory: projectRoot,
      title: 'Capture fixture',
      version: '1.2.3',
      timeCreated: 1_783_000_000_000,
      timeUpdated: 1_783_000_006_000,
    },
    messages: [
      {
        id: 'msg_user',
        sessionId: 'ses_capture',
        timeCreated: 1_783_000_001_000,
        timeUpdated: 1_783_000_001_000,
        data: JSON.stringify({ role: 'user' }),
      },
      {
        id: 'msg_assistant',
        sessionId: 'ses_capture',
        timeCreated: 1_783_000_005_000,
        timeUpdated: 1_783_000_006_000,
        data: JSON.stringify({ role: 'assistant' }),
      },
    ],
    parts: [
      textPart(
        'prt_user',
        'msg_user',
        'How do I list files?',
        1_783_000_001_000,
      ),
      textPart(
        'prt_assistant',
        'msg_assistant',
        'Use os.ReadDir.',
        1_783_000_005_000,
      ),
    ],
  };
}

function textPart(
  id: string,
  messageId: string,
  text: string,
  timeCreated: number,
) {
  return {
    id,
    messageId,
    sessionId: 'ses_capture',
    timeCreated,
    timeUpdated: timeCreated,
    data: JSON.stringify({
      type: 'text',
      text,
      time: { start: timeCreated, end: timeCreated },
    }),
  };
}

function toolPart(
  id: string,
  callID: string,
  tool: string,
  timeCreated: number,
) {
  return {
    id,
    messageId: 'msg_assistant',
    sessionId: 'ses_capture',
    timeCreated,
    timeUpdated: timeCreated,
    data: JSON.stringify({
      type: 'tool',
      callID,
      tool,
      state: { status: 'completed', input: {}, output: 'ok' },
      time: { start: timeCreated, end: timeCreated },
    }),
  };
}

function seedDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath, { allowExtension: false });
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, slug TEXT, directory TEXT,
      title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
    INSERT INTO session VALUES
      ('ses_capture', 'prj_local', 'capture', '${projectRoot}',
       'Capture fixture', '1.2.3', 1783000000000, 1783000006000),
      ('ses_other', 'prj_local', 'other', '/home/other/project',
       'Other fixture', '1.2.3', 1783000000000, 1783000006000);
    INSERT INTO message VALUES
      ('msg_user', 'ses_capture', 1783000001000, 1783000001000,
       '{"role":"user"}'),
      ('msg_assistant', 'ses_capture', 1783000005000, 1783000006000,
       '{"role":"assistant"}');
    INSERT INTO part VALUES
      ('prt_user', 'msg_user', 'ses_capture', 1783000001000, 1783000001000,
       '{"type":"text","text":"How do I list files?","time":{"start":1783000001000}}'),
      ('prt_assistant', 'msg_assistant', 'ses_capture', 1783000005000, 1783000006000,
       '{"type":"text","text":"Use os.ReadDir.","time":{"start":1783000005000}}');
  `);
  database.close();
}
