import { gunzipSync } from 'node:zlib';

import {
  IngestionBatchSchema,
  maxIngestionCompressedBytes,
  type AgentName,
  type IngestionBatch,
  type SourceEventInput,
} from '@baton/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  COLLECTION_DISCLOSURE_DIGEST,
  COLLECTION_DISCLOSURE_VERSION,
  DEFAULT_COLLECTION_POLICY,
  InstallationMap,
  MemoryInstallationStore,
  SyncCoordinator,
  UploadFailure,
  sourceCheckpointKey,
  type CloudUploadRequest,
  type EnableInstallationInput,
  type EventSource,
  type ProjectBinding,
  type ProjectCanonicalizer,
  type ProjectIdentity,
  type ReconciliationScheduler,
  type SourceChangeWatcher,
  type SourceReadLimit,
  type SourceReadResult,
  type SourceSessionRef,
} from '../src/index.js';

const ids = {
  installation: '018f0f90-1111-7111-8111-111111111111',
  project: '018f0f90-2222-7222-8222-222222222222',
  device: '018f0f90-3333-7333-8333-333333333333',
  consent: '018f0f90-4444-7444-8444-444444444444',
  session: '018f0f90-5555-7555-8555-555555555555',
};
const identity = `project:v1:${'a'.repeat(64)}` as ProjectIdentity;
const ref: SourceSessionRef = {
  key: '/private/native/session.jsonl',
  sourceSessionId: ids.session,
  nativeSessionHash: 'b'.repeat(64),
  parserVersion: 'test-v1',
};

