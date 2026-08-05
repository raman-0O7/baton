import { describe, expect, it } from 'vitest';

import {
  ApiProblemSchema,
  CollectionPolicySchema,
  CreateConsentRequestSchema,
  DeviceAuthorizationResponseSchema,
  PageInfoSchema,
  TokenRequestSchema,
  UpdateProjectRequestSchema,
} from '../src/index.js';

const defaultPolicy = {
  policyVersion: '2026-08-01',
  allowedCategories: [
    'conversation_text',
    'plans_and_tasks',
    'session_metadata',
  ],
  excludedPathPatterns: ['**/.env', '**/credentials/**'],
  maxToolResultBytes: 65_536,
  maxDiffBytes: 262_144,
} as const;

describe('hosted product contracts', () => {
  it('accepts device-code and refresh-token grants only', () => {
    expect(
      TokenRequestSchema.safeParse({
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: 'd'.repeat(48),
      }).success,
    ).toBe(true);
    expect(
      TokenRequestSchema.safeParse({
        grantType: 'password',
        username: 'user@example.test',
        password: 'secret',
      }).success,
    ).toBe(false);
  });

  it('requires bounded device authorization polling instructions', () => {
    expect(
      DeviceAuthorizationResponseSchema.safeParse({
        deviceCode: 'd'.repeat(48),
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://app.baton.dev/activate',
        verificationUriComplete:
          'https://app.baton.dev/activate?user_code=ABCD-EFGH',
        expiresIn: 900,
        interval: 5,
      }).success,
    ).toBe(true);
  });

  it('rejects duplicate collection categories and empty updates', () => {
    expect(CollectionPolicySchema.safeParse(defaultPolicy).success).toBe(true);
    expect(
      CollectionPolicySchema.safeParse({
        ...defaultPolicy,
        allowedCategories: ['conversation_text', 'conversation_text'],
      }).success,
    ).toBe(false);
    expect(UpdateProjectRequestSchema.safeParse({}).success).toBe(false);
  });

  it('makes processing acknowledgements affirmative in consent records', () => {
    const consent = {
      projectInstallationId: '018f0f90-1111-7111-8111-111111111111',
      disclosureVersion: '2026-08-01',
      disclosureDigest: 'a'.repeat(64),
      collectionPolicy: defaultPolicy,
      cloudProcessingAcknowledged: true,
      modelProcessingAcknowledged: true,
      captureSurface: 'cli',
      historicalImport: false,
    };

    expect(CreateConsentRequestSchema.safeParse(consent).success).toBe(true);
    expect(
      CreateConsentRequestSchema.safeParse({
        ...consent,
        modelProcessingAcknowledged: false,
      }).success,
    ).toBe(false);
  });

  it('uses one strict problem format across APIs', () => {
    const problem = {
      type: 'https://api.baton.dev/problems/invalid-request',
      title: 'Invalid request',
      status: 400,
      code: 'invalid_request',
      requestId: 'req_01J0TEST',
    };

    expect(ApiProblemSchema.safeParse(problem).success).toBe(true);
    expect(
      ApiProblemSchema.safeParse({ ...problem, stack: 'sensitive details' })
        .success,
    ).toBe(false);
  });

  it('keeps readback pagination state internally consistent', () => {
    expect(
      PageInfoSchema.safeParse({ nextCursor: 'next:1', hasMore: true }).success,
    ).toBe(true);
    expect(
      PageInfoSchema.safeParse({ nextCursor: null, hasMore: true }).success,
    ).toBe(false);
  });
});
