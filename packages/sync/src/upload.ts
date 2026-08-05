import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import {
  IngestionAcknowledgementSchema,
  type IngestionAcknowledgement,
  type IngestionBatchDraft,
} from '@baton/protocol';
import {
  encodeScrubbedUpload,
  scrubIngestionBatchDraft,
  type ScrubPolicy,
  type ScrubbedIngestionBatch,
} from '@baton/scrubber';

const gzipAsync = promisify(gzip);

export interface UploadSerializer {
  serialize(batch: ScrubbedIngestionBatch): Uint8Array;
}

export interface UploadCompressor {
  readonly contentEncoding: string;
  compress(input: Uint8Array): Promise<Uint8Array>;
}

export interface PreparedUpload {
  batchId: string;
  projectInstallationId: string;
  consentRecordId: string;
  policyVersion: string;
  disclosureVersion: string;
  /** Retries must pass this exact key unchanged. */
  idempotencyKey: string;
  contentEncoding: string;
  body: Uint8Array;
  eventCount: number;
  redactionCount: number;
}

/** Deliberately excludes local paths, native locators, and tenant selectors. */
export interface CloudUploadRequest extends PreparedUpload {}

export interface CloudUploader {
  upload(request: CloudUploadRequest): Promise<IngestionAcknowledgement>;
}

export interface ConnectivityProbe {
  isOnline(): Promise<boolean>;
}

export interface UploadPreparationOptions {
  scrubPolicy?: ScrubPolicy;
  serializer?: UploadSerializer;
  compressor?: UploadCompressor;
}

export const jsonUploadSerializer: UploadSerializer = {
  serialize: (batch) => Buffer.from(encodeScrubbedUpload(batch), 'utf8'),
};

export const gzipUploadCompressor: UploadCompressor = {
  contentEncoding: 'gzip',
  compress: async (input) => gzipAsync(input),
};

/** Scrubbing is an opaque capability created before serialization. */
export async function prepareUpload(
  draft: IngestionBatchDraft,
  options: UploadPreparationOptions = {},
): Promise<PreparedUpload> {
  const scrubbed = scrubIngestionBatchDraft(draft, options.scrubPolicy);
  return encodePreparedUpload(scrubbed, scrubbed.redactions.length, options);
}

/**
 * Scrub a preview to derive the canonical uploaded event IDs, then fill only
 * missing parent links. Parent links do not participate in event identity, so
 * the second scrub is idempotent and serialization still accepts only an
 * opaque scrubbed capability.
 */
export async function prepareUploadWithParentLineage(
  draft: IngestionBatchDraft,
  startingParentEventId: string | null,
  options: UploadPreparationOptions = {},
): Promise<PreparedUpload> {
  const preview = scrubIngestionBatchDraft(draft, options.scrubPolicy);
  let priorEventId = startingParentEventId;
  const linkedEvents = draft.events.map((event, index) => {
    const previewEvent = preview.batch.events[index]!;
    const linked = {
      ...event,
      payload: previewEvent.payload,
      parentEventId: event.parentEventId ?? priorEventId,
    };
    priorEventId = previewEvent.eventId;
    return linked;
  });
  const linked = scrubIngestionBatchDraft(
    { ...draft, events: linkedEvents },
    options.scrubPolicy,
  );
  return encodePreparedUpload(linked, preview.redactions.length, options);
}

async function encodePreparedUpload(
  scrubbed: ScrubbedIngestionBatch,
  redactionCount: number,
  options: UploadPreparationOptions,
): Promise<PreparedUpload> {
  const serializer = options.serializer ?? jsonUploadSerializer;
  const compressor = options.compressor ?? gzipUploadCompressor;
  const serialized = serializer.serialize(scrubbed);
  const body = await compressor.compress(serialized);
  return Object.freeze({
    batchId: scrubbed.batch.batchId,
    projectInstallationId: scrubbed.batch.projectInstallationId,
    consentRecordId: scrubbed.batch.consentRecordId,
    policyVersion: scrubbed.batch.policyVersion,
    disclosureVersion: scrubbed.batch.disclosureVersion,
    idempotencyKey: scrubbed.batch.batchId,
    contentEncoding: compressor.contentEncoding,
    body,
    eventCount: scrubbed.batch.events.length,
    redactionCount,
  });
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
  jitterRatio: 0.2,
});

export interface RetryDependencies {
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onRetry?: (event: { attempt: number; delayMs: number; code: string }) => void;
}

export async function uploadWithRetry(
  uploader: CloudUploader,
  prepared: PreparedUpload,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  dependencies: RetryDependencies = {},
): Promise<IngestionAcknowledgement> {
  validateRetryPolicy(policy);
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const parsed = IngestionAcknowledgementSchema.safeParse(
        await uploader.upload(prepared),
      );
      if (!parsed.success) {
        throw new UploadFailure({
          code: 'invalid_acknowledgement',
          message: 'cloud returned an invalid ingestion acknowledgement',
          retryable: false,
        });
      }
      const acknowledgement = parsed.data;
      if (acknowledgement.batchId !== prepared.batchId) {
        throw new UploadFailure({
          code: 'invalid_acknowledgement',
          message: 'cloud acknowledgement batch ID does not match request',
          retryable: false,
        });
      }
      return acknowledgement;
    } catch (error) {
      const failure = normalizeUploadFailure(error);
      if (!failure.retryable || attempt === policy.maxAttempts) throw failure;
      const delayMs = retryDelay(
        policy,
        attempt,
        random(),
        failure.retryAfterMs,
      );
      dependencies.onRetry?.({ attempt, delayMs, code: failure.code });
      await sleep(delayMs);
    }
  }
  throw new Error('unreachable retry state');
}

export class UploadFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(input: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  }) {
    super(input.message);
    this.name = 'UploadFailure';
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export function retryDelay(
  policy: RetryPolicy,
  failedAttempt: number,
  randomValue: number,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(policy.maxDelayMs, Math.max(0, retryAfterMs));
  }
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (failedAttempt - 1),
  );
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitter = (boundedRandom * 2 - 1) * policy.jitterRatio;
  return Math.max(0, Math.round(exponential * (1 + jitter)));
}

function normalizeUploadFailure(error: unknown): UploadFailure {
  if (error instanceof UploadFailure) return error;
  return new UploadFailure({
    code: 'network_error',
    message: error instanceof Error ? error.message : 'cloud upload failed',
    retryable: true,
  });
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (
    !Number.isInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 10 ||
    policy.baseDelayMs < 0 ||
    policy.maxDelayMs < policy.baseDelayMs ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new TypeError('invalid bounded retry policy');
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
