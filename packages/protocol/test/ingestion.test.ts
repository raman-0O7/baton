import { describe, expect, it } from 'vitest';

import { IngestionBatchSchema, createSourceEvent } from '../src/index.js';

const deviceId = '018f0f90-1111-7111-8111-111111111111';
const sourceSessionId = '018f0f90-2222-7222-8222-222222222222';

function validBatch(): unknown {
  return {
    schemaVersion: 1,
    batchId: '018f0f90-3333-7333-8333-333333333333',
    deviceId,
    projectId: '018f0f90-4444-7444-8444-444444444444',
    projectInstallationId: '018f0f90-5555-7555-8555-555555555555',
    consentRecordId: '018f0f90-6666-7666-8666-666666666666',
    policyVersion: '2026-08-01',
    disclosureVersion: '2026-08-01',
    source: {
      sourceSessionId,
      agent: 'codex',
      nativeSessionHash:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      parserVersion: '2026-07-rollout',
    },
    expectedHeadEventId: null,
    previousCursor: null,
    proposedCursor: 'line:1',
    events: [
      {
        ...createSourceEvent({
          sourceSessionId,
          workThreadId: null,
          sourceAgent: 'codex',
          sourceDeviceId: deviceId,
          nativeSequence: 1,
          parentEventId: null,
          occurredAt: '2026-07-29T00:00:00.000Z',
          observedAt: '2026-07-29T00:00:01.000Z',
          schemaVersion: 1,
          payload: {
            kind: 'message',
            role: 'user',
            text: 'Continue the hosted Baton implementation.',
          },
        }),
      },
    ],
  };
}

describe('IngestionBatchSchema', () => {
  it('accepts a cloud-safe normalized event batch', () => {
    expect(IngestionBatchSchema.safeParse(validBatch()).success).toBe(true);
  });

  it('requires exact installation and consent version binding', () => {
    const batch = validBatch() as Record<string, unknown>;
    delete batch.projectInstallationId;
    delete batch.consentRecordId;

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it('rejects complete native session bytes at the network boundary', () => {
    const batch = validBatch() as Record<string, unknown>;
    batch.raw = '{"native":"transcript"}';

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it('rejects unknown fields inside a normalized event payload', () => {
    const batch = validBatch() as {
      events: Array<{ payload: Record<string, unknown> }>;
    };
    batch.events[0]!.payload.rawTranscript = '{"native":"transcript"}';

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it('rejects events attributed to another device', () => {
    const batch = validBatch() as {
      events: Array<{ sourceDeviceId: string }>;
    };
    batch.events[0]!.sourceDeviceId = '018f0f90-6666-7666-8666-666666666666';

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it.each([
    ['sourceSessionId', '018f0f90-7777-7777-8777-777777777777'],
    ['sourceAgent', 'claudecode'],
  ] as const)('rejects inconsistent event %s attribution', (field, value) => {
    const batch = validBatch() as {
      events: Array<Record<string, unknown>>;
    };
    batch.events[0]![field] = value;

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it('rejects duplicate event and idempotency identities in one batch', () => {
    const batch = validBatch() as {
      events: Array<Record<string, unknown>>;
    };
    batch.events.push({ ...batch.events[0] });

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });

  it('rejects a payload whose integrity fields were not recomputed', () => {
    const batch = validBatch() as {
      events: Array<{
        payload: { text: string };
      }>;
    };
    batch.events[0]!.payload.text = 'Tampered after hashing';

    expect(IngestionBatchSchema.safeParse(batch).success).toBe(false);
  });
});
