import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IngestionBatchSchema,
  type IngestionBatch,
  type IngestionBatchDraft,
} from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  encodeScrubbedUpload,
  scrub,
  scrubIngestionBatchDraft,
  type ScrubbedIngestionBatch,
} from '../src/index.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

interface SeedManifest {
  [file: string]: Array<{ literal: string; type: string }>;
}

describe('legacy scrubber parity', () => {
  it('redacts every seeded leak with the expected classification', async () => {
    const base = resolve(repositoryRoot, 'internal/scrub/testdata/seeded');
    const manifest = JSON.parse(
      await readFile(resolve(base, 'manifest.json'), 'utf8'),
    ) as SeedManifest;

    for (const [file, expectedLeaks] of Object.entries(manifest)) {
      const input = await readFile(resolve(base, file), 'utf8');
      const result = scrub(input);
      for (const leak of expectedLeaks) {
        expect(result.value, `${file}: ${leak.type}`).not.toContain(
          leak.literal,
        );
        expect(
          result.redactions.map(({ type }) => type),
          `${file}: ${leak.type}`,
        ).toContain(leak.type);
      }
    }
  });

  it('does not redact the clean false-positive corpus', async () => {
    const base = resolve(repositoryRoot, 'internal/scrub/testdata/clean');
    for (const file of await readdir(base)) {
      const input = await readFile(resolve(base, file), 'utf8');
      expect(scrub(input), file).toEqual({ value: input, redactions: [] });
    }
  });

  it('supports project patterns and rejects invalid expressions', () => {
    expect(
      scrub('internal marker BATON_PRIVATE_123', {
        extraPatterns: ['BATON_PRIVATE_[0-9]+'],
      }).value,
    ).toBe('internal marker [REDACTED:generic-api-key]');
    expect(() => scrub('value', { extraPatterns: ['['] })).toThrow(
      /invalid extra pattern/,
    );
  });
});

describe('scrubbed upload boundary', () => {
  it('redacts before computing canonical integrity fields', () => {
    const draft = ingestionDraft(
      'Use Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz.signatureValue1234',
    );
    const scrubbed = scrubIngestionBatchDraft(draft);
    const encoded = encodeScrubbedUpload(scrubbed);

    expect(encoded).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(encoded).toContain('[REDACTED:bearer-token]');
    expect(scrubbed.redactions).toContainEqual({
      eventIndex: 0,
      field: 'payload.text',
      type: 'bearer-token',
    });
    expect(IngestionBatchSchema.safeParse(JSON.parse(encoded)).success).toBe(
      true,
    );
  });

  it('does not scrub tool correlation identifiers', () => {
    const draft = ingestionDraft('safe message');
    draft.events[0]!.payload = {
      kind: 'tool_call',
      toolCallId: 'Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj',
      name: 'shell',
      inputSummary: 'token=Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj',
    };
    const scrubbed = scrubIngestionBatchDraft(draft);
    const payload = scrubbed.batch.events[0]!.payload;

    expect(payload).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj',
      inputSummary: 'token=[REDACTED:generic-api-key]',
    });
  });

  it('makes a plain ingestion batch fail the compile-time upload contract', () => {
    const acceptsOnlyScrubbed = (_value: ScrubbedIngestionBatch): void => {};
    const plain = {} as IngestionBatch;
    if (false) {
      // @ts-expect-error An unbranded batch cannot cross the upload boundary.
      acceptsOnlyScrubbed(plain);
    }
    expect(typeof acceptsOnlyScrubbed).toBe('function');
  });
});

function ingestionDraft(text: string): IngestionBatchDraft {
  const deviceId = '018f0f90-1111-7111-8111-111111111111';
  const sourceSessionId = '018f0f90-2222-7222-8222-222222222222';
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
      nativeSessionHash: 'a'.repeat(64),
      parserVersion: '2026-07-rollout',
    },
    expectedHeadEventId: null,
    previousCursor: null,
    proposedCursor: 'cursor:v1:test',
    events: [
      {
        sourceSessionId,
        workThreadId: null,
        sourceAgent: 'codex',
        sourceDeviceId: deviceId,
        nativeSequence: null,
        parentEventId: null,
        occurredAt: '2026-08-01T10:00:00Z',
        observedAt: '2026-08-01T10:00:01Z',
        schemaVersion: 1,
        payload: { kind: 'message', role: 'user', text },
      },
    ],
  };
}
