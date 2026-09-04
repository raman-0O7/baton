import { createSourceEvent, type CollectionPolicy } from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import { validateEventCollectionPolicy } from '../src/ingestion-policy.js';

const basePolicy: CollectionPolicy = {
  policyVersion: 'test-v1',
  allowedCategories: ['conversation_text'],
  excludedPathPatterns: ['**/.env'],
  maxToolResultBytes: 8,
  maxDiffBytes: 8,
};

describe('server-side ingestion policy', () => {
  it('accepts only event categories present in active consent', () => {
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'message',
          role: 'user',
          text: 'Allowed text.',
        }),
        basePolicy,
      ),
    ).not.toThrow();
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'tool_call',
          toolCallId: 'call-1',
          name: 'shell',
          inputSummary: 'pwd',
        }),
        basePolicy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'consent_required' }));
  });

  it('enforces consented tool-result and diff byte caps', () => {
    const policy: CollectionPolicy = {
      ...basePolicy,
      allowedCategories: ['tool_results', 'file_paths', 'diffs'],
    };
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'tool_result',
          toolCallId: 'call-1',
          outputSummary: '123456789',
          isError: false,
        }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'payload_too_large' }));
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'file_change',
          path: 'src/index.ts',
          operation: 'edit',
          diff: '123456789',
        }),
        policy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'payload_too_large' }));
  });

  it('rejects excluded paths and obvious remaining credentials', () => {
    const filePolicy: CollectionPolicy = {
      ...basePolicy,
      allowedCategories: ['file_paths'],
    };
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'file_change',
          path: 'services/.env',
          operation: 'edit',
        }),
        filePolicy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'consent_required' }));
    expect(() =>
      validateEventCollectionPolicy(
        event({
          kind: 'message',
          role: 'user',
          text: 'access_token=should-never-reach-cloud',
        }),
        basePolicy,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
  });
});

function event(payload: Parameters<typeof createSourceEvent>[0]['payload']) {
  return createSourceEvent({
    sourceSessionId: '018f0f90-1000-7000-8000-000000000001',
    workThreadId: null,
    sourceAgent: 'codex',
    sourceDeviceId: '018f0f90-2000-7000-8000-000000000001',
    nativeSequence: 1,
    parentEventId: null,
    occurredAt: '2026-08-02T12:00:00.000Z',
    observedAt: '2026-08-02T12:00:01.000Z',
    schemaVersion: 1,
    payload,
  });
}
