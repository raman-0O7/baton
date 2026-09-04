import { Buffer } from 'node:buffer';

import type {
  CollectionCategory,
  CollectionPolicy,
  SourceEventInput,
  SourceEventPayload,
} from '@baton/protocol';

export interface PolicyApplication {
  events: SourceEventInput[];
  excludedEvents: number;
  omittedFields: number;
}

/** Apply the allowlist and caps to normalized events before local scrubbing. */
export function applyCollectionPolicy(
  input: readonly SourceEventInput[],
  policy: CollectionPolicy,
): PolicyApplication {
  const allowed = new Set<CollectionCategory>(policy.allowedCategories);
  const events: SourceEventInput[] = [];
  let excludedEvents = 0;
  let omittedFields = 0;

  for (const event of input) {
    const filtered = filterPayload(event.payload, policy, allowed);
    if (filtered === null) {
      excludedEvents += 1;
      continue;
    }
    omittedFields += filtered.omittedFields;
    events.push({ ...event, payload: filtered.payload });
  }

  return { events, excludedEvents, omittedFields };
}

function filterPayload(
  payload: SourceEventPayload,
  policy: CollectionPolicy,
  allowed: ReadonlySet<CollectionCategory>,
): { payload: SourceEventPayload; omittedFields: number } | null {
  switch (payload.kind) {
    case 'message':
      return has(allowed, 'conversation_text')
        ? { payload, omittedFields: 0 }
        : null;
    case 'task':
    case 'decision':
      return has(allowed, 'plans_and_tasks')
        ? { payload, omittedFields: 0 }
        : null;
    case 'tool_call':
      return has(allowed, 'command_arguments')
        ? { payload, omittedFields: 0 }
        : null;
    case 'tool_result': {
      if (!has(allowed, 'tool_results')) return null;
      if (
        payload.outputSummary !== undefined &&
        byteLength(payload.outputSummary) > policy.maxToolResultBytes
      ) {
        return {
          payload: {
            kind: 'tool_result',
            toolCallId: payload.toolCallId,
            isError: payload.isError,
          },
          omittedFields: 1,
        };
      }
      return { payload, omittedFields: 0 };
    }
    case 'error': {
      if (!has(allowed, 'tool_results')) return null;
      if (byteLength(payload.message) > policy.maxToolResultBytes) return null;
      if (
        payload.command !== undefined &&
        byteLength(payload.command) > policy.maxToolResultBytes
      ) {
        return {
          payload: { kind: 'error', message: payload.message },
          omittedFields: 1,
        };
      }
      return { payload, omittedFields: 0 };
    }
    case 'file_change': {
      if (
        !has(allowed, 'file_paths') ||
        policy.excludedPathPatterns.some((pattern) =>
          matchesPathPattern(payload.path, pattern),
        )
      ) {
        return null;
      }
      const includeDiff =
        payload.diff !== undefined &&
        has(allowed, 'diffs') &&
        byteLength(payload.diff) <= policy.maxDiffBytes;
      const omittedFields = payload.diff !== undefined && !includeDiff ? 1 : 0;
      return {
        payload: {
          kind: 'file_change',
          path: payload.path,
          operation: payload.operation,
          ...(includeDiff ? { diff: payload.diff } : {}),
          ...(payload.summary === undefined
            ? {}
            : { summary: payload.summary }),
        },
        omittedFields,
      };
    }
    case 'session_metadata':
      return has(allowed, 'session_metadata')
        ? { payload, omittedFields: 0 }
        : null;
  }
}

export function matchesPathPattern(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedPattern = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  return globExpression(normalizedPattern).test(normalizedPath);
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`);
}

function escapeRegExp(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function has(
  allowed: ReadonlySet<CollectionCategory>,
  category: CollectionCategory,
): boolean {
  return allowed.has(category);
}
