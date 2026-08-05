import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CodexAdapter } from '@baton/adapters';

import {
  nativeSessionHash,
  pathBelongsToProject,
  sourceIdentity,
  stableBySourceId,
} from './identity.js';
import {
  JsonlEventSource,
  asString,
  isRecord,
  readJsonlMetadata,
} from './jsonl.js';
import type { ProjectBinding, SourceSessionRef } from './types.js';

export interface CodexEventSourceOptions {
  /** Usually ~/.codex/sessions. */
  sessionsDirectory: string;
}

export class CodexEventSource extends JsonlEventSource {
  readonly name = 'codex' as const;
  protected readonly adapter = new CodexAdapter();
  readonly #sessionsDirectory: string;

  constructor(options: CodexEventSourceOptions) {
    super();
    this.#sessionsDirectory = options.sessionsDirectory;
  }

  async discover(project: ProjectBinding): Promise<SourceSessionRef[]> {
    const paths = await codexSessionPaths(this.#sessionsDirectory);
    const refs: SourceSessionRef[] = [];
    for (const path of paths) {
      const metadata = await readJsonlMetadata(path, codexMetadata);
      if (
        metadata === undefined ||
        !pathBelongsToProject(project.rootPath, metadata.cwd)
      ) {
        continue;
      }
      refs.push({
        sourceId: sourceIdentity(
          this.name,
          project.projectId,
          metadata.nativeSessionId,
        ),
        nativeSessionHash: nativeSessionHash(
          this.name,
          metadata.nativeSessionId,
        ),
        projectId: project.projectId,
        agent: this.name,
        nativeSessionId: metadata.nativeSessionId,
        local: { kind: 'jsonl', path },
      });
    }
    return stableBySourceId(refs);
  }
}

async function codexSessionPaths(root: string): Promise<string[]> {
  const result: string[] = [];
  await visit(root, 0, result);
  return result.sort();
}

async function visit(
  directory: string,
  depth: number,
  result: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && depth < 3 && /^\d{2,4}$/.test(entry.name)) {
      await visit(path, depth + 1, result);
      continue;
    }
    if (
      entry.isFile() &&
      depth === 3 &&
      /^rollout-.*\.jsonl$/.test(entry.name) &&
      isDateShard(directory)
    ) {
      result.push(path);
    }
  }
}

function isDateShard(directory: string): boolean {
  const pieces = directory.split(/[\\/]/).slice(-3);
  return (
    /^\d{4}$/.test(pieces[0] ?? '') &&
    /^(0[1-9]|1[0-2])$/.test(pieces[1] ?? '') &&
    /^(0[1-9]|[12]\d|3[01])$/.test(pieces[2] ?? '')
  );
}

function codexMetadata(
  record: Record<string, unknown>,
): { nativeSessionId: string; cwd: string } | undefined {
  if (record.type !== 'session_meta' || !isRecord(record.payload)) {
    return undefined;
  }
  const nativeSessionId = asString(record.payload.id);
  const cwd = asString(record.payload.cwd);
  if (nativeSessionId === undefined || cwd === undefined) return undefined;
  return { nativeSessionId, cwd };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