describe('sync coordinator', () => {
  it('discovery/login alone produces zero source reads and zero uploads', async () => {
    const map = installationMap();
    await map.identify('/work/project');
    const source = new TestSource();
    const upload = vi.fn();
    const sync = coordinator({ map, source, upload });

    await sync.start();
    expect(source.discoverCalls).toBe(0);
    expect(source.readCalls).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    await sync.stop();
  });

  it('baselines existing sessions with zero upload, then uploads one scrubbed append', async () => {
    const map = installationMap();
    await map.enable(enableInput());
    const source = new TestSource();
    source.headCursor = 'cursor:old';
    const uploaded: IngestionBatch[] = [];
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      const batch = decode(request);
      uploaded.push(batch);
      return acknowledgement(
        request.batchId,
        batch.events.map(({ eventId }) => eventId),
        batch.events.at(-1)?.eventId ?? null,
        batch.proposedCursor,
      );
    });
    const sync = coordinator({ map, source, upload });

    await sync.start();
    expect(upload).not.toHaveBeenCalled();
    expect(source.currentCursorCalls).toBe(1);
    const key = sourceCheckpointKey('codex', ref);
    expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
      'cursor:old',
    );
    expect((await map.get(identity))?.baselineState).toBe('complete');

    source.readPage = () => ({
      events: [
        sourceEvent(
          {
            kind: 'message',
            role: 'user',
            text: 'token=Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj',
          },
          1,
        ),
        sourceEvent(
          {
            kind: 'file_change',
            path: 'services/api/.env',
            operation: 'edit',
            diff: '+DATABASE_URL=postgres://secret',
          },
          2,
        ),
        sourceEvent(
          {
            kind: 'message',
            role: 'assistant',
            text: 'The safe append follows the scrubbed message.',
          },
          3,
        ),
      ],
      previousCursor: 'cursor:old',
      proposedCursor: 'cursor:new',
      hasMore: false,
    });
    await sync.trigger(identity);

    expect(upload).toHaveBeenCalledOnce();
    expect(uploaded[0]?.events).toHaveLength(2);
    expect(JSON.stringify(uploaded[0])).not.toContain(
      'Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj',
    );
    expect(JSON.stringify(uploaded[0])).not.toContain('DATABASE_URL');
    expect(JSON.stringify(uploaded[0])).toContain('[REDACTED:generic-api-key]');
    expect(uploaded[0]?.events[0]?.parentEventId).toBeNull();
    expect(uploaded[0]?.events[1]?.parentEventId).toBe(
      uploaded[0]?.events[0]?.eventId,
    );
    expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
      'cursor:new',
    );
    expect(sync.status(identity)).toMatchObject({
      state: 'watching',
      summary: 'Watching for new conversation events.',
      errorCode: null,
    });
    await sync.stop();
  });

  it('retries a timed-out upload using the same deterministic batch identity', async () => {
    const { map, source, coordinator: build } = await baselinedFixture();
    const requests: CloudUploadRequest[] = [];
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new UploadFailure({
          code: 'timeout',
          message: 'response lost after commit',
          retryable: true,
        });
      }
      return acknowledgement(request.batchId, [], null, 'cursor:new');
    });
    const sync = build(upload, {
      retryDependencies: {
        random: () => 0.5,
        sleep: async () => {},
      },
    });
    await sync.start();
    source.readPage = () => appendPage('cursor:old', 'cursor:new');
    await sync.trigger(identity);

    expect(requests).toHaveLength(2);
    expect(requests[0]).toBe(requests[1]);
    expect(requests[0]?.idempotencyKey).toBe(requests[1]?.idempotencyKey);
    const key = sourceCheckpointKey('codex', ref);
    expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
      'cursor:new',
    );
    await sync.stop();
  });

  it.each(['consent_required', 'project_disabled'])(
    'does not advance a checkpoint after %s',
    async (code) => {
      const { map, source, coordinator: build } = await baselinedFixture();
      const upload = vi.fn(async () => {
        throw new UploadFailure({
          code,
          message: 'capture rejected',
          retryable: false,
        });
      });
      const sync = build(upload);
      await sync.start();
      source.readPage = () => appendPage('cursor:old', 'cursor:new');
      await sync.trigger(identity);

      const key = sourceCheckpointKey('codex', ref);
      expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
        'cursor:old',
      );
      expect(upload).toHaveBeenCalledOnce();
      expect(sync.status(identity)).toMatchObject({
        state: 'action_required',
        errorCode: code,
        retryable: false,
        nextAction: expect.stringContaining('baton enable'),
      });
      await sync.stop();
    },
  );

  it('does not read or retain a content queue while offline', async () => {
    const map = installationMap();
    await map.enable(enableInput());
    const source = new TestSource();
    let online = false;
    const upload = vi.fn();
    const sync = coordinator({ map, source, upload, online: () => online });
    await sync.start();

    expect(source.discoverCalls).toBe(0);
    expect(source.readCalls).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(sync.status(identity)).toMatchObject({
      state: 'offline',
      errorCode: 'offline',
      summary: expect.stringContaining('not read or queued'),
    });

    online = true;
    await sync.reconcile();
    expect(source.currentCursorCalls).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    await sync.stop();
  });

  it('stops checkpoint advancement when pause races with an acknowledgement and skips the paused window on resume', async () => {
    const { map, source, coordinator: build } = await baselinedFixture();
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      await map.pause(identity);
      return acknowledgement(request.batchId, [], null, 'cursor:paused-window');
    });
    const sync = build(upload);
    await sync.start();
    source.readPage = () => appendPage('cursor:old', 'cursor:paused-window');
    await sync.trigger(identity);

    const key = sourceCheckpointKey('codex', ref);
    expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
      'cursor:old',
    );
    expect(sync.status(identity)?.state).toBe('paused');

    source.headCursor = 'cursor:paused-window';
    await map.resume(identity);
    await sync.refresh();
    await sync.trigger(identity);
    expect((await map.get(identity))?.checkpoints[key]?.cursor).toBe(
      'cursor:paused-window',
    );
    expect(upload).toHaveBeenCalledOnce();
    await sync.stop();
  });

  it('re-reads an oversized page with a smaller event limit and uploads bounded parts', async () => {
    const { map, source, coordinator: build } = await baselinedFixture();
    const events = [
      sourceEvent(
        { kind: 'message', role: 'user', text: spacedText('a', 700) },
        1,
      ),
      sourceEvent(
        { kind: 'message', role: 'assistant', text: spacedText('b', 700) },
        2,
      ),
    ];
    const readPage = (
      _binding: ProjectBinding,
      _ref: SourceSessionRef,
      cursor: string | null,
      limit: SourceReadLimit,
    ) => {
      const offset = cursor === 'cursor:old' ? 0 : 1;
      const page = events.slice(offset, offset + limit.maxEvents);
      const end = offset + page.length;
      return {
        events: page,
        previousCursor: cursor,
        proposedCursor: `cursor:${end}`,
        hasMore: end < events.length,
      };
    };
    const requests: CloudUploadRequest[] = [];
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      requests.push(request);
      const batch = JSON.parse(
        Buffer.from(request.body).toString('utf8'),
      ) as IngestionBatch;
      return acknowledgement(
        request.batchId,
        batch.events.map(({ eventId }) => eventId),
        batch.events.at(-1)?.eventId ?? null,
        batch.proposedCursor,
      );
    });
    const sync = build(upload, {
      maxCompressedBatchBytes: 2_400,
      uploadPreparation: {
        compressor: {
          contentEncoding: 'identity',
          compress: async (input) => input,
        },
      },
    });
    await sync.start();
    source.readPage = readPage;
    await sync.trigger(identity);

    expect(
      requests,
      JSON.stringify({
        status: sync.status(identity),
        limits: source.readCalls.map(({ limit }) => limit.maxEvents),
      }),
    ).toHaveLength(2);
    expect(requests.every(({ body }) => body.byteLength <= 2_400)).toBe(true);
    expect(source.readCalls.map(({ limit }) => limit.maxEvents)).toContain(1);
    const firstBatch = JSON.parse(
      Buffer.from(requests[0]!.body).toString('utf8'),
    ) as IngestionBatch;
    const secondBatch = JSON.parse(
      Buffer.from(requests[1]!.body).toString('utf8'),
    ) as IngestionBatch;
    expect(firstBatch.events[0]?.parentEventId).toBeNull();
    expect(secondBatch.events[0]?.parentEventId).toBe(
      firstBatch.events[0]?.eventId,
    );
    expect(
      (await map.get(identity))?.checkpoints[sourceCheckpointKey('codex', ref)]
        ?.cursor,
    ).toBe('cursor:2');
    await sync.stop();
  });

  it('enforces the shared 256 KiB compressed limit by default', async () => {
    const { source, coordinator: build } = await baselinedFixture();
    const upload = vi.fn();
    const sync = build(upload, {
      uploadPreparation: {
        serializer: {
          serialize: () => new Uint8Array(maxIngestionCompressedBytes + 1),
        },
        compressor: {
          contentEncoding: 'identity',
          compress: async (input) => input,
        },
      },
    });
    await sync.start();
    source.readPage = () => appendPage('cursor:old', 'cursor:new');
    await sync.trigger(identity);

    expect(upload).not.toHaveBeenCalled();
    expect(sync.status(identity)).toMatchObject({
      state: 'error',
      errorCode: 'batch_too_large',
      retryable: false,
    });
    await sync.stop();
  });

  it('responds to watcher changes, reconciles periodically, and closes a paused watcher', async () => {
    const { map, source } = await baselinedFixture();
    let notifyChange: (() => void) | undefined;
    let reconcileTask: (() => Promise<void>) | undefined;
    let watcherClosed = false;
    const watcher: SourceChangeWatcher = {
      watch: async (_binding, notify) => {
        notifyChange = notify;
        return {
          close: async () => {
            watcherClosed = true;
          },
        };
      },
    };
    const scheduler: ReconciliationScheduler = {
      start: (task) => {
        reconcileTask = task;
        return { close: async () => {} };
      },
    };
    const uploadedCursors: string[] = [];
    const upload = vi.fn(async (request: CloudUploadRequest) => {
      const batch = decode(request);
      uploadedCursors.push(batch.proposedCursor);
      return acknowledgement(
        request.batchId,
        batch.events.map(({ eventId }) => eventId),
        batch.events.at(-1)?.eventId ?? null,
        batch.proposedCursor,
      );
    });
    source.readPage = (_binding, _ref, cursor) =>
      cursor === 'cursor:old'
        ? appendPage('cursor:old', 'cursor:watch')
        : emptyPage(cursor);
    const sync = coordinator({
      map,
      source,
      upload,
      watcher,
      scheduler,
    });
    await sync.start();
    expect(uploadedCursors).toEqual(['cursor:watch']);

    source.readPage = (_binding, _ref, cursor) =>
      cursor === 'cursor:watch'
        ? appendPage('cursor:watch', 'cursor:periodic')
        : emptyPage(cursor);
    notifyChange?.();
    await sync.trigger(identity);
    expect(uploadedCursors).toEqual(['cursor:watch', 'cursor:periodic']);

    await reconcileTask?.();
    expect(sync.status(identity)?.state).toBe('watching');
    await map.pause(identity);
    await sync.refresh();
    expect(watcherClosed).toBe(true);
    expect(sync.status(identity)?.state).toBe('paused');
    await sync.stop();
  });
});

