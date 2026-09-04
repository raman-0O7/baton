import { OpenCodeAdapter } from '@baton/adapters';

import {
  nativeSessionHash,
  pathBelongsToProject,
  sha256,
  sourceIdentity,
  stableBySourceId,
} from './identity.js';
import type {
  OpenCodeMessageRow,
  OpenCodePartRow,
  OpenCodeSessionSnapshot,
  OpenCodeSnapshotProvider,
} from './opencode-provider.js';
import {
  type CaptureCheckpoint,
  type EventBatch,
  type EventSource,
  type Fingerprint,
  type ProjectBinding,
  type ReadOptions,
  type ReadReason,
  type SourceSessionRef,
  assertCheckpoint,
  assertRef,
} from './types.js';

export class OpenCodeEventSource implements EventSource {
  readonly name = 'opencode' as const;
  readonly #provider: OpenCodeSnapshotProvider;
  readonly #adapter = new OpenCodeAdapter();

  get parserVersion(): string {
    return this.#adapter.formatVersion;
  }

  constructor(provider: OpenCodeSnapshotProvider) {
    this.#provider = provider;
  }

  async discover(project: ProjectBinding): Promise<SourceSessionRef[]> {
    const sessions = await this.#provider.listSessions(project.rootPath);
    return stableBySourceId(
      sessions
        .filter(({ directory }) =>
          pathBelongsToProject(project.rootPath, directory),
        )
        .map(({ nativeSessionId }) => ({
          sourceId: sourceIdentity(
            this.name,
            project.projectId,
            nativeSessionId,
          ),
          nativeSessionHash: nativeSessionHash(this.name, nativeSessionId),
          projectId: project.projectId,
          agent: this.name,
          nativeSessionId,
          local: {
            kind: 'sqlite' as const,
            databasePath: this.#provider.databasePath,
            nativeSessionId,
          },
        })),
    );
  }

  async readSince(
    ref: SourceSessionRef,
    cursor?: CaptureCheckpoint,
    options: ReadOptions = {},
  ): Promise<EventBatch> {
    assertRef(ref, this.name, 'sqlite');
    assertCheckpoint(ref, cursor);
    if (ref.local.nativeSessionId !== ref.nativeSessionId) {
      throw new TypeError(
        'opencode: local and public session identities differ',
      );
    }
    const snapshot = normalizeSnapshot(
      await this.#provider.readSession(ref.nativeSessionId),
    );
    const sql = adapterSnapshot(snapshot);
    const digest = snapshotDigest(snapshot);
    const adapterResult = this.#adapter.readSince(
      { content: sql },
      cursor?.adapter,
    );
    const physical = sqlitePhysical(snapshot, digest);
    const physicalReason = classifySqliteChange(cursor, physical);
    const reason = sqliteReadReason(
      physicalReason,
      adapterResult.mode,
      options.reason,
    );
    const generation =
      cursor === undefined
        ? 0
        : adapterResult.mode === 'replace'
          ? cursor.generation + 1
          : cursor.generation;

    return {
      sourceId: ref.sourceId,
      nativeSessionHash: ref.nativeSessionHash,
      agent: this.name,
      parserVersion: this.parserVersion,
      mode: adapterResult.mode,
      reason,
      events: adapterResult.events,
      checkpoint: {
        schemaVersion: 1,
        sourceId: ref.sourceId,
        agent: this.name,
        generation,
        adapter: adapterResult.cursor,
        physical,
        fingerprint: {
          algorithm: 'sha256',
          digest,
          extent: physical.rowCount,
        },
      },
    };
  }

  async fingerprint(ref: SourceSessionRef): Promise<Fingerprint> {
    assertRef(ref, this.name, 'sqlite');
    const snapshot = normalizeSnapshot(
      await this.#provider.readSession(ref.nativeSessionId),
    );
    return {
      algorithm: 'sha256',
      digest: snapshotDigest(snapshot),
      extent: 1 + snapshot.messages.length + snapshot.parts.length,
    };
  }
}

function normalizeSnapshot(
  snapshot: OpenCodeSessionSnapshot,
): OpenCodeSessionSnapshot {
  return {
    session: snapshot.session,
    messages: [...snapshot.messages].sort(compareNativeRows),
    parts: [...snapshot.parts].sort(compareNativeRows),
  };
}

