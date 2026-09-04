import {
  IngestionBatchDraftSchema,
  IngestionBatchSchema,
  createSourceEvent,
  type IngestionBatch,
  type IngestionBatchDraft,
  type SourceEventPayload,
} from '@baton/protocol';

import { scrub, type RedactionType, type ScrubPolicy } from './scrub.js';

const scrubbedBatchBrand: unique symbol = Symbol('ScrubbedIngestionBatch');

export interface BatchRedaction {
  eventIndex: number;
  field: string;
  type: RedactionType;
}

/** Opaque capability required by the cloud upload boundary. */
export interface ScrubbedIngestionBatch {
  readonly batch: IngestionBatch;
  readonly redactions: readonly BatchRedaction[];
  readonly [scrubbedBatchBrand]: true;
}

export function scrubIngestionBatchDraft(
  input: IngestionBatchDraft,
  policy: ScrubPolicy = {},
): ScrubbedIngestionBatch {
  const draft = IngestionBatchDraftSchema.parse(input);
  const redactions: BatchRedaction[] = [];
  const events = draft.events.map((event, eventIndex) =>
    createSourceEvent({
      ...event,
      payload: scrubPayload(event.payload, eventIndex, policy, redactions),
    }),
  );
  const batch = IngestionBatchSchema.parse({ ...draft, events });

  return Object.freeze({
    batch,
    redactions: Object.freeze(redactions),
    [scrubbedBatchBrand]: true as const,
  });
}

/** The network client accepts only the opaque result of local scrubbing. */
export function encodeScrubbedUpload(value: ScrubbedIngestionBatch): string {
  return JSON.stringify(value.batch);
}

function scrubPayload(
  payload: SourceEventPayload,
  eventIndex: number,
  policy: ScrubPolicy,
  report: BatchRedaction[],
): SourceEventPayload {
  const field = (path: string, value: string): string => {
    const result = scrub(value, policy);
    report.push(
      ...result.redactions.map((redaction) => ({
        eventIndex,
        field: path,
        type: redaction.type,
      })),
    );
    return result.value;
  };
  const optional = (path: string, value: string | undefined) =>
    value === undefined ? undefined : field(path, value);

  switch (payload.kind) {
    case 'message':
      return { ...payload, text: field('payload.text', payload.text) };
    case 'tool_call': {
      const inputSummary = optional(
        'payload.inputSummary',
        payload.inputSummary,
      );
      return inputSummary === undefined
        ? {
            kind: 'tool_call',
            toolCallId: payload.toolCallId,
            name: payload.name,
          }
        : { ...payload, inputSummary };
    }
    case 'tool_result': {
      const outputSummary = optional(
        'payload.outputSummary',
        payload.outputSummary,
      );
      return outputSummary === undefined
        ? {
            kind: 'tool_result',
            toolCallId: payload.toolCallId,
            isError: payload.isError,
          }
        : { ...payload, outputSummary };
    }
    case 'file_change': {
      const diff = optional('payload.diff', payload.diff);
      const summary = optional('payload.summary', payload.summary);
      return {
        kind: 'file_change',
        path: field('payload.path', payload.path),
        operation: payload.operation,
        ...(diff === undefined ? {} : { diff }),
        ...(summary === undefined ? {} : { summary }),
      };
    }
    case 'task':
      return { ...payload, text: field('payload.text', payload.text) };
    case 'decision': {
      const rationale = optional('payload.rationale', payload.rationale);
      return {
        kind: 'decision',
        summary: field('payload.summary', payload.summary),
        ...(rationale === undefined ? {} : { rationale }),
      };
    }
    case 'error': {
      const command = optional('payload.command', payload.command);
      return {
        kind: 'error',
        message: field('payload.message', payload.message),
        ...(command === undefined ? {} : { command }),
      };
    }
    case 'session_metadata': {
      const title = optional('payload.title', payload.title);
      const model = optional('payload.model', payload.model);
      const gitBranch = optional('payload.gitBranch', payload.gitBranch);
      return {
        kind: 'session_metadata',
        ...(title === undefined ? {} : { title }),
        ...(model === undefined ? {} : { model }),
        ...(gitBranch === undefined ? {} : { gitBranch }),
      };
    }
  }
}
