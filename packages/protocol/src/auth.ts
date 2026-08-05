import { z } from 'zod';

export const OAuthScopeSchema = z.enum([
  'account:read',
  'devices:read',
  'devices:write',
  'projects:read',
  'projects:write',
  'ingest:write',
  'work:read',
]);
export type OAuthScope = z.infer<typeof OAuthScopeSchema>;

export const DeviceAuthorizationRequestSchema = z
  .object({
    clientId: z.string().min(1).max(128),
    clientName: z.string().min(1).max(128),
    clientVersion: z.string().min(1).max(64),
    platform: z.string().min(1).max(64).default('unknown'),
    requestedScopes: z.array(OAuthScopeSchema).min(1),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      new Set(request.requestedScopes).size !== request.requestedScopes.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['requestedScopes'],
        message: 'requested OAuth scopes must be unique',
      });
    }
  });
export type DeviceAuthorizationRequest = z.infer<
  typeof DeviceAuthorizationRequestSchema
>;

export const DeviceAuthorizationResponseSchema = z
  .object({
    deviceCode: z.string().min(32).max(512),
    userCode: z.string().min(6).max(32),
    verificationUri: z.url(),
    verificationUriComplete: z.url(),
    expiresIn: z.int().positive().max(1800),
    interval: z.int().positive().max(30),
  })
  .strict();

const DeviceCodeTokenRequestSchema = z
  .object({
    grantType: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
    clientId: z.string().min(1).max(128),
    deviceCode: z.string().min(32).max(512),
  })
  .strict();

const RefreshTokenRequestSchema = z
  .object({
    grantType: z.literal('refresh_token'),
    clientId: z.string().min(1).max(128),
    refreshToken: z.string().min(32).max(2048),
  })
  .strict();

export const TokenRequestSchema = z.discriminatedUnion('grantType', [
  DeviceCodeTokenRequestSchema,
  RefreshTokenRequestSchema,
]);
export type TokenRequest = z.infer<typeof TokenRequestSchema>;

export const TokenResponseSchema = z
  .object({
    tokenType: z.literal('Bearer'),
    accessToken: z.string().min(32),
    expiresIn: z.int().positive(),
    refreshToken: z.string().min(32),
    scopes: z.array(OAuthScopeSchema).min(1),
    userId: z.uuid(),
    tenantId: z.uuid(),
    deviceId: z.uuid(),
  })
  .strict();
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export const DeviceApprovalRequestSchema = z
  .object({ userCode: z.string().min(6).max(32) })
  .strict();

export const DeviceApprovalResponseSchema = z
  .object({ approved: z.literal(true), deviceName: z.string().min(1).max(128) })
  .strict();

export const DeviceSchema = z
  .object({
    deviceId: z.uuid(),
    name: z.string().min(1).max(128),
    platform: z.string().min(1).max(64),
    clientVersion: z.string().min(1).max(64),
    createdAt: z.iso.datetime(),
    lastSeenAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict();
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListSchema = z
  .object({ devices: z.array(DeviceSchema).max(100) })
  .strict();

export const AccountSchema = z
  .object({
    userId: z.uuid(),
    tenantId: z.uuid(),
    email: z.email(),
    displayName: z.string().min(1).max(128),
    currentDeviceId: z.uuid().nullable(),
  })
  .strict();
export type Account = z.infer<typeof AccountSchema>;
