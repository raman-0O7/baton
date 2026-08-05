import type {
  AccountRecord,
  AuditEventRecord,
  AuthPrincipal,
  DeviceApprovalResult,
  DeviceExchangeResult,
  DeviceGrantRecord,
  DeviceRecord,
  RefreshIssuance,
  RefreshRotationResult,
  StoredAccessToken,
  StoredBrowserSession,
  TokenIssuance,
  WebIdentity,
} from './types.js';

export interface IdentityStore {
  upsertAccount(identity: WebIdentity, now: number): Promise<AccountRecord>;
  getAccount(tenantId: string, userId: string): Promise<AccountRecord | null>;

  createBrowserSession(session: StoredBrowserSession): Promise<void>;
  findBrowserSession(sessionId: string): Promise<StoredBrowserSession | null>;

  createDeviceGrant(grant: DeviceGrantRecord): Promise<void>;
  approveDeviceGrant(
    userCodeHash: string,
    principal: AuthPrincipal,
    now: number,
  ): Promise<DeviceApprovalResult>;
  exchangeDeviceGrant(
    deviceCodeHash: string,
    now: number,
    issuance: TokenIssuance,
  ): Promise<DeviceExchangeResult>;

  findAccessToken(tokenId: string): Promise<StoredAccessToken | null>;
  rotateRefreshToken(
    tokenId: string,
    presentedHash: string,
    now: number,
    issuance: RefreshIssuance,
  ): Promise<RefreshRotationResult>;

  listDevices(tenantId: string, userId: string): Promise<DeviceRecord[]>;
  revokeDevice(
    tenantId: string,
    userId: string,
    deviceId: string,
    now: number,
  ): Promise<boolean>;
  revokeCredential(
    kind: 'access_token' | 'browser_session',
    credentialId: string,
    now: number,
  ): Promise<void>;

  appendAuditEvent(event: AuditEventRecord): Promise<void>;
  listAuditEvents(tenantId: string): Promise<AuditEventRecord[]>;
}
