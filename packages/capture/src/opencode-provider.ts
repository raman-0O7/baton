import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { pathBelongsToProject } from './identity.js';

export interface OpenCodeSessionSummary {
  nativeSessionId: string;
  directory: string;
}

export interface OpenCodeSessionRow {
  id: string;
  projectId: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  timeCreated: number;
  timeUpdated: number;
}

export interface OpenCodeMessageRow {
  id: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: string;
}

export interface OpenCodePartRow {
  id: string;
  messageId: string;
  sessionId: string;
  timeCreated: number;
  timeUpdated: number;
  data: string;
}

/** One transaction's stable view of the rows used by the semantic adapter. */
export interface OpenCodeSessionSnapshot {
  session: OpenCodeSessionRow;
  messages: OpenCodeMessageRow[];
  parts: OpenCodePartRow[];
}

/** Narrow provider boundary; alternate SQLite libraries can implement this. */
export interface OpenCodeSnapshotProvider {
  readonly databasePath: string;
  listSessions(projectRoot: string): Promise<OpenCodeSessionSummary[]>;
  readSession(nativeSessionId: string): Promise<OpenCodeSessionSnapshot>;
}

export interface DatabaseSyncOpenCodeProviderOptions {
  databasePath: string;
  busyTimeoutMs?: number;
}

/**
 * Node 22's built-in SQLite reader. Every connection is read-only, extension
 * loading cannot be enabled, and session rows are read inside one transaction.
 */
export class DatabaseSyncOpenCodeProvider implements OpenCodeSnapshotProvider {
  readonly databasePath: string;
  readonly #busyTimeoutMs: number;

  constructor(options: DatabaseSyncOpenCodeProviderOptions) {
    this.databasePath = options.databasePath;
    this.#busyTimeoutMs = options.busyTimeoutMs ?? 2_000;
  }

  async listSessions(projectRoot: string): Promise<OpenCodeSessionSummary[]> {
    const database = await this.#open();
    try {
      return database
        .prepare('SELECT id, directory FROM session ORDER BY id')
        .all()
        .map((row) => ({
          nativeSessionId: requiredString(row.id, 'session.id'),
          directory: requiredString(row.directory, 'session.directory'),
        }))
        .filter(({ directory }) =>
          pathBelongsToProject(projectRoot, directory),
        );
    } finally {
      database.close();
    }
  }

  async readSession(nativeSessionId: string): Promise<OpenCodeSessionSnapshot> {
    const database = await this.#open();
    database.exec('BEGIN');
    try {
      const sessionValue = database
        .prepare(
          `SELECT id, project_id, slug, directory, title, version,
                  time_created, time_updated
             FROM session
            WHERE id = ?`,
        )
        .get(nativeSessionId);
      if (sessionValue === undefined) {
        throw new Error(
          `opencode: session ${nativeSessionId} no longer exists`,
        );
      }
      const messages = database
        .prepare(
          `SELECT id, session_id, time_created, time_updated, data
             FROM message
            WHERE session_id = ?
            ORDER BY time_created, id`,
        )
        .all(nativeSessionId)
        .map(messageRow);
      const parts = database
        .prepare(
          `SELECT id, message_id, session_id, time_created, time_updated, data
             FROM part
            WHERE session_id = ?
            ORDER BY time_created, id`,
        )
        .all(nativeSessionId)
        .map(partRow);
      database.exec('COMMIT');
      return { session: sessionRow(sessionValue), messages, parts };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.close();
    }
  }

  async #open(): Promise<DatabaseSync> {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(this.databasePath, {
      readOnly: true,
      allowExtension: false,
      enableDoubleQuotedStringLiterals: false,
      timeout: this.#busyTimeoutMs,
    });
  }
}

function sessionRow(row: Record<string, SQLOutputValue>): OpenCodeSessionRow {
  return {
    id: requiredString(row.id, 'session.id'),
    projectId: requiredString(row.project_id, 'session.project_id'),
    slug: requiredString(row.slug, 'session.slug'),
    directory: requiredString(row.directory, 'session.directory'),
    title: requiredString(row.title, 'session.title'),
    version: requiredString(row.version, 'session.version'),
    timeCreated: requiredNumber(row.time_created, 'session.time_created'),
    timeUpdated: requiredNumber(row.time_updated, 'session.time_updated'),
  };
}

function messageRow(row: Record<string, SQLOutputValue>): OpenCodeMessageRow {
  return {
    id: requiredString(row.id, 'message.id'),
    sessionId: requiredString(row.session_id, 'message.session_id'),
    timeCreated: requiredNumber(row.time_created, 'message.time_created'),
    timeUpdated: requiredNumber(row.time_updated, 'message.time_updated'),
    data: requiredString(row.data, 'message.data'),
  };
}

function partRow(row: Record<string, SQLOutputValue>): OpenCodePartRow {
  return {
    id: requiredString(row.id, 'part.id'),
    messageId: requiredString(row.message_id, 'part.message_id'),
    sessionId: requiredString(row.session_id, 'part.session_id'),
    timeCreated: requiredNumber(row.time_created, 'part.time_created'),
    timeUpdated: requiredNumber(row.time_updated, 'part.time_updated'),
    data: requiredString(row.data, 'part.data'),
  };
}

function requiredString(value: SQLOutputValue | undefined, label: string) {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text`);
  return value;
}

function requiredNumber(value: SQLOutputValue | undefined, label: string) {
  if (typeof value !== 'number')
    throw new TypeError(`${label} must be numeric`);
  return value;
}