class TestSource implements EventSource {
  readonly name: AgentName = 'codex';
  headCursor: string | null = 'cursor:old';
  discoverCalls = 0;
  currentCursorCalls = 0;
  readCalls: Array<{ cursor: string | null; limit: SourceReadLimit }> = [];
  readPage: (
    binding: ProjectBinding,
    ref: SourceSessionRef,
    cursor: string | null,
    limit: SourceReadLimit,
  ) => SourceReadResult = (_binding, _ref, cursor) => ({
    events: [],
    previousCursor: cursor,
    proposedCursor: cursor ?? 'cursor:empty',
    hasMore: false,
  });

  async discover(_binding: ProjectBinding): Promise<SourceSessionRef[]> {
    this.discoverCalls += 1;
    return [ref];
  }

  async readSince(
    binding: ProjectBinding,
    sourceRef: SourceSessionRef,
    cursor: string | null,
    limit: SourceReadLimit,
  ): Promise<SourceReadResult> {
    this.readCalls.push({ cursor, limit });
    return this.readPage(binding, sourceRef, cursor, limit);
  }

  async currentCursor(): Promise<string | null> {
    this.currentCursorCalls += 1;
    return this.headCursor;
  }

  async fingerprint(): Promise<string> {
    return 'fingerprint:v1';
  }
}

