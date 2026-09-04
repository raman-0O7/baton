import { createHash } from 'node:crypto';

import {
  maxIngestionCompressedBytes,
  type IngestionBatchDraft,
  type SourceEventInput,
} from '@baton/protocol';

import {
  type EventSource,
  type SourceChangeWatcher,
  type SourceReadResult,
  type SourceSessionRef,
  bindingFromInstallation,
  sourceCheckpointKey,
} from './event-source.js';
import {
  type InstallationRecord,
  InstallationMap,
  InstallationStateError,
  type ProjectIdentity,
  type SourceCheckpoint,
} from './installation-map.js';
import { applyCollectionPolicy } from './policy.js';
import type { ReconciliationScheduler } from './scheduler.js';
import { SyncStatusTracker, initialStatus, type SyncStatus } from './status.js';
import {
  DEFAULT_RETRY_POLICY,
  UploadFailure,
  type CloudUploader,
  type ConnectivityProbe,
  type RetryDependencies,
  type RetryPolicy,
  type UploadPreparationOptions,
  prepareUploadWithParentLineage,
  uploadWithRetry,
} from './upload.js';

export interface SyncCoordinatorOptions {
  installations: InstallationMap;
  eventSources: EventSource[];
  uploader: CloudUploader;
  connectivity: ConnectivityProbe;
  watcher?: SourceChangeWatcher;
  scheduler?: ReconciliationScheduler;
  status?: SyncStatusTracker;
  retryPolicy?: RetryPolicy;
  retryDependencies?: RetryDependencies;
  uploadPreparation?: UploadPreparationOptions;
  maxCompressedBatchBytes?: number;
  maxEventsPerRead?: number;
  maxPagesPerSource?: number;
  targetUncompressedBytes?: number;
  now?: () => Date;
}

interface ActiveWatcher {
  close(): Promise<void>;
}

interface PendingRun {
  rerun: boolean;
  promise: Promise<void>;
}

/**
 * Coordinates a memory-only trigger queue. Failed bodies are discarded; the
 * unchanged operational cursor lets a later online reconciliation recreate the
 * exact canonical events and deterministic batch ID.
 */
export class SyncCoordinator {
  private readonly statusTracker: SyncStatusTracker;
  private readonly sourcesByName: Map<string, EventSource>;
  private readonly retryPolicy: RetryPolicy;
  private readonly maxCompressedBatchBytes: number;
  private readonly maxEventsPerRead: number;
  private readonly maxPagesPerSource: number;
  private readonly targetUncompressedBytes: number;
  private readonly now: () => Date;
  private readonly activeWatchers = new Map<ProjectIdentity, ActiveWatcher>();
  private readonly pending = new Map<ProjectIdentity, PendingRun>();
  private schedulerHandle: { close(): Promise<void> } | undefined;
  private started = false;

