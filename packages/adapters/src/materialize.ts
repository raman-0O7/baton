import {
  createSourceEvent,
  protocolVersion,
  type SourceEvent,
} from '@baton/protocol';

import type { AdapterEvent } from './types.js';

export interface MaterializeContext {
  sourceSessionId: string;
  workThreadId: string | null;
  sourceDeviceId: string;
  sourceAgent: 'claudecode' | 'codex' | 'opencode';
  observedAt: string;
}

/** Convert scrub-ready adapter semantics into the canonical event envelope. */
export function materializeSourceEvent(
  event: AdapterEvent,
  context: MaterializeContext,
): SourceEvent {
  return createSourceEvent({
    sourceSessionId: context.sourceSessionId,
    workThreadId: context.workThreadId,
    sourceAgent: context.sourceAgent,
    sourceDeviceId: context.sourceDeviceId,
    nativeSequence: null,
    parentEventId: null,
    occurredAt: event.occurredAt,
    observedAt: context.observedAt,
    schemaVersion: protocolVersion,
    payload: event.payload,
  });
}
