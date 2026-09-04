import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { CodexAdapter } from '@baton/adapters';
import {
  IngestionBatchSchema,
  protocolVersion,
  type IngestionBatchDraft,
} from '@baton/protocol';
import {
  encodeScrubbedUpload,
  scrubIngestionBatchDraft,
} from '@baton/scrubber';
import { describe, expect, it } from 'vitest';

import { repositoryRootFrom } from '../src/index.js';

describe('local collection privacy pipeline', () => {
  it('normalizes, scrubs, canonicalizes, and serializes without native payloads', async () => {
    const repositoryRoot = repositoryRootFrom(import.meta.url);
    const nativeUrl = new URL(
      '../../../testdata/fixtures/codex/2026-07-rollout/rollout-2026-07-09T11-00-00-bbbb2222-cccc-4ddd-8eee-ffff00000002.jsonl',
      import.meta.url,
    );
    const native = await readFile(nativeUrl, 'utf8');
    const adapter = new CodexAdapter();
    const normalized = adapter.parseSnapshot({ content: native });
    const deviceId = '018f0f90-1111-7111-8111-111111111111';
    const sourceSessionId = '018f0f90-2222-7222-8222-222222222222';
    const draft: IngestionBatchDraft = {
      schemaVersion: protocolVersion,
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
        nativeSessionHash: createHash('sha256').update(native).digest('hex'),
        parserVersion: adapter.formatVersion,
      },
      expectedHeadEventId: null,
      previousCursor: null,
      proposedCursor: 'adapter:v1:fixture-complete',
      events: normalized.map((event, index) => ({
        sourceSessionId,
        workThreadId: null,
        sourceAgent: 'codex',
        sourceDeviceId: deviceId,
        nativeSequence: index,
        parentEventId: null,
        occurredAt: event.occurredAt,
        observedAt: '2026-08-01T10:00:00Z',
        schemaVersion: protocolVersion,
        payload:
          index === 0 && event.payload.kind === 'message'
            ? {
                ...event.payload,
                text: `${event.payload.text}\ntoken=Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj`,
              }
            : event.payload,
      })),
    };

    const scrubbed = scrubIngestionBatchDraft(draft);
    const encoded = encodeScrubbedUpload(scrubbed);
    const uploaded: unknown = JSON.parse(encoded);

    expect(IngestionBatchSchema.safeParse(uploaded).success).toBe(true);
    expect(encoded).toContain('[REDACTED:generic-api-key]');
    expect(encoded).not.toContain('Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj');
    expect(encoded).not.toContain('session_meta');
    expect(encoded).not.toContain('response_item');
    expect(encoded).not.toContain('nativeFixture');
    expect(repositoryRoot).toMatch(/baton$/);
  });
});
