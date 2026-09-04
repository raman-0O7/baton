import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, normalize, resolve, sep } from 'node:path';

import {
  AgentNameSchema,
  CollectionPolicySchema,
  ConsentCaptureSurfaceSchema,
  type AgentName,
  type CollectionPolicy,
} from '@baton/protocol';
import { z } from 'zod';

import {
  COLLECTION_DISCLOSURE_DIGEST,
  COLLECTION_DISCLOSURE_VERSION,
  isPolicyWidening,
} from './disclosure.js';

export type ProjectIdentity = `project:v1:${string}`;

const ProjectIdentitySchema = z.custom<ProjectIdentity>(
  (value) =>
    typeof value === 'string' && /^project:v1:[a-f0-9]{64}$/.test(value),
  'invalid canonical project identity',
);
const IsoDateSchema = z.iso.datetime();

export const SourceCheckpointSchema = z
  .object({
    cursor: z.string().max(2048).nullable(),
    fingerprint: z.string().max(256).nullable(),
    headEventId: z.uuid().nullable(),
    acknowledgedAt: IsoDateSchema,
  })
  .strict();
export type SourceCheckpoint = z.infer<typeof SourceCheckpointSchema>;

export const LocalConsentSchema = z
  .object({
    consentRecordId: z.uuid(),
    disclosureVersion: z.literal(COLLECTION_DISCLOSURE_VERSION),
    disclosureDigest: z.literal(COLLECTION_DISCLOSURE_DIGEST),
    collectionPolicy: CollectionPolicySchema,
    cloudProcessingAcknowledged: z.literal(true),
    modelProcessingAcknowledged: z.literal(true),
    captureSurface: ConsentCaptureSurfaceSchema,
    acceptedAt: IsoDateSchema,
    revokedAt: IsoDateSchema.nullable(),
  })
  .strict();
export type LocalConsent = z.infer<typeof LocalConsentSchema>;

export const InstallationRecordSchema = z
  .object({
    projectIdentity: ProjectIdentitySchema,
    projectInstallationId: z.uuid(),
    cloudProjectId: z.uuid(),
    deviceId: z.uuid(),
    displayName: z.string().min(1).max(128),
    canonicalLocalPath: z.string().min(1),
    detectedAgents: z.array(AgentNameSchema).max(3),
    state: z.enum(['enabled', 'paused', 'disabled']),
    baselineState: z.enum(['pending', 'complete']),
    consent: LocalConsentSchema,
    checkpoints: z.record(z.string(), SourceCheckpointSchema),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (new Set(record.detectedAgents).size !== record.detectedAgents.length) {
      context.addIssue({
        code: 'custom',
        path: ['detectedAgents'],
        message: 'detected agents must be unique',
      });
    }
    if (record.state === 'disabled' && record.consent.revokedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['consent', 'revokedAt'],
        message: 'disabled installations must revoke local consent',
      });
    }
    if (record.state !== 'disabled' && record.consent.revokedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['consent', 'revokedAt'],
        message: 'active installations require non-revoked consent',
      });
    }
  });
export type InstallationRecord = z.infer<typeof InstallationRecordSchema>;

const InstallationDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    installations: z.record(ProjectIdentitySchema, InstallationRecordSchema),
  })
  .strict();
type InstallationDocument = z.infer<typeof InstallationDocumentSchema>;

export interface InstallationStore {
  load(): Promise<unknown>;
  save(document: InstallationDocument): Promise<void>;
}

export class MemoryInstallationStore implements InstallationStore {
  private document: unknown = { schemaVersion: 1, installations: {} };

  async load(): Promise<unknown> {
    return structuredClone(this.document);
  }

  async save(document: InstallationDocument): Promise<void> {
    this.document = structuredClone(document);
  }
}

/** Stores operational consent/checkpoints only; never conversation content. */
export class JsonInstallationStore implements InstallationStore {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as unknown;
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return { schemaVersion: 1, installations: {} };
      }
      throw error;
    }
  }

  async save(document: InstallationDocument): Promise<void> {
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, this.path);
  }
}

export interface ProjectCanonicalizer {
  canonicalize(localPath: string): Promise<{
    canonicalLocalPath: string;
    projectIdentity: ProjectIdentity;
  }>;
}

