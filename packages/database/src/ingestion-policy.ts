import type {
  CollectionCategory,
  CollectionPolicy,
  SourceEvent,
} from '@baton/protocol';

import { IngestionStoreError } from './ingestion-store.js';

export function validateEventCollectionPolicy(
  event: SourceEvent,
  policy: CollectionPolicy,
): void {
  const allowed = new Set<CollectionCategory>(policy.allowedCategories);
  const requireCategory = (category: CollectionCategory): void => {
    if (!allowed.has(category)) {
      throw new IngestionStoreError(
        'consent_required',
        403,
        `The active consent does not allow ${category}.`,
      );
    }
  };

  const payload = event.payload;
  switch (payload.kind) {
    case 'message':
      requireCategory('conversation_text');
      scanText(payload.text);
      break;
    case 'task':
      requireCategory('plans_and_tasks');
      scanText(payload.text);
      break;
    case 'decision':
      requireCategory('plans_and_tasks');
      scanText(payload.summary);
      scanOptional(payload.rationale);
      break;
    case 'tool_call':
      requireCategory('command_arguments');
      scanText(payload.name);
      scanOptional(payload.inputSummary);
      break;
    case 'tool_result': {
      requireCategory('tool_results');
      const bytes = utf8Bytes(payload.outputSummary ?? '');
      if (bytes > policy.maxToolResultBytes) {
        throw payloadTooLarge('tool result', policy.maxToolResultBytes);
      }
      scanOptional(payload.outputSummary);
      break;
    }
    case 'file_change': {
      requireCategory('file_paths');
      if (matchesExcludedPath(payload.path, policy.excludedPathPatterns)) {
        throw new IngestionStoreError(
          'consent_required',
          403,
          'The active collection policy excludes an event path.',
        );
      }
      scanText(payload.path);
      scanOptional(payload.summary);
      if (payload.diff !== undefined) {
        requireCategory('diffs');
        if (utf8Bytes(payload.diff) > policy.maxDiffBytes) {
          throw payloadTooLarge('diff', policy.maxDiffBytes);
        }
        scanText(payload.diff);
      }
      break;
    }
    case 'error':
      requireCategory('tool_results');
      scanText(payload.message);
      if (payload.command !== undefined) {
        requireCategory('command_arguments');
        scanText(payload.command);
      }
      break;
    case 'session_metadata':
      requireCategory('session_metadata');
      scanOptional(payload.title);
      scanOptional(payload.model);
      scanOptional(payload.gitBranch);
      break;
  }
}

function payloadTooLarge(label: string, limit: number): IngestionStoreError {
  return new IngestionStoreError(
    'payload_too_large',
    413,
    `The normalized ${label} exceeds the consented ${limit}-byte limit.`,
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function scanOptional(value: string | undefined): void {
  if (value !== undefined) scanText(value);
}

function scanText(value: string): void {
  if (forbiddenSecretPatterns.some((pattern) => pattern.test(value))) {
    throw new IngestionStoreError(
      'invalid_request',
      400,
      'The normalized event failed the server-side secret policy.',
    );
  }
}

function matchesExcludedPath(
  path: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    if (character === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index += 1;
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'i');
}

const forbiddenSecretPatterns = [
  /\bbat_(?:at|rt|bs)_[A-Za-z0-9._-]{8,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*[^\s]{8,}/i,
];