async function baselinedFixture(): Promise<{
  map: InstallationMap;
  source: TestSource;
  coordinator: (
    upload: (
      request: CloudUploadRequest,
    ) => Promise<ReturnType<typeof acknowledgement>>,
    overrides?: Partial<ConstructorParameters<typeof SyncCoordinator>[0]>,
  ) => SyncCoordinator;
}> {
  const map = installationMap();
  await map.enable(enableInput());
  const source = new TestSource();
  const baseline = coordinator({ map, source, upload: vi.fn() });
  await baseline.start();
  await baseline.stop();
  return {
    map,
    source,
    coordinator: (upload, overrides = {}) =>
      coordinator({ map, source, upload, ...overrides }),
  };
}

function coordinator(input: {
  map: InstallationMap;
  source: TestSource;
  upload: (
    request: CloudUploadRequest,
  ) => Promise<ReturnType<typeof acknowledgement>>;
  online?: () => boolean;
  retryDependencies?: ConstructorParameters<
    typeof SyncCoordinator
  >[0]['retryDependencies'];
  maxCompressedBatchBytes?: number;
  uploadPreparation?: ConstructorParameters<
    typeof SyncCoordinator
  >[0]['uploadPreparation'];
  watcher?: SourceChangeWatcher;
  scheduler?: ReconciliationScheduler;
}): SyncCoordinator {
  return new SyncCoordinator({
    installations: input.map,
    eventSources: [input.source],
    uploader: { upload: input.upload },
    connectivity: { isOnline: async () => input.online?.() ?? true },
    ...(input.watcher === undefined ? {} : { watcher: input.watcher }),
    ...(input.scheduler === undefined ? {} : { scheduler: input.scheduler }),
    ...(input.retryDependencies === undefined
      ? {}
      : { retryDependencies: input.retryDependencies }),
    ...(input.maxCompressedBatchBytes === undefined
      ? {}
      : { maxCompressedBatchBytes: input.maxCompressedBatchBytes }),
    ...(input.uploadPreparation === undefined
      ? {}
      : { uploadPreparation: input.uploadPreparation }),
  });
}

function appendPage(
  previousCursor: string,
  proposedCursor: string,
): SourceReadResult {
  return {
    events: [
      sourceEvent(
        { kind: 'message', role: 'user', text: 'Continue Phase 2.' },
        1,
      ),
    ],
    previousCursor,
    proposedCursor,
    hasMore: false,
  };
}

function emptyPage(cursor: string | null): SourceReadResult {
  return {
    events: [],
    previousCursor: cursor,
    proposedCursor: cursor ?? 'cursor:empty',
    hasMore: false,
  };
}

function sourceEvent(
  payload: SourceEventInput['payload'],
  nativeSequence: number,
): SourceEventInput {
  return {
    sourceSessionId: ids.session,
    workThreadId: null,
    sourceAgent: 'codex',
    sourceDeviceId: ids.device,
    nativeSequence,
    parentEventId: null,
    occurredAt: `2026-08-02T10:00:0${nativeSequence}Z`,
    observedAt: `2026-08-02T10:00:0${nativeSequence}Z`,
    schemaVersion: 1,
    payload,
  };
}

function decode(request: CloudUploadRequest): IngestionBatch {
  return IngestionBatchSchema.parse(
    JSON.parse(gunzipSync(request.body).toString('utf8')),
  );
}

function acknowledgement(
  batchId: string,
  acceptedEventIds: string[],
  headEventId: string | null,
  acknowledgedCursor: string,
) {
  return {
    batchId,
    acceptedEventIds,
    duplicateEventIds: [],
    headEventId,
    acknowledgedCursor,
    branchCreated: false,
  };
}

const canonicalizer: ProjectCanonicalizer = {
  canonicalize: async () => ({
    canonicalLocalPath: '/canonical/work/project',
    projectIdentity: identity,
  }),
};

function installationMap(): InstallationMap {
  return new InstallationMap(
    new MemoryInstallationStore(),
    canonicalizer,
    () => new Date('2026-08-02T10:00:00Z'),
  );
}

function enableInput(): EnableInstallationInput {
  return {
    localPath: '/work/project',
    projectInstallationId: ids.installation,
    cloudProjectId: ids.project,
    deviceId: ids.device,
    displayName: 'Baton',
    detectedAgents: ['codex'],
    consentRecordId: ids.consent,
    disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
    disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
    collectionPolicy: { ...DEFAULT_COLLECTION_POLICY },
    cloudProcessingAcknowledged: true,
    modelProcessingAcknowledged: true,
    captureSurface: 'cli',
    affirmativeEnable: true,
  };
}

function spacedText(seed: string, length: number): string {
  let value = '';
  for (let index = 0; value.length < length; index += 1) {
    value += `${seed}${String(index).padStart(6, '0')} `;
  }
  return value.slice(0, length);
}