function compareNativeRows(
  left: { id: string; timeCreated: number },
  right: { id: string; timeCreated: number },
): number {
  const byTime = left.timeCreated - right.timeCreated;
  return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
}

function sqlitePhysical(
  snapshot: OpenCodeSessionSnapshot,
  digest: string,
): Extract<CaptureCheckpoint['physical'], { kind: 'sqlite' }> {
  const finalPart = snapshot.parts.at(-1);
  return {
    kind: 'sqlite',
    rowCount: 1 + snapshot.messages.length + snapshot.parts.length,
    maxPartCreatedAt: finalPart?.timeCreated ?? null,
    maxPartId: finalPart?.id ?? null,
    contentDigest: digest,
  };
}

function classifySqliteChange(
  cursor: CaptureCheckpoint | undefined,
  current: Extract<CaptureCheckpoint['physical'], { kind: 'sqlite' }>,
): 'initial' | 'append' | 'unchanged' | 'truncation' | 'rewrite' {
  const prior = cursor?.physical;
  if (prior === undefined) return 'initial';
  if (prior.kind !== 'sqlite') return 'rewrite';
  if (current.rowCount < prior.rowCount) return 'truncation';
  if (current.rowCount === prior.rowCount) {
    return current.contentDigest === prior.contentDigest
      ? 'unchanged'
      : 'rewrite';
  }
  return 'append';
}

function sqliteReadReason(
  physical: 'initial' | 'append' | 'unchanged' | 'truncation' | 'rewrite',
  mode: 'append' | 'replace',
  requested: ReadOptions['reason'],
): ReadReason {
  if (physical === 'unchanged' && requested === 'periodic_reconciliation') {
    return 'periodic_reconciliation';
  }
  if (
    mode === 'replace' &&
    physical !== 'initial' &&
    physical !== 'truncation' &&
    physical !== 'rewrite'
  ) {
    return 'semantic_reconciliation';
  }
  return physical;
}

function snapshotDigest(snapshot: OpenCodeSessionSnapshot): string {
  return sha256(
    JSON.stringify([
      sessionValues(snapshot),
      snapshot.messages.map(messageValues),
      snapshot.parts.map(partValues),
    ]),
  );
}

/** Build the adapter's local compatibility view. It is never returned. */
function adapterSnapshot(snapshot: OpenCodeSessionSnapshot): string {
  return [
    sqlInsert(
      'session',
      'id, project_id, slug, directory, title, version, time_created, time_updated',
      [sessionValues(snapshot)],
    ),
    sqlInsert(
      'message',
      'id, session_id, time_created, time_updated, data',
      snapshot.messages.map(messageValues),
    ),
    sqlInsert(
      'part',
      'id, message_id, session_id, time_created, time_updated, data',
      snapshot.parts.map(partValues),
    ),
  ]
    .filter((statement) => statement !== '')
    .join('\n');
}

function sessionValues(
  snapshot: OpenCodeSessionSnapshot,
): Array<string | number> {
  const row = snapshot.session;
  return [
    row.id,
    row.projectId,
    row.slug,
    row.directory,
    row.title,
    row.version,
    row.timeCreated,
    row.timeUpdated,
  ];
}

function messageValues(row: OpenCodeMessageRow): Array<string | number> {
  return [row.id, row.sessionId, row.timeCreated, row.timeUpdated, row.data];
}

function partValues(row: OpenCodePartRow): Array<string | number> {
  return [
    row.id,
    row.messageId,
    row.sessionId,
    row.timeCreated,
    row.timeUpdated,
    row.data,
  ];
}

function sqlInsert(
  table: string,
  columns: string,
  rows: Array<Array<string | number>>,
): string {
  if (rows.length === 0) return '';
  return `INSERT INTO ${table} (${columns}) VALUES\n${rows
    .map((row) => `(${row.map(sqlLiteral).join(',')})`)
    .join(',\n')};`;
}

function sqlLiteral(value: string | number): string {
  return typeof value === 'number'
    ? String(value)
    : `'${value.replaceAll("'", "''")}'`;
}
