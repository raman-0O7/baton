import { relative } from 'node:path';

import type { SourceEventPayload } from '@baton/protocol';

import {
  completeJsonLines,
  isRecord,
  parseJsonRecord,
  stringField,
} from './jsonl.js';
import {
  type AdapterEvent,
  type NativeLocator,
  type NativeSnapshot,
  SnapshotAdapter,
  UnknownFormatError,
  jsonSummary,
  normalizeTimestamp,
} from './types.js';

interface MutableTurn {
  key: string;
  identity: string;
  occurredAt: string;
  sourcePointer: string;
  nativeLocator: NativeLocator;
  role: 'user' | 'assistant' | 'system';
  text: string;
}

interface ToolState {
  index: number;
  name: string;
  input: Record<string, unknown>;
  occurredAt: string;
  callLine: number;
}

export class ClaudeCodeAdapter extends SnapshotAdapter {
  readonly name = 'claudecode' as const;
  readonly formatVersion = '2026-07';

  parseSnapshot(snapshot: NativeSnapshot): AdapterEvent[] {
    const lines = completeJsonLines(snapshot.content);
    const turns: MutableTurn[] = [];
    const toolCalls: AdapterEvent[] = [];
    const toolResults: AdapterEvent[] = [];
    const fileChanges: AdapterEvent[] = [];
    const tasks: AdapterEvent[] = [];
    const toolStates = new Map<string, ToolState>();
    let recognized = 0;
    let cwd = '';
    let turnIndex = 0;
    let lastAssistantMessageId: string | undefined;
    let lastAssistantTurn: MutableTurn | undefined;

    for (const [zeroIndex, encoded] of lines.entries()) {
      const line = zeroIndex + 1;
      const record = parseJsonRecord(encoded);
      if (record === null) continue;
      const type = stringField(record, 'type');
      if (type === undefined) continue;
      if (
        ![
          'user',
          'assistant',
          'system',
          'summary',
          'ai-title',
          'last-prompt',
          'mode',
          'permission-mode',
          'attachment',
          'file-history-snapshot',
        ].includes(type)
      ) {
        continue;
      }
      recognized += 1;
      cwd ||= stringField(record, 'cwd') ?? '';
      if (type !== 'user' && type !== 'assistant' && type !== 'system') {
        continue;
      }
      if (record.isSidechain === true || record.isMeta === true) continue;
      const message = record.message;
      if (!isRecord(message)) continue;
      const timestamp = stringField(record, 'timestamp');
      if (timestamp === undefined) continue;
      const occurredAt = normalizeTimestamp(timestamp);
      const nativeRecordId = stringField(record, 'uuid') ?? `line:${line}`;
      const role = stringField(message, 'role');
      const content = message.content;

      if (type === 'user' && role === 'user' && typeof content === 'string') {
        turns.push({
          key: `turn:${turnIndex}`,
          identity: `claudecode:message:${nativeRecordId}`,
          occurredAt,
          sourcePointer: `/turns/${turnIndex}`,
          nativeLocator: { line, nativeId: nativeRecordId },
          role: 'user',
          text: content,
        });
        turnIndex += 1;
        lastAssistantMessageId = undefined;
        lastAssistantTurn = undefined;
        continue;
      }

      const blocks = Array.isArray(content)
        ? content.filter(isRecord)
        : typeof content === 'string'
          ? [{ type: 'text', text: content }]
          : [];

      if (type === 'assistant' && role === 'assistant') {
        const messageId = stringField(message, 'id') ?? nativeRecordId;
        if (messageId !== lastAssistantMessageId || !lastAssistantTurn) {
          lastAssistantTurn = {
            key: `turn:${turnIndex}`,
            identity: `claudecode:assistant:${messageId}`,
            occurredAt,
            sourcePointer: `/turns/${turnIndex}`,
            nativeLocator: { line, nativeId: nativeRecordId },
            role: 'assistant',
            text: '',
          };
          turns.push(lastAssistantTurn);
          turnIndex += 1;
          lastAssistantMessageId = messageId;
        }

        for (const block of blocks) {
          const blockType = stringField(block, 'type');
          if (blockType === 'text') {
            const text = stringField(block, 'text') ?? '';
            if (text !== '') {
              lastAssistantTurn.text += text;
              lastAssistantTurn.occurredAt = occurredAt;
              lastAssistantTurn.nativeLocator = {
                line,
                nativeId: nativeRecordId,
              };
            }
          }
          if (blockType !== 'tool_use') continue;
          const toolCallId = stringField(block, 'id');
          const name = stringField(block, 'name');
          if (toolCallId === undefined || name === undefined) continue;
          const input = isRecord(block.input) ? block.input : {};
          const index = toolCalls.length;
          toolStates.set(toolCallId, {
            index,
            name,
            input,
            occurredAt,
            callLine: line,
          });
          toolCalls.push({
            key: `tool_call:${index}`,
            identity: `claudecode:tool-call:${toolCallId}`,
            occurredAt,
            sourcePointer: `/tool_calls/${index}`,
            nativeLocator: { line, nativeId: toolCallId },
            payload: {
              kind: 'tool_call',
              toolCallId,
              name,
              inputSummary: claudeInputSummary(name, input),
            },
          });

          if (name === 'TodoWrite' && Array.isArray(input.todos)) {
            for (const todo of input.todos.filter(isRecord)) {
              const text = stringField(todo, 'content');
              const status = normalizeTaskStatus(stringField(todo, 'status'));
              if (text === undefined || status === undefined) continue;
              const taskIndex = tasks.length;
              tasks.push({
                key: `todo:${taskIndex}`,
                identity: `claudecode:task:${toolCallId}:${taskIndex}`,
                occurredAt,
                sourcePointer: `/todos/${taskIndex}`,
                nativeLocator: { line, nativeId: toolCallId },
                payload: { kind: 'task', text, status },
              });
            }
          }
        }
        continue;
      }

      if (type === 'user') {
        for (const block of blocks) {
          if (stringField(block, 'type') !== 'tool_result') continue;
          const toolCallId = stringField(block, 'tool_use_id');
          if (toolCallId === undefined) continue;
          const state = toolStates.get(toolCallId);
          if (state === undefined) continue;
          const output = summarizeToolResult(block.content);
          toolResults.push({
            key: `tool_result:${state.index}`,
            identity: `claudecode:tool-result:${nativeRecordId}:${toolCallId}`,
            occurredAt: state.occurredAt,
            sourcePointer: `/tool_calls/${state.index}`,
            nativeLocator: { line, nativeId: toolCallId },
            payload: {
              kind: 'tool_result',
              toolCallId,
              outputSummary: output,
              isError: false,
            },
          });

          const fileChange = claudeFileChange(
            state,
            record.toolUseResult,
            cwd,
            line,
            toolCallId,
            fileChanges.length,
          );
          if (fileChange !== undefined) fileChanges.push(fileChange);
        }
      }
    }

    if (recognized === 0) throw new UnknownFormatError(this.name);

    return [
      ...turns
        .filter((turn) => turn.text !== '')
        .map(({ role, text, ...event }) => ({
          ...event,
          payload: { kind: 'message', role, text } as SourceEventPayload,
        })),
      ...interleaveToolActivity(toolCalls, toolResults),
      ...fileChanges,
      ...tasks,
    ];
  }
}