export class FilesystemProjectCanonicalizer implements ProjectCanonicalizer {
  async canonicalize(localPath: string): Promise<{
    canonicalLocalPath: string;
    projectIdentity: ProjectIdentity;
  }> {
    const canonicalLocalPath = normalizeCanonicalPath(
      await realpath(resolve(localPath)),
    );
    const digest = createHash('sha256')
      .update(`baton-project-v1\0${canonicalLocalPath}`, 'utf8')
      .digest('hex');
    return {
      canonicalLocalPath,
      projectIdentity: `project:v1:${digest}`,
    };
  }
}

export interface EnableInstallationInput {
  localPath: string;
  projectInstallationId: string;
  cloudProjectId: string;
  deviceId: string;
  displayName: string;
  detectedAgents: AgentName[];
  consentRecordId: string;
  collectionPolicy: CollectionPolicy;
  disclosureVersion: typeof COLLECTION_DISCLOSURE_VERSION;
  disclosureDigest: typeof COLLECTION_DISCLOSURE_DIGEST;
  cloudProcessingAcknowledged: true;
  modelProcessingAcknowledged: true;
  captureSurface: 'cli' | 'dashboard';
  /** Must come from a dedicated, unchecked-by-default enable action. */
  affirmativeEnable: true;
}

export interface ReplaceConsentInput extends Omit<
  LocalConsent,
  'acceptedAt' | 'revokedAt'
> {
  /** Required when categories or caps widen. */
  affirmativeWidening?: true;
}

export class InstallationMap {
  private operation = Promise.resolve();

