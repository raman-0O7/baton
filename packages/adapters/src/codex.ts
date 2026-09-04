import type { SourceEventPayload } from '@baton/protocol';

import {
  completeJsonLines,
  isRecord,
  parseJsonRecord,
  stringField,
} from './jsonl.js';
import {
  type AdapterEvent,
  type NativeSnapshot,
  SnapshotAdapter,
  UnknownFormatError,
  normalizeTimestamp,
} from './types.js';

interface CodexToolState {
  index: number;
  name: string;
  arguments: string;
  occurredAt: string;
  line: number;
}

export class CodexAdapter extends SnapshotAdapter {
  readonly name = 'codex' as const;
  readonly formatVersion = '2026-07-rollout';

  parseSnapshot(snapshot: NativeSnapshot): AdapterEvent[] {
    const turns: AdapterEvent[] = [];
    const toolCalls: AdapterEvent[] = [];
    const toolResults: AdapterEvent[] = [];
    const fileChanges: AdapterEvent[] = [];
    const tools = new Map<string, CodexToolState>();
    let recognized = 0;

    for (const [zeroIndex, encoded] of completeJsonLines(
      snapshot.content,
    ).entries()) {
      const line = zeroIndex + 1;
      const record = parseJsonRecord(encoded);
      if (record === null) continue;
      const type = stringField(record, 'type');
      if (type !== 'session_meta' && type !== 'response_item') continue;
      recognized += 1;
      if (type !== 'response_item' || !isRecord(record.payload)) continue;
      const payload = record.payload;
      const occurred = stringField(record, 'timestamp');
      if (occurred === undefined) continue;
      const occurredAt = normalizeTimestamp(occurred);
      const payloadType = stringField(payload, 'type');

      if (payloadType === 'message') {
        const role = stringField(payload, 'role');
        if (role !== 'user' && role !== 'assistant' && role !== 'system')
          continue;
        const content = Array.isArray(payload.content)
          ? payload.content.filter(isRecord)
          : [];
        const text = content
          .map((block) => stringField(block, 'text') ?? '')
          .filter((part) => part !== '')
          .join('');
        if (text === '' || isCodexInjectedContext(role, text)) continue;
        const index = turns.length;
        turns.push({
          key: `turn:${index}`,
          identity: `codex:message:line:${line}`,
          occurredAt,
          sourcePointer: `/turns/${index}`,
          nativeLocator: { line },
          payload: { kind: 'message', role, text } as SourceEventPayload,
        });
        continue;
      }

      if (payloadType === 'function_call') {
        const callId = stringField(payload, 'call_id');
        const name = stringField(payload, 'name');
        const argumentsText = stringField(payload, 'arguments') ?? '{}';
        if (callId === undefined || name === undefined) continue;
        const index = toolCalls.length;
        tools.set(callId, {
          index,
          name,
          arguments: argumentsText,
          occurredAt,
          line,
        });
        toolCalls.push({
          key: `tool_call:${index}`,
          identity: `codex:tool-call:${callId}`,
          occurredAt,
          sourcePointer: `/tool_calls/${index}`,
          nativeLocator: { line, nativeId: callId },
          payload: {
            kind: 'tool_call',
            toolCallId: callId,
            name,
            inputSummary: argumentsText,
          },
        });
        const patchChange = parseApplyPatch(
          tools.get(callId)!,
          fileChanges.length,
          callId,
        );
        if (patchChange !== undefined) fileChanges.push(patchChange);
        continue;
      }

      if (payloadType === 'function_call_output') {
        const callId = stringField(payload, 'call_id');
        if (callId === undefined) continue;
        const state = tools.get(callId);
        if (state === undefined) continue;
        const output = stringField(payload, 'output') ?? '';
        toolResults.push({
          key: `tool_result:${state.index}`,
          identity: `codex:tool-result:${callId}`,
          occurredAt: state.occurredAt,
          sourcePointer: `/tool_calls/${state.index}`,
          nativeLocator: { line, nativeId: callId },
          payload: {
            kind: 'tool_result',
            toolCallId: callId,
            outputSummary: output,
            isError: codexOutputIsError(output),
          },
        });
      }
    }

    if (recognized === 0) throw new UnknownFormatError(this.name);
    return [
      ...turns,
      ...interleaveToolActivity(toolCalls, toolResults),
      ...fileChanges,
    ];
  }
}

function isCodexInjectedContext(role: string, text: string): boolean {
  return (
    role === 'user' &&
    (/^<environment_context>[\s\S]*<\/environment_context>$/.test(text) ||
      /^<developer_instructions>[\s\S]*<\/developer_instructions>$/.test(text))
  );
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

function codexOutputIsError(output: string): boolean {
  try {
    const value: unknown = JSON.parse(output);
    if (!isRecord(value) || !isRecord(value.metadata)) return false;
    const exitCode = value.metadata.exit_code;
    return typeof exitCode === 'number' && exitCode !== 0;
  } catch {
    return false;
  }
}

function parseApplyPatch(
  state: CodexToolState,
  index: number,
  callId: string,
): AdapterEvent | undefined {
  if (state.name !== 'shell') return undefined;
  let input: unknown;
  try {
    input = JSON.parse(state.arguments);
  } catch {
    return undefined;
  }
  if (!isRecord(input) || !Array.isArray(input.command)) return undefined;
  const command = input.command.filter(
    (value): value is string => typeof value === 'string',
  );
  const patch = command.find((value) => value.includes('*** Begin Patch'));
  if (patch === undefined) return undefined;
  const match = patch.match(/\*\*\* (Add|Update|Delete) File: ([^\n]+)/);
  if (match === null) return undefined;
  const operation =
    match[1] === 'Add' ? 'create' : match[1] === 'Delete' ? 'delete' : 'edit';
  const path = match[2]!;
  return {
    key: `file_op:${index}`,
    identity: `codex:file-change:${callId}:${path}`,
    occurredAt: state.occurredAt,
    sourcePointer: `/file_ops/${index}`,
    nativeLocator: { line: state.line, nativeId: callId },
    payload: {
      kind: 'file_change',
      path,
      operation,
      summary: 'apply_patch via codex',
    },
  };
}