function interleaveToolActivity(
  calls: AdapterEvent[],
  results: AdapterEvent[],
): AdapterEvent[] {
  const resultByKey = new Map(
    results.map((result) => [result.key.replace('tool_result:', ''), result]),
  );
  return calls.flatMap((call) => {
    const index = call.key.replace('tool_call:', '');
    const result = resultByKey.get(index);
    return result === undefined ? [call] : [call, result];
  });
}

function claudeInputSummary(
  name: string,
  input: Record<string, unknown>,
): string {
  if (name === 'Write' || name === 'Edit') {
    return stringField(input, 'file_path') ?? jsonSummary(input);
  }
  return jsonSummary(input);
}

function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content))
    return content === undefined ? '' : jsonSummary(content);
  return content
    .filter(isRecord)
    .map((block) => stringField(block, 'text') ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

function normalizeTaskStatus(
  status: string | undefined,
): 'pending' | 'in_progress' | 'completed' | undefined {
  if (
    status === 'pending' ||
    status === 'in_progress' ||
    status === 'completed'
  ) {
    return status;
  }
  return undefined;
}

function projectRelative(path: string, cwd: string): string {
  if (cwd === '' || !path.startsWith('/')) return path;
  const candidate = relative(cwd, path);
  return candidate.startsWith('..') ? path : candidate;
}

function claudeFileChange(
  state: ToolState,
  rawResult: unknown,
  cwd: string,
  line: number,
  toolCallId: string,
  index: number,
): AdapterEvent | undefined {
  if (!isRecord(rawResult)) return undefined;
  const path =
    stringField(rawResult, 'filePath') ?? stringField(state.input, 'file_path');
  if (path === undefined) return undefined;
  const locator = { line, nativeId: toolCallId };

  if (state.name === 'Write') {
    const content = stringField(rawResult, 'content') ?? '';
    return {
      key: `file_op:${index}`,
      identity: `claudecode:file-change:${toolCallId}`,
      occurredAt: state.occurredAt,
      sourcePointer: `/file_ops/${index}`,
      nativeLocator: locator,
      payload: {
        kind: 'file_change',
        path: projectRelative(path, cwd),
        operation: 'create',
        summary: `wrote ${Buffer.byteLength(content)} bytes`,
      },
    };
  }

  if (state.name === 'Edit') {
    const oldString = stringField(rawResult, 'oldString') ?? '';
    const newString = stringField(rawResult, 'newString') ?? '';
    const relativePath = projectRelative(path, cwd);
    return {
      key: `file_op:${index}`,
      identity: `claudecode:file-change:${toolCallId}`,
      occurredAt: state.occurredAt,
      sourcePointer: `/file_ops/${index}`,
      nativeLocator: locator,
      payload: {
        kind: 'file_change',
        path: relativePath,
        operation: 'edit',
        diff: `--- a/${relativePath}\n+++ b/${relativePath}\n-${oldString}\n+${newString}\n`,
        summary: `replaced ${Buffer.byteLength(oldString)} bytes with ${Buffer.byteLength(newString)} bytes`,
      },
    };
  }

  return undefined;
}