  constructor(
    private readonly store: InstallationStore,
    private readonly canonicalizer: ProjectCanonicalizer = new FilesystemProjectCanonicalizer(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async identify(localPath: string): Promise<{
    canonicalLocalPath: string;
    projectIdentity: ProjectIdentity;
  }> {
    return this.canonicalizer.canonicalize(localPath);
  }

  async enable(input: EnableInstallationInput): Promise<InstallationRecord> {
    if (input.affirmativeEnable !== true) {
      throw new ConsentFlowError('project enablement must be affirmative');
    }
    return this.lock(async () => {
      const identified = await this.identify(input.localPath);
      const document = await this.document();
      const existing = document.installations[identified.projectIdentity];
      if (
        existing !== undefined &&
        (existing.cloudProjectId !== input.cloudProjectId ||
          existing.deviceId !== input.deviceId ||
          existing.projectInstallationId !== input.projectInstallationId)
      ) {
        throw new InstallationConflictError(
          'this canonical project is already bound to a different cloud installation or device',
        );
      }
      const timestamp = this.now().toISOString();
      const record = InstallationRecordSchema.parse({
        projectIdentity: identified.projectIdentity,
        projectInstallationId: input.projectInstallationId,
        cloudProjectId: input.cloudProjectId,
        deviceId: input.deviceId,
        displayName: input.displayName,
        canonicalLocalPath: identified.canonicalLocalPath,
        detectedAgents: input.detectedAgents,
        state: 'enabled',
        // Re-enable baselines again, so time spent disabled is never imported.
        baselineState: 'pending',
        consent: {
          consentRecordId: input.consentRecordId,
          disclosureVersion: input.disclosureVersion,
          disclosureDigest: input.disclosureDigest,
          collectionPolicy: input.collectionPolicy,
          cloudProcessingAcknowledged: input.cloudProcessingAcknowledged,
          modelProcessingAcknowledged: input.modelProcessingAcknowledged,
          captureSurface: input.captureSurface,
          acceptedAt: timestamp,
          revokedAt: null,
        },
        checkpoints: existing?.checkpoints ?? {},
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      document.installations[record.projectIdentity] = record;
      await this.store.save(document);
      return structuredClone(record);
    });
  }

  async pause(identity: ProjectIdentity): Promise<InstallationRecord> {
    return this.transition(identity, (record, timestamp) => {
      if (record.state === 'disabled') {
        throw new InstallationStateError(
          'disabled installation must be explicitly enabled with new consent',
        );
      }
      return { ...record, state: 'paused', updatedAt: timestamp };
    });
  }

  async resume(identity: ProjectIdentity): Promise<InstallationRecord> {
    return this.transition(identity, (record, timestamp) => {
      if (record.state === 'disabled' || record.consent.revokedAt !== null) {
        throw new InstallationStateError(
          'disabled installation must be explicitly enabled with new consent',
        );
      }
      // A pause stops capture, rather than deferring it. Establish a fresh
      // baseline so content created during the paused window is not uploaded.
      return {
        ...record,
        state: 'enabled',
        baselineState: 'pending',
        updatedAt: timestamp,
      };
    });
  }

  async disable(identity: ProjectIdentity): Promise<InstallationRecord> {
    return this.transition(identity, (record, timestamp) => ({
      ...record,
      state: 'disabled',
      baselineState: 'pending',
      consent: { ...record.consent, revokedAt: timestamp },
      updatedAt: timestamp,
    }));
  }

  async replaceConsent(
    identity: ProjectIdentity,
    input: ReplaceConsentInput,
  ): Promise<InstallationRecord> {
    return this.transition(identity, (record, timestamp) => {
      if (
        isPolicyWidening(
          record.consent.collectionPolicy,
          input.collectionPolicy,
        ) &&
        input.affirmativeWidening !== true
      ) {
        throw new ConsentFlowError(
          'widening collection requires a new affirmative confirmation',
        );
      }
      const { affirmativeWidening: _affirmativeWidening, ...proof } = input;
      const consent = LocalConsentSchema.parse({
        ...proof,
        acceptedAt: timestamp,
        revokedAt: null,
      });
      return { ...record, consent, updatedAt: timestamp };
    });
  }

  async completeBaseline(identity: ProjectIdentity): Promise<void> {
    await this.transition(identity, (record, timestamp) => ({
      ...record,
      baselineState: 'complete',
      updatedAt: timestamp,
    }));
  }

  async putCheckpoint(
    identity: ProjectIdentity,
    sourceKey: string,
    checkpoint: Omit<SourceCheckpoint, 'acknowledgedAt'>,
    guard?: {
      consentRecordId: string;
      expectedCursor?: string | null;
    },
  ): Promise<void> {
    await this.transition(identity, (record, timestamp) => {
      if (record.state !== 'enabled' || record.consent.revokedAt !== null) {
        throw new InstallationStateError(
          'checkpoint cannot advance while capture is paused or disabled',
        );
      }
      if (
        guard !== undefined &&
        record.consent.consentRecordId !== guard.consentRecordId
      ) {
        throw new InstallationStateError(
          'consent changed before checkpoint advancement',
        );
      }
      if (
        guard?.expectedCursor !== undefined &&
        (record.checkpoints[sourceKey]?.cursor ?? null) !== guard.expectedCursor
      ) {
        throw new InstallationStateError(
          'source cursor changed before checkpoint advancement',
        );
      }
      return {
        ...record,
        checkpoints: {
          ...record.checkpoints,
          [sourceKey]: { ...checkpoint, acknowledgedAt: timestamp },
        },
        updatedAt: timestamp,
      };
    });
  }

  async get(identity: ProjectIdentity): Promise<InstallationRecord | null> {
    const record = (await this.document()).installations[identity];
    return record === undefined ? null : structuredClone(record);
  }

  async list(): Promise<InstallationRecord[]> {
    return Object.values((await this.document()).installations)
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((record) => structuredClone(record));
  }

  async listEnabled(): Promise<InstallationRecord[]> {
    return (await this.list()).filter(
      (record) =>
        record.state === 'enabled' && record.consent.revokedAt === null,
    );
  }

  private async transition(
    identity: ProjectIdentity,
    update: (
      record: InstallationRecord,
      timestamp: string,
    ) => InstallationRecord,
  ): Promise<InstallationRecord> {
    return this.lock(async () => {
      const document = await this.document();
      const current = document.installations[identity];
      if (current === undefined) throw new InstallationNotFoundError(identity);
      const next = InstallationRecordSchema.parse(
        update(current, this.now().toISOString()),
      );
      document.installations[identity] = next;
      await this.store.save(document);
      return structuredClone(next);
    });
  }

  private async document(): Promise<InstallationDocument> {
    return InstallationDocumentSchema.parse(await this.store.load());
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolveOperation) => {
      release = resolveOperation;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class ConsentFlowError extends Error {}
export class InstallationConflictError extends Error {}
export class InstallationStateError extends Error {}
export class InstallationNotFoundError extends Error {
  constructor(identity: ProjectIdentity) {
    super(`installation not found: ${identity}`);
  }
}

function normalizeCanonicalPath(path: string): string {
  let normalized = normalize(path);
  while (normalized.length > sep.length && normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -sep.length);
  }
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
