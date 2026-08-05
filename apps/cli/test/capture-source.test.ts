import type {
  CaptureCheckpoint,
  EventBatch,
  EventSource as NativeEventSource,
  Fingerprint,
  ProjectBinding as CaptureBinding,
  SourceSessionRef as NativeRef,
} from '@baton/capture';
import type { ProjectBinding } from '@baton/sync';
import { describe, expect, it } from 'vitest';

import { CaptureSyncEventSource } from '../src/capture-source.js';

const projectId = '55555555-5555-4555-8555-555555555555';
const deviceId = '44444444-4444-4444-8444-444444444444';
const sourceId = '99999999-9999-4999-8999-999999999999';

describe('CaptureSyncEventSource', () => {
  it('baselines without returning historical events', async () => {
    const source = new FakeCaptureSource(threeEventBatch());
    const bridge = new CaptureSyncEventSource(source);
    const [ref] = await bridge.discover(binding());
    const cursor = await bridge.currentCursor(binding(), ref!);
    const result = await bridge.readSince(binding(), ref!, cursor, {
      maxEvents: 500,
      targetUncompressedBytes: 100_000,
    });

    expect(cursor).not.toBeNull();
    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('pages normalized events without persisting local paths', async () => {
    const source = new FakeCaptureSource(threeEventBatch());
    const bridge = new CaptureSyncEventSource(
      source,
      () => new Date('2026-08-02T01:00:00.000Z'),
    );
    const [ref] = await bridge.discover(binding());
    const first = await bridge.readSince(binding(), ref!, null, {
      maxEvents: 2,
      targetUncompressedBytes: 100_000,
    });
    const second = await bridge.readSince(
      binding(),
      ref!,
      first.proposedCursor,
      { maxEvents: 2, targetUncompressedBytes: 100_000 },
    );

    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.events).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(
      [...first.events, ...second.events].map((event) => event.nativeSequence),
    ).toEqual([0, 1, 2]);
    expect(first.events[0]).toMatchObject({
      sourceSessionId: sourceId,
      sourceDeviceId: deviceId,
      sourceAgent: 'codex',
      observedAt: '2026-08-02T01:00:00.000Z',
    });
    expect(first.proposedCursor).not.toContain('/private/native/session.jsonl');
  });
});

class FakeCaptureSource implements NativeEventSource {
  readonly name = 'codex' as const;
  readonly parserVersion = 'test-v1';
  readonly #ref: NativeRef = {
    sourceId,
    nativeSessionHash: 'a'.repeat(64),
    projectId,
    agent: 'codex',
    nativeSessionId: 'native-session',
    local: { kind: 'jsonl', path: '/private/native/session.jsonl' },
  };

  constructor(private readonly full: EventBatch) {}

  async discover(_project: CaptureBinding): Promise<NativeRef[]> {
    return [this.#ref];
  }

  async readSince(
    _ref: NativeRef,
    cursor?: CaptureCheckpoint,
  ): Promise<EventBatch> {
    return cursor === undefined
      ? this.full
      : { ...this.full, mode: 'append', reason: 'unchanged', events: [] };
  }

  async fingerprint(_ref: NativeRef): Promise<Fingerprint> {
    return this.full.checkpoint.fingerprint;
  }
}

function binding(): ProjectBinding {
  return {
    projectIdentity: `project:v1:${'b'.repeat(64)}`,
    projectInstallationId: '66666666-6666-4666-8666-666666666666',
    cloudProjectId: projectId,
    deviceId,
    displayName: 'Baton',
    canonicalLocalPath: '/workspace/baton',
  };
}

function threeEventBatch(): EventBatch {
  const checkpoint: CaptureCheckpoint = {
    schemaVersion: 1,
    sourceId,
    agent: 'codex',
    generation: 0,
    adapter: {
      schemaVersion: 1,
      agent: 'codex',
      eventCount: 3,
      prefixDigest: 'c'.repeat(64),
      snapshotDigest: 'c'.repeat(64),
    },
    physical: {
      kind: 'jsonl',
      byteLength: 300,
      contentDigest: 'd'.repeat(64),
    },
    fingerprint: {
      algorithm: 'sha256',
      digest: 'd'.repeat(64),
      extent: 300,
    },
  };
  return {
    sourceId,
    nativeSessionHash: 'a'.repeat(64),
    agent: 'codex',
    parserVersion: 'test-v1',
    mode: 'replace',
    reason: 'initial',
    events: [0, 1, 2].map((index) => ({
      key: `message:${index}`,
      identity: `native:${index}`,
      occurredAt: `2026-08-02T00:00:0${index}.000Z`,
      sourcePointer: `line:${index + 1}`,
      nativeLocator: { line: index + 1 },
      payload: { kind: 'message', role: 'user', text: `message ${index}` },
    })),
    checkpoint,
  };
}