  constructor(private readonly options: SyncCoordinatorOptions) {
    this.statusTracker = options.status ?? new SyncStatusTracker();
    this.sourcesByName = new Map(
      options.eventSources.map((source) => [source.name, source]),
    );
    if (this.sourcesByName.size !== options.eventSources.length) {
      throw new TypeError('event source names must be unique');
    }
    this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this.maxCompressedBatchBytes =
      options.maxCompressedBatchBytes ?? maxIngestionCompressedBytes;
    this.maxEventsPerRead = options.maxEventsPerRead ?? 500;
    this.maxPagesPerSource = options.maxPagesPerSource ?? 100;
    this.targetUncompressedBytes =
      options.targetUncompressedBytes ?? 768 * 1_024;
    this.now = options.now ?? (() => new Date());
    if (
      this.maxCompressedBatchBytes < 1_024 ||
      this.maxEventsPerRead < 1 ||
      this.maxEventsPerRead > 500 ||
      this.maxPagesPerSource < 1 ||
      this.targetUncompressedBytes < 1_024
    ) {
      throw new TypeError('invalid sync batch or reconciliation limits');
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh();
    if (this.options.scheduler !== undefined) {
      this.schedulerHandle = this.options.scheduler.start(async () => {
        await this.reconcile();
      });
    }
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.started = false;
    const watchers = [...this.activeWatchers.values()];
    this.activeWatchers.clear();
    await Promise.all(watchers.map(async (watcher) => watcher.close()));
    await this.schedulerHandle?.close();
    this.schedulerHandle = undefined;
    await Promise.all([...this.pending.values()].map(({ promise }) => promise));
  }

  /** Refresh watcher/status state after an enable, pause, resume, or disable. */
  async refresh(): Promise<void> {
    const records = await this.options.installations.list();
    const enabled = new Set(
      records
        .filter((record) => record.state === 'enabled')
        .map((record) => record.projectIdentity),
    );

    for (const record of records) {
      const current = this.statusTracker.get(record.projectIdentity);
      const next = initialStatus({
        projectIdentity: record.projectIdentity,
        displayName: record.displayName,
        state: record.state,
        baselinePending: record.baselineState === 'pending',
      });
      this.statusTracker.set({
        ...next,
        lastAttemptAt: current?.lastAttemptAt ?? null,
        lastSuccessAt: current?.lastSuccessAt ?? null,
      });
    }

    for (const [identity, watcher] of this.activeWatchers) {
      if (!enabled.has(identity)) {
        this.activeWatchers.delete(identity);
        await watcher.close();
      }
    }

    if (this.options.watcher !== undefined) {
      for (const record of records) {
        if (
          record.state !== 'enabled' ||
          this.activeWatchers.has(record.projectIdentity)
        ) {
          continue;
        }
        const identity = record.projectIdentity;
        const watcher = await this.options.watcher.watch(
          bindingFromInstallation(record),
          () => {
            void this.trigger(identity);
          },
        );
        this.activeWatchers.set(identity, watcher);
      }
    }
  }

  async reconcile(): Promise<void> {
    if (!this.started) return;
    await this.refresh();
    await Promise.all(
      (await this.options.installations.listEnabled()).map(
        async (installation) => this.trigger(installation.projectIdentity),
      ),
    );
  }

  async trigger(identity: ProjectIdentity): Promise<void> {
    const active = this.pending.get(identity);
    if (active !== undefined) {
      active.rerun = true;
      this.statusTracker.patch(identity, {
        state: 'queued',
        summary: 'A new source change is queued behind the active sync.',
        pendingTriggers: 1,
      });
      return active.promise;
    }

    const run: PendingRun = {
      rerun: false,
      promise: Promise.resolve(),
    };
    run.promise = (async () => {
      do {
        run.rerun = false;
        await this.syncInstallation(identity);
      } while (run.rerun && this.started);
    })().finally(() => {
      this.pending.delete(identity);
    });
    this.pending.set(identity, run);
    return run.promise;
  }

  status(identity: ProjectIdentity): SyncStatus | null {
    return this.statusTracker.get(identity);
  }

  listStatus(): SyncStatus[] {
    return this.statusTracker.list();
  }

  private async syncInstallation(identity: ProjectIdentity): Promise<void> {
    const installation = await this.options.installations.get(identity);
    if (
      installation === null ||
      installation.state !== 'enabled' ||
      installation.consent.revokedAt !== null
    ) {
      return;
    }

    const attemptAt = this.now().toISOString();
    if (!(await this.options.connectivity.isOnline())) {
      this.statusTracker.patch(identity, {
        state: 'offline',
        summary:
          'Baton Cloud is unreachable; capture has not read or queued content.',
        nextAction:
          'Connect to the internet, then run baton status or wait for reconciliation.',
        pendingTriggers: 0,
        lastAttemptAt: attemptAt,
        errorCode: 'offline',
        retryable: true,
      });
      return;
    }

    this.statusTracker.patch(identity, {
      state:
        installation.baselineState === 'pending' ? 'initializing' : 'syncing',
      summary:
        installation.baselineState === 'pending'
          ? 'Establishing a cursor baseline without importing history.'
          : 'Uploading newly captured, policy-filtered events.',
      nextAction: null,
      pendingTriggers: 0,
      lastAttemptAt: attemptAt,
      errorCode: null,
      retryable: null,
    });

    try {
      if (installation.baselineState === 'pending') {
        await this.baseline(installation);
      } else {
        await this.capture(installation);
      }
      this.statusTracker.patch(identity, {
        state: 'watching',
        summary: 'Watching for new conversation events.',
        nextAction: null,
        lastSuccessAt: this.now().toISOString(),
        errorCode: null,
        retryable: null,
      });
    } catch (error) {
      this.reportFailure(identity, error);
    }
  }

  private async baseline(installation: InstallationRecord): Promise<void> {
    const binding = bindingFromInstallation(installation);
    for (const source of this.sourcesFor(installation)) {
      for (const ref of await source.discover(binding)) {
        const [cursor, fingerprint] = await Promise.all([
          source.currentCursor(binding, ref),
          source.fingerprint(binding, ref),
        ]);
        await this.options.installations.putCheckpoint(
          installation.projectIdentity,
          sourceCheckpointKey(source.name, ref),
          { cursor, fingerprint, headEventId: null },
          { consentRecordId: installation.consent.consentRecordId },
        );
      }
    }
    await this.options.installations.completeBaseline(
      installation.projectIdentity,
    );
  }

  private async capture(installation: InstallationRecord): Promise<void> {
    const binding = bindingFromInstallation(installation);
    for (const source of this.sourcesFor(installation)) {
      for (const ref of await source.discover(binding)) {
        await this.captureSource(installation, source, ref);
      }
    }
  }

  private async captureSource(
    installation: InstallationRecord,
    source: EventSource,
    ref: SourceSessionRef,
  ): Promise<void> {
    const binding = bindingFromInstallation(installation);
    const sourceKey = sourceCheckpointKey(source.name, ref);
    let checkpoint = installation.checkpoints[sourceKey];

    for (let page = 0; page < this.maxPagesPerSource; page += 1) {
      const current = await this.options.installations.get(
        installation.projectIdentity,
      );
      if (current?.state !== 'enabled' || current.consent.revokedAt !== null) {
        throw new InstallationStateError(
          'capture stopped before checkpoint advancement',
        );
      }
      let eventLimit = this.maxEventsPerRead;
      let read: SourceReadResult;
      let prepared: Awaited<
        ReturnType<typeof prepareUploadWithParentLineage>
      > | null = null;
      let filteredEvents: SourceEventInput[] = [];

      while (true) {
        read = await source.readSince(
          binding,
          ref,
          checkpoint?.cursor ?? null,
          {
            maxEvents: eventLimit,
            targetUncompressedBytes: this.targetUncompressedBytes,
          },
        );
        validateRead(read, checkpoint?.cursor ?? null, eventLimit);
        if (read.events.length === 0) {
          if (read.hasMore) {
            throw new UploadFailure({
              code: 'invalid_source_page',
              message: 'event source returned an empty page with more data',
              retryable: false,
            });
          }
          return;
        }

        const policyResult = applyCollectionPolicy(
          read.events,
          current.consent.collectionPolicy,
        );
        filteredEvents = policyResult.events;
        if (filteredEvents.length === 0) break;

        const draft: IngestionBatchDraft = {
          schemaVersion: 1,
          batchId: deriveBatchId({
            projectInstallationId: current.projectInstallationId,
            consentRecordId: current.consent.consentRecordId,
            sourceSessionId: ref.sourceSessionId,
            previousCursor: read.previousCursor,
            proposedCursor: read.proposedCursor,
          }),
          deviceId: current.deviceId,
          projectId: current.cloudProjectId,
          projectInstallationId: current.projectInstallationId,
          consentRecordId: current.consent.consentRecordId,
          policyVersion: current.consent.collectionPolicy.policyVersion,
          disclosureVersion: current.consent.disclosureVersion,
          source: {
            sourceSessionId: ref.sourceSessionId,
            agent: source.name,
            nativeSessionHash: ref.nativeSessionHash,
            parserVersion: ref.parserVersion,
          },
          expectedHeadEventId: checkpoint?.headEventId ?? null,
          previousCursor: read.previousCursor,
          proposedCursor: read.proposedCursor,
          events: filteredEvents,
        };
        prepared = await prepareUploadWithParentLineage(
          draft,
          checkpoint?.headEventId ?? null,
          this.options.uploadPreparation,
        );
        if (prepared.body.byteLength <= this.maxCompressedBatchBytes) break;
        if (read.events.length === 1 || eventLimit === 1) {
          throw new UploadFailure({
            code: 'batch_too_large',
            message: `one policy-filtered event exceeds the ${this.maxCompressedBatchBytes}-byte compressed batch limit`,
            retryable: false,
          });
        }
        eventLimit = Math.max(
          1,
          Math.min(eventLimit - 1, Math.floor(read.events.length / 2)),
        );
      }

      let headEventId = checkpoint?.headEventId ?? null;
      if (filteredEvents.length > 0 && prepared !== null) {
        const acknowledgement = await uploadWithRetry(
          this.options.uploader,
          prepared,
          this.retryPolicy,
          this.options.retryDependencies,
        );
        if (acknowledgement.acknowledgedCursor !== read.proposedCursor) {
          throw new UploadFailure({
            code: 'invalid_acknowledgement',
            message:
              'cloud acknowledgement cursor does not match the source page',
            retryable: false,
          });
        }
        headEventId = acknowledgement.headEventId;
      }

      const fingerprint = await source.fingerprint(binding, ref);
      await this.options.installations.putCheckpoint(
        installation.projectIdentity,
        sourceKey,
        {
          cursor: read.proposedCursor,
          fingerprint,
          headEventId,
        },
        {
          consentRecordId: current.consent.consentRecordId,
          expectedCursor: checkpoint?.cursor ?? null,
        },
      );
      checkpoint = checkpointValue(
        read.proposedCursor,
        fingerprint,
        headEventId,
        this.now(),
      );
      if (!read.hasMore) return;
    }

    throw new UploadFailure({
      code: 'reconciliation_limit',
      message: `source still has data after ${this.maxPagesPerSource} pages`,
      retryable: true,
    });
  }

  private sourcesFor(installation: InstallationRecord): EventSource[] {
    return installation.detectedAgents.map((agent) => {
      const source = this.sourcesByName.get(agent);
      if (source === undefined) {
        throw new UploadFailure({
          code: 'source_unavailable',
          message: `no ${agent} event source is installed`,
          retryable: false,
        });
      }
      return source;
    });
  }

  private reportFailure(identity: ProjectIdentity, error: unknown): void {
    if (error instanceof InstallationStateError) {
      this.statusTracker.patch(identity, {
        state: 'paused',
        summary: 'Capture stopped before its local checkpoint advanced.',
        nextAction: 'Review project controls, then resume or enable capture.',
        errorCode: 'capture_stopped',
        retryable: false,
      });
      return;
    }
    const failure =
      error instanceof UploadFailure
        ? error
        : new UploadFailure({
            code: 'sync_error',
            message: error instanceof Error ? error.message : 'sync failed',
            retryable: true,
          });
    const consentFailure =
      failure.code === 'consent_required' ||
      failure.code === 'project_disabled';
    this.statusTracker.patch(identity, {
      state: consentFailure ? 'action_required' : 'error',
      summary: consentFailure
        ? 'Baton Cloud rejected capture because project consent is no longer active.'
        : failure.message,
      nextAction: consentFailure
        ? 'Run baton enable to review and accept the current project disclosure.'
        : failure.retryable
          ? 'Check connectivity and run baton status; reconciliation will retry without a local content cache.'
          : 'Review the project policy or source error before resuming capture.',
      pendingTriggers: 0,
      errorCode: failure.code,
      retryable: failure.retryable,
    });
  }
}

function validateRead(
  read: SourceReadResult,
  expectedPreviousCursor: string | null,
  maxEvents: number,
): void {
  if (
    read.previousCursor !== expectedPreviousCursor ||
    read.proposedCursor.length < 1 ||
    read.proposedCursor.length > 2_048 ||
    read.events.length > maxEvents ||
    read.events.length > 500 ||
    (read.events.length > 0 && read.proposedCursor === read.previousCursor)
  ) {
    throw new UploadFailure({
      code: 'invalid_source_page',
      message: 'event source violated cursor or page-size invariants',
      retryable: false,
    });
  }
}

export function deriveBatchId(input: {
  projectInstallationId: string;
  consentRecordId: string;
  sourceSessionId: string;
  previousCursor: string | null;
  proposedCursor: string;
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }), 'utf8')
    .digest('hex');
  const variantNibble = (
    (Number.parseInt(digest.charAt(16), 16) & 0x3) |
    0x8
  ).toString(16);
  const uuidHex = `${digest.slice(0, 12)}8${digest.slice(13, 16)}${variantNibble}${digest.slice(17, 32)}`;
  return `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20, 32)}`;
}

function checkpointValue(
  cursor: string,
  fingerprint: string,
  headEventId: string | null,
  now: Date,
): SourceCheckpoint {
  return {
    cursor,
    fingerprint,
    headEventId,
    acknowledgedAt: now.toISOString(),
  };
}
