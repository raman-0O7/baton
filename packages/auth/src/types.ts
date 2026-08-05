import type { OAuthScope } from '@baton/protocol';

export interface WebIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
}

export interface AccountRecord {
  userId: string;
  tenantId: string;
  issuer: string;
  subject: string;
  email: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export type CredentialKind = 'access_token' | 'browser_session';

export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  deviceId: string | null;
  scopes: OAuthScope[];
  credentialKind: CredentialKind;
  credentialId: string;
}

export interface DeviceRecord {
  deviceId: string;
  tenantId: string;
  userId: string;
  name: string;
  platform: string;
  clientVersion: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export type DeviceGrantStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceGrantRecord {
  grantId: string;
  deviceCodeHash: string;
  userCodeHash: string;
  clientId: string;
  deviceName: string;
  platform: string;
  clientVersion: string;
  scopes: OAuthScope[];
  status: DeviceGrantStatus;
  intervalSeconds: number;
  lastPolledAt: number | null;
  expiresAt: number;
  approvedUserId: string | null;
  approvedTenantId: string | null;
  consumedDeviceId: string | null;
  createdAt: number;
  approvedAt: number | null;
  consumedAt: number | null;
}

export interface StoredAccessToken {
  tokenId: string;
  tokenHash: string;
  familyId: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  scopes: OAuthScope[];
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface StoredRefreshToken {
  tokenId: string;
  tokenHash: string;
  familyId: string;
  tenantId: string;
  userId: string;
  deviceId: string;
  scopes: OAuthScope[];
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
  replacedByTokenId: string | null;
}

export interface StoredBrowserSession {
  sessionId: string;
  sessionHash: string;
  tenantId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

export interface TokenIssuance {
  device: DeviceRecord;
  accessToken: StoredAccessToken;
  refreshToken: StoredRefreshToken;
}

export interface RefreshIssuance {
  accessToken: StoredAccessToken;
  refreshToken: StoredRefreshToken;
}

export interface AuditEventRecord {
  auditEventId: string;
  tenantId: string | null;
  actorUserId: string | null;
  actorDeviceId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  requestId: string;
  metadata: Record<string, string | number | boolean | null>;
  occurredAt: number;
}

export type DeviceApprovalResult =
  | { status: 'approved'; deviceName: string }
  | { status: 'not_found' | 'expired' | 'already_completed' };

export type DeviceExchangeResult =
  | { status: 'issued'; account: AccountRecord; issuance: TokenIssuance }
  | {
      status:
        | 'not_found'
        | 'expired'
        | 'pending'
        | 'slow_down'
        | 'denied'
        | 'consumed';
      intervalSeconds?: number;
    };

export type RefreshRotationResult =
  | { status: 'rotated'; account: AccountRecord; issuance: RefreshIssuance }
  | {
      status: 'not_found' | 'invalid' | 'expired' | 'replayed' | 'revoked';
    };
