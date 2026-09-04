import { isRecord, stringField } from './jsonl.js';
import {
  type AdapterEvent,
  type NativeSnapshot,
  SnapshotAdapter,
  UnknownFormatError,
  jsonSummary,
  normalizeTimestamp,
} from './types.js';

interface SqlRow {
  values: string[];
}

interface MessageRecord {
  role: 'user' | 'assistant' | 'system';
}

export class OpenCodeAdapter extends SnapshotAdapter {
  readonly name = 'opencode' as const;
  readonly formatVersion = '2026-07-db';

  parseSnapshot(snapshot: NativeSnapshot): AdapterEvent[] {
    const inserts = parseSqlInserts(snapshot.content);
    const messages = new Map<string, MessageRecord>();
    for (const row of inserts.get('message') ?? []) {
      const data = parseJsonObject(row.values[4]);
      const role = data === undefined ? undefined : stringField(data, 'role');
      if (role === 'user' || role === 'assistant' || role === 'system') {
        messages.set(row.values[0]!, { role });
      }
    }

    const parts = (inserts.get('part') ?? [])
      .filter(
        (row) =>
          snapshot.visibleNativeIds === undefined ||
          snapshot.visibleNativeIds.has(row.values[0]!),
      )
      .sort((left, right) => {
        const time = Number(left.values[3]) - Number(right.values[3]);
        return time === 0
          ? left.values[0]!.localeCompare(right.values[0]!)
          : time;
      });
    if ((inserts.get('session')?.length ?? 0) === 0 || messages.size === 0) {
      throw new UnknownFormatError(this.name);
    }

    const turns: AdapterEvent[] = [];
    const toolCalls: AdapterEvent[] = [];
    const toolResults: AdapterEvent[] = [];
    const fileChanges: AdapterEvent[] = [];

    for (const row of parts) {
      const [partId, messageId, , createdAtText, , dataText] = row.values;
      if (
        partId === undefined ||
        messageId === undefined ||
        createdAtText === undefined ||
        dataText === undefined
      ) {
        continue;
      }
      const data = parseJsonObject(dataText);
      if (data === undefined) continue;
      const type = stringField(data, 'type');
      const occurredAt = opencodeOccurredAt(data, Number(createdAtText));
      if (type === 'text') {
        const text = stringField(data, 'text');
        const role = messages.get(messageId)?.role;
        if (text === undefined || role === undefined || text === '') continue;
        const index = turns.length;
        turns.push({
          key: `turn:${index}`,
          identity: `opencode:part:${partId}:message`,
          occurredAt,
          sourcePointer: `/turns/${index}`,
          nativeLocator: { table: 'part', nativeId: partId },
          payload: { kind: 'message', role, text },
        });
        continue;
      }
      if (type !== 'tool') continue;
      const callId = stringField(data, 'callID');
      const name = stringField(data, 'tool');
      const state = isRecord(data.state) ? data.state : undefined;
      const input =
        state !== undefined && isRecord(state.input) ? state.input : {};
      if (callId === undefined || name === undefined || state === undefined)
        continue;
      const index = toolCalls.length;
      const locator = { table: 'part', nativeId: partId };
      toolCalls.push({
        key: `tool_call:${index}`,
        identity: `opencode:part:${partId}:tool-call`,
        occurredAt,
        sourcePointer: `/tool_calls/${index}`,
        nativeLocator: locator,
        payload: {
          kind: 'tool_call',
          toolCallId: callId,
          name,
          inputSummary: jsonSummary(input),
        },
      });
      toolResults.push({
        key: `tool_result:${index}`,
        identity: `opencode:part:${partId}:tool-result`,
        occurredAt,
        sourcePointer: `/tool_calls/${index}`,
        nativeLocator: locator,
        payload: {
          kind: 'tool_result',
          toolCallId: callId,
          outputSummary: stringField(state, 'output') ?? '',
          isError: stringField(state, 'status') === 'error',
        },
      });

      if (name === 'write') {
        const path = stringField(input, 'filePath');
        if (path !== undefined) {
          const fileIndex = fileChanges.length;
          fileChanges.push({
            key: `file_op:${fileIndex}`,
            identity: `opencode:part:${partId}:file-change`,
            occurredAt,
            sourcePointer: `/file_ops/${fileIndex}`,
            nativeLocator: locator,
            payload: {
              kind: 'file_change',
              path,
              operation: 'create',
              summary: 'write via opencode',
            },
          });
        }
      }
    }

    return [
      ...turns,
      ...interleaveToolActivity(toolCalls, toolResults),
      ...fileChanges,
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

function opencodeOccurredAt(
  data: Record<string, unknown>,
  fallback: number,
): string {
  if (isRecord(data.time) && typeof data.time.start === 'number') {
    return normalizeTimestamp(data.time.start);
  }
  return normalizeTimestamp(fallback);
}

function parseJsonObject(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse the narrow INSERT dump form used by OpenCode parity snapshots. */
function parseSqlInserts(sql: string): Map<string, SqlRow[]> {
  const result = new Map<string, SqlRow[]>();
  const insertPattern =
    /INSERT INTO\s+(session|message|part)\s*\([^;]+?\)\s*VALUES\s*([\s\S]*?);/g;
  for (const match of sql.matchAll(insertPattern)) {
    const table = match[1];
    const values = match[2];
    if (table === undefined || values === undefined) continue;
    result.set(table, parseTuples(values));
  }
  return result;
}

function parseTuples(values: string): SqlRow[] {
  const rows: SqlRow[] = [];
  let index = 0;
  while (index < values.length) {
    while (index < values.length && values[index] !== '(') index += 1;
    if (index >= values.length) break;
    index += 1;
    const fields: string[] = [];
    let field = '';
    let quoted = false;
    while (index < values.length) {
      const character = values[index]!;
      if (quoted) {
        if (character === "'" && values[index + 1] === "'") {
          field += "'";
          index += 2;
          continue;
        }
        if (character === "'") {
          quoted = false;
          index += 1;
          continue;
        }
        field += character;
        index += 1;
        continue;
      }
      if (character === "'") {
        quoted = true;
        index += 1;
        continue;
      }
      if (character === ',') {
        fields.push(field.trim());
        field = '';
        index += 1;
        continue;
      }
      if (character === ')') {
        fields.push(field.trim());
        index += 1;
        break;
      }
      field += character;
      index += 1;
    }
    rows.push({ values: fields });
  }
  return rows;
}
