import { gunzipSync } from 'node:zlib';

import type {
  CollectionPolicy,
  IngestionBatchDraft,
  SourceEventInput,
} from '@baton/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  COLLECTION_DISCLOSURE_VERSION,
  DEFAULT_COLLECTION_POLICY,
  UploadFailure,
  applyCollectionPolicy,
  matchesPathPattern,
  prepareUpload,
  prepareUploadWithParentLineage,
  retryDelay,
  uploadWithRetry,
  type CloudUploadRequest,
} from '../src/index.js';

const sourceSessionId = '018f0f90-1111-7111-8111-111111111111';
const deviceId = '018f0f90-2222-7222-8222-222222222222';
const batchId = '018f0f90-3333-7333-8333-333333333333';

describe('pre-scrub collection policy', () => {
  it('drops disallowed categories and excluded paths before upload', () => {
    const policy: CollectionPolicy = {
      ...DEFAULT_COLLECTION_POLICY,
      allowedCategories: ['file_paths', 'diffs', 'tool_results'],
      excludedPathPatterns: ['**/.env', '**/*.pem'],
      maxToolResultBytes: 8,
      maxDiffBytes: 5,
    };
    const result = applyCollectionPolicy(
      [
        event({ kind: 'message', role: 'user', text: 'not allowed' }, 0),
        event(
          {
            kind: 'file_change',
            path: 'apps/api/.env',
            operation: 'edit',
            diff: '+secret',
          },
          1,
        ),
        event(
          {
            kind: 'file_change',
            path: 'src/index.ts',
            operation: 'edit',
            diff: '+12345',
            summary: 'edited',
          },
          2,
        ),
        event(
          {
            kind: 'tool_result',
            toolCallId: 'tool-1',
            outputSummary: '123456789',
            isError: false,
          },
          3,
        ),
      ],
      policy,
    );

    expect(result.excludedEvents).toBe(2);
    expect(result.omittedFields).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.payload).toEqual({
      kind: 'file_change',
      path: 'src/index.ts',
      operation: 'edit',
      summary: 'edited',
    });
    expect(result.events[1]?.payload).toEqual({
      kind: 'tool_result',
      toolCallId: 'tool-1',
      isError: false,
    });
  });

  it('matches portable glob exclusions without treating separators as text', () => {
    expect(matchesPathPattern('apps\\api\\.env', '**/.env')).toBe(true);
    expect(matchesPathPattern('keys/team.pem', '**/*.pem')).toBe(true);
    expect(matchesPathPattern('keys/team.txt', '**/*.pem')).toBe(false);
  });
});

describe('scrubbed, compressed upload boundary', () => {
  it('redacts before serialization and gzip compression', async () => {
    const draft = ingestionDraft(
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz.signatureValue1234',
    );
    const prepared = await prepareUpload(draft);
    const decoded = gunzipSync(prepared.body).toString('utf8');

    expect(decoded).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(decoded).toContain('[REDACTED:bearer-token]');
    expect(prepared).toMatchObject({
      batchId,
      idempotencyKey: batchId,
      contentEncoding: 'gzip',
      projectInstallationId: draft.projectInstallationId,
      consentRecordId: draft.consentRecordId,
      policyVersion: draft.policyVersion,
      disclosureVersion: draft.disclosureVersion,
      redactionCount: 1,
    });
  });

  it('fills missing parent links from scrubbed event identities and preserves explicit parents', async () => {
    const draft = ingestionDraft('first safe event');
    const explicitParent = '018f0f90-9999-7999-8999-999999999999';
    draft.events.push({
      ...event(
        { kind: 'message', role: 'assistant', text: 'explicit branch' },
        1,
      ),
      parentEventId: explicitParent,
    });
    const priorHead = '018f0f90-8888-7888-8888-888888888888';
    const prepared = await prepareUploadWithParentLineage(draft, priorHead);
    const batch = JSON.parse(gunzipSync(prepared.body).toString('utf8')) as {
      events: Array<{ parentEventId: string | null }>;
    };

    expect(batch.events[0]?.parentEventId).toBe(priorHead);
    expect(batch.events[1]?.parentEventId).toBe(explicitParent);
  });

  it('retries a fixed prepared body and idempotency key with bounded jitter', async () => {
    const prepared = await prepareUpload(ingestionDraft('safe'));
    const requests: CloudUploadRequest[] = [];
    const delays: number[] = [];
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      requests.push(request);
      if (requests.length < 3) {
        throw new UploadFailure({
          code: 'timeout',
          message: 'response was lost',
          retryable: true,
        });
      }
      return acknowledgement(prepared.batchId, 'cursor:2');
    });

    await uploadWithRetry(
      { upload },
      prepared,
      { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 },
      {
        random: () => 0.5,
        sleep: async (delay) => {
          delays.push(delay);
        },
      },
    );

    expect(upload).toHaveBeenCalledTimes(3);
    expect(requests.every((request) => request === prepared)).toBe(true);
    expect(
      new Set(requests.map(({ idempotencyKey }) => idempotencyKey)),
    ).toEqual(new Set([batchId]));
    expect(delays).toEqual([100, 200]);
    expect(
      retryDelay(
        { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 500, jitterRatio: 0.2 },
        1,
        0,
      ),
    ).toBe(80);
  });

  it('does not retry non-retryable consent failures', async () => {
    const upload = vi.fn(async () => {
      throw new UploadFailure({
        code: 'consent_required',
        message: 'consent is stale',
        retryable: false,
      });
    });
    await expect(
      uploadWithRetry({ upload }, await prepareUpload(ingestionDraft('safe'))),
    ).rejects.toMatchObject({ code: 'consent_required', retryable: false });
    expect(upload).toHaveBeenCalledOnce();
  });
});

function ingestionDraft(text: string): IngestionBatchDraft {
  return {
    schemaVersion: 1,
    batchId,
    deviceId,
    projectId: '018f0f90-4444-7444-8444-444444444444',
    projectInstallationId: '018f0f90-5555-7555-8555-555555555555',
    consentRecordId: '018f0f90-6666-7666-8666-666666666666',
    policyVersion: DEFAULT_COLLECTION_POLICY.policyVersion,
    disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
    source: {
      sourceSessionId,
      agent: 'codex',
      nativeSessionHash: 'a'.repeat(64),
      parserVersion: 'test-v1',
    },
    expectedHeadEventId: null,
    previousCursor: 'cursor:1',
    proposedCursor: 'cursor:2',
    events: [event({ kind: 'message', role: 'user', text }, 0)],
  };
}

function event(
  payload: SourceEventInput['payload'],
  nativeSequence: number,
): SourceEventInput {
  return {
    sourceSessionId,
    workThreadId: null,
    sourceAgent: 'codex',
    sourceDeviceId: deviceId,
    nativeSequence,
    parentEventId: null,
    occurredAt: `2026-08-02T10:00:0${nativeSequence}Z`,
    observedAt: `2026-08-02T10:00:0${nativeSequence}Z`,
    schemaVersion: 1,
    payload,
  };
}

function acknowledgement(batch: string, cursor: string) {
  return {
    batchId: batch,
    acceptedEventIds: [],
    duplicateEventIds: [],
    headEventId: null,
    acknowledgedCursor: cursor,
    branchCreated: false,
  };
}
