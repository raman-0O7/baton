import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ClaudeCodeAdapter } from '@baton/adapters';

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

export interface ClaudeCodeEventSourceOptions {
  /** Usually ~/.claude/projects. */
  projectsDirectory: string;
}

export class ClaudeCodeEventSource extends JsonlEventSource {
  readonly name = 'claudecode' as const;
  protected readonly adapter = new ClaudeCodeAdapter();
  readonly #projectsDirectory: string;

  constructor(options: ClaudeCodeEventSourceOptions) {
    super();
    this.#projectsDirectory = options.projectsDirectory;
  }

  async discover(project: ProjectBinding): Promise<SourceSessionRef[]> {
    const directory = join(
      this.#projectsDirectory,
      claudeProjectSlug(project.rootPath),
    );
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }

    const refs: SourceSessionRef[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const path = join(directory, entry.name);
      const metadata = await readJsonlMetadata(path, claudeMetadata);
      if (
        metadata === undefined ||
        !pathBelongsToProject(project.rootPath, metadata.cwd)
      ) {
        continue;
      }
      const nativeSessionId =
        metadata.nativeSessionId || basename(entry.name, '.jsonl');
      refs.push({
        sourceId: sourceIdentity(this.name, project.projectId, nativeSessionId),
        nativeSessionHash: nativeSessionHash(this.name, nativeSessionId),
        projectId: project.projectId,
        agent: this.name,
        nativeSessionId,
        local: { kind: 'jsonl', path },
      });
    }
    return stableBySourceId(refs);
  }
}

/** Claude's path slug implementation, including its UTF-16 31-hash suffix. */
export function claudeProjectSlug(projectPath: string): string {
  const slug = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let index = 0; index < projectPath.length; index += 1) {
    hash = (Math.imul(hash, 31) + projectPath.charCodeAt(index)) | 0;
  }
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

function claudeMetadata(
  record: Record<string, unknown>,
): { nativeSessionId: string; cwd: string } | undefined {
  const type = asString(record.type);
  if (type !== 'user' && type !== 'assistant' && type !== 'system') {
    return undefined;
  }
  if (!isRecord(record.message)) return undefined;
  const nativeSessionId = asString(record.sessionId);
  const cwd = asString(record.cwd);
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
