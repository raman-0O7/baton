import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollectionPolicySchema, type CollectionPolicy } from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  COLLECTION_DISCLOSURE_DIGEST,
  COLLECTION_DISCLOSURE_VERSION,
  DEFAULT_COLLECTION_POLICY,
  ConsentFlowError,
  FilesystemProjectCanonicalizer,
  InstallationConflictError,
  InstallationMap,
  InstallationStateError,
  JsonInstallationStore,
  MemoryInstallationStore,
  type EnableInstallationInput,
  type ProjectCanonicalizer,
  type ProjectIdentity,
} from '../src/index.js';

const ids = {
  installation: '018f0f90-1111-7111-8111-111111111111',
  project: '018f0f90-2222-7222-8222-222222222222',
  device: '018f0f90-3333-7333-8333-333333333333',
  consent: '018f0f90-4444-7444-8444-444444444444',
};
const identity = `project:v1:${'a'.repeat(64)}` as ProjectIdentity;
const now = new Date('2026-08-02T10:00:00Z');

describe('frozen collection contract', () => {
  it('pins the reviewed disclosure bytes and validates the default policy', () => {
    expect(COLLECTION_DISCLOSURE_VERSION).toBe('hosted-project-enable-v1');
    expect(COLLECTION_DISCLOSURE_DIGEST).toBe(
      '87c2bb9096b0305ecf58be016f10cee6302df7e07618238712a18c43ffcd2307',
    );
    expect(
      CollectionPolicySchema.safeParse(DEFAULT_COLLECTION_POLICY).success,
    ).toBe(true);
  });
});

describe('canonical installation map', () => {
  it('treats symlinks to the same project as one non-path map identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-sync-project-'));
    const project = join(root, 'project');
    const alias = join(root, 'alias');
    await mkdir(project, { recursive: true });
    try {
      await symlink(project, alias);
      const canonicalizer = new FilesystemProjectCanonicalizer();
      const direct = await canonicalizer.canonicalize(project);
      const indirect = await canonicalizer.canonicalize(alias);

      expect(indirect).toEqual(direct);
      expect(direct.projectIdentity).toMatch(/^project:v1:[a-f0-9]{64}$/);
      expect(direct.projectIdentity).not.toContain(project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('identifies a discovered project without enabling or persisting it', async () => {
    const map = installationMap();
    expect(await map.identify('/work/project')).toEqual({
      canonicalLocalPath: '/canonical/work/project',
      projectIdentity: identity,
    });
    expect(await map.list()).toEqual([]);
  });

  it('requires installation-specific affirmative consent and exposes controls', async () => {
    const map = installationMap();
    const enabled = await map.enable(enableInput());
    expect(enabled).toMatchObject({
      projectIdentity: identity,
      projectInstallationId: ids.installation,
      cloudProjectId: ids.project,
      deviceId: ids.device,
      state: 'enabled',
      baselineState: 'pending',
      consent: {
        consentRecordId: ids.consent,
        disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
        disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
        revokedAt: null,
      },
    });

    expect((await map.pause(identity)).state).toBe('paused');
    await expect(
      map.putCheckpoint(identity, 'source:v1:test', {
        cursor: 'cursor:paused',
        fingerprint: null,
        headEventId: null,
      }),
    ).rejects.toBeInstanceOf(InstallationStateError);
    const resumed = await map.resume(identity);
    expect(resumed.state).toBe('enabled');
    expect(resumed.baselineState).toBe('pending');
    await map.putCheckpoint(identity, 'source:v1:test', {
      cursor: 'cursor:1',
      fingerprint: 'fingerprint:1',
      headEventId: null,
    });
    const disabled = await map.disable(identity);
    expect(disabled.state).toBe('disabled');
    expect(disabled.consent.revokedAt).toBe(now.toISOString());
    await expect(map.resume(identity)).rejects.toBeInstanceOf(
      InstallationStateError,
    );

    const reenabled = await map.enable({
      ...enableInput(),
      consentRecordId: '018f0f90-5555-7555-8555-555555555555',
    });
    expect(reenabled.baselineState).toBe('pending');
    expect(reenabled.checkpoints['source:v1:test']?.cursor).toBe('cursor:1');
  });

  it('fails closed for wrong disclosure values and cross-device rebinding', async () => {
    const map = installationMap();
    await expect(
      map.enable({
        ...enableInput(),
        disclosureDigest: 'wrong' as typeof COLLECTION_DISCLOSURE_DIGEST,
      }),
    ).rejects.toThrow();

    await map.enable(enableInput());
    await expect(
      map.enable({
        ...enableInput(),
        deviceId: '018f0f90-9999-7999-8999-999999999999',
      }),
    ).rejects.toBeInstanceOf(InstallationConflictError);
  });

  it('allows a narrower policy but requires affirmation for widening', async () => {
    const map = installationMap();
    await map.enable(enableInput());
    const narrowPolicy: CollectionPolicy = {
      ...DEFAULT_COLLECTION_POLICY,
      allowedCategories: ['conversation_text'],
      excludedPathPatterns: [...DEFAULT_COLLECTION_POLICY.excludedPathPatterns],
    };
    await map.replaceConsent(identity, {
      ...consentProof(),
      consentRecordId: '018f0f90-5555-7555-8555-555555555555',
      collectionPolicy: narrowPolicy,
    });

    await expect(
      map.replaceConsent(identity, {
        ...consentProof(),
        consentRecordId: '018f0f90-6666-7666-8666-666666666666',
        collectionPolicy: {
          ...narrowPolicy,
          allowedCategories: ['conversation_text', 'diffs'],
        },
      }),
    ).rejects.toBeInstanceOf(ConsentFlowError);

    const widened = await map.replaceConsent(identity, {
      ...consentProof(),
      consentRecordId: '018f0f90-7777-7777-8777-777777777777',
      collectionPolicy: {
        ...narrowPolicy,
        allowedCategories: ['conversation_text', 'diffs'],
      },
      affirmativeWidening: true,
    });
    expect(widened.consent.collectionPolicy.allowedCategories).toContain(
      'diffs',
    );
  });

  it('writes only the local operational map with private file permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'baton-sync-map-'));
    const path = join(root, 'installations.json');
    const map = new InstallationMap(
      new JsonInstallationStore(path),
      canonicalizer,
      () => now,
    );
    try {
      await map.enable(enableInput());
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(await map.list()).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
    () => now,
  );
}

function consentProof() {
  return {
    consentRecordId: ids.consent,
    disclosureVersion: COLLECTION_DISCLOSURE_VERSION,
    disclosureDigest: COLLECTION_DISCLOSURE_DIGEST,
    collectionPolicy: { ...DEFAULT_COLLECTION_POLICY },
    cloudProcessingAcknowledged: true as const,
    modelProcessingAcknowledged: true as const,
    captureSurface: 'cli' as const,
  };
}

function enableInput(): EnableInstallationInput {
  return {
    localPath: '/work/project',
    projectInstallationId: ids.installation,
    cloudProjectId: ids.project,
    deviceId: ids.device,
    displayName: 'Baton',
    detectedAgents: ['codex'],
    ...consentProof(),
    affirmativeEnable: true,
  };
}
