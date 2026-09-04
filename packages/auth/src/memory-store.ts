import { randomUUID } from 'node:crypto';

import { tokenHashMatches } from './crypto.js';
import type { IdentityStore } from './store.js';
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
  StoredRefreshToken,
  TokenIssuance,
  WebIdentity,
} from './types.js';

export class InMemoryIdentityStore implements IdentityStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private readonly identityAccounts = new Map<string, string>();
  private readonly browserSessions = new Map<string, StoredBrowserSession>();
  private readonly grants = new Map<string, DeviceGrantRecord>();
  private readonly grantsByUserCode = new Map<string, string>();
  private readonly accessTokens = new Map<string, StoredAccessToken>();
  private readonly refreshTokens = new Map<string, StoredRefreshToken>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly auditEvents: AuditEventRecord[] = [];
  private lockTail: Promise<void> = Promise.resolve();

  async upsertAccount(
    identity: WebIdentity,
    now: number,
  ): Promise<AccountRecord> {
    return this.lock(async () => {
      const identityKey = `${identity.issuer}\u0000${identity.subject}`;
      const existingId = this.identityAccounts.get(identityKey);
      if (existingId !== undefined) {
        const existing = this.accounts.get(existingId)!;
        const updated = {
          ...existing,
          email: identity.email,
          displayName: identity.displayName,
          updatedAt: now,
        };
        this.accounts.set(existingId, updated);
        return structuredClone(updated);
      }
      const account: AccountRecord = {
        userId: randomUUID(),
        tenantId: randomUUID(),
        ...identity,
        createdAt: now,
        updatedAt: now,
      };
      this.accounts.set(account.userId, account);
      this.identityAccounts.set(identityKey, account.userId);
      return structuredClone(account);
    });
  }

  async getAccount(
    tenantId: string,
    userId: string,
  ): Promise<AccountRecord | null> {
    const account = this.accounts.get(userId);
    return account?.tenantId === tenantId ? structuredClone(account) : null;
  }

  async createBrowserSession(session: StoredBrowserSession): Promise<void> {
    await this.lock(() =>
      this.browserSessions.set(session.sessionId, structuredClone(session)),
    );
  }

  async findBrowserSession(
    sessionId: string,
  ): Promise<StoredBrowserSession | null> {
    const session = this.browserSessions.get(sessionId);
    return session === undefined ? null : structuredClone(session);
  }

  async createDeviceGrant(grant: DeviceGrantRecord): Promise<void> {
    await this.lock(() => {
      this.grants.set(grant.grantId, structuredClone(grant));
      this.grantsByUserCode.set(grant.userCodeHash, grant.grantId);
    });
  }

  async approveDeviceGrant(
    userCodeHash: string,
    principal: AuthPrincipal,
    now: number,
  ): Promise<DeviceApprovalResult> {
    return this.lock(() => {
      const grantId = this.grantsByUserCode.get(userCodeHash);
      const grant =
        grantId === undefined ? undefined : this.grants.get(grantId);
      if (grant === undefined) return { status: 'not_found' };
      if (grant.expiresAt <= now) return { status: 'expired' };
      if (grant.status !== 'pending') return { status: 'already_completed' };
      grant.status = 'approved';
      grant.approvedUserId = principal.userId;
      grant.approvedTenantId = principal.tenantId;
      grant.approvedAt = now;
      return { status: 'approved', deviceName: grant.deviceName };
    });
  }

  async exchangeDeviceGrant(
    deviceCodeHash: string,
    now: number,
    issuance: TokenIssuance,
  ): Promise<DeviceExchangeResult> {
    return this.lock(() => {
      const grant = [...this.grants.values()].find(
        (candidate) => candidate.deviceCodeHash === deviceCodeHash,
      );
      if (grant === undefined) return { status: 'not_found' };
      if (grant.expiresAt <= now) return { status: 'expired' };
      if (
        grant.lastPolledAt !== null &&
        now < grant.lastPolledAt + grant.intervalSeconds * 1000
      ) {
        grant.intervalSeconds = Math.min(30, grant.intervalSeconds + 5);
        grant.lastPolledAt = now;
        return { status: 'slow_down', intervalSeconds: grant.intervalSeconds };
      }
      grant.lastPolledAt = now;
      if (grant.status === 'pending') {
        return { status: 'pending', intervalSeconds: grant.intervalSeconds };
      }
      if (grant.status === 'denied') return { status: 'denied' };
      if (grant.status === 'consumed') return { status: 'consumed' };
      if (grant.approvedTenantId === null || grant.approvedUserId === null) {
        return { status: 'denied' };
      }
      const account = this.accounts.get(grant.approvedUserId);
      if (
        account === undefined ||
        account.tenantId !== grant.approvedTenantId
      ) {
        return { status: 'denied' };
      }
      grant.status = 'consumed';
      grant.consumedAt = now;
      const hydratedIssuance: TokenIssuance = {
        device: {
          ...issuance.device,
          tenantId: grant.approvedTenantId,
          userId: grant.approvedUserId,
          name: grant.deviceName,
          platform: grant.platform,
          clientVersion: grant.clientVersion,
        },
        accessToken: {
          ...issuance.accessToken,
          tenantId: grant.approvedTenantId,
          userId: grant.approvedUserId,
          deviceId: issuance.device.deviceId,
          scopes: [...grant.scopes],
        },
        refreshToken: {
          ...issuance.refreshToken,
          tenantId: grant.approvedTenantId,
          userId: grant.approvedUserId,
          deviceId: issuance.device.deviceId,
          scopes: [...grant.scopes],
        },
      };
      grant.consumedDeviceId = hydratedIssuance.device.deviceId;
      this.devices.set(
        hydratedIssuance.device.deviceId,
        structuredClone(hydratedIssuance.device),
      );
      this.accessTokens.set(
        hydratedIssuance.accessToken.tokenId,
        structuredClone(hydratedIssuance.accessToken),
      );
      this.refreshTokens.set(
        hydratedIssuance.refreshToken.tokenId,
        structuredClone(hydratedIssuance.refreshToken),
      );
      return {
        status: 'issued',
        account: structuredClone(account),
        issuance: structuredClone(hydratedIssuance),
      };
    });
  }

  async findAccessToken(tokenId: string): Promise<StoredAccessToken | null> {
    const record = this.accessTokens.get(tokenId);
    if (record === undefined) return null;
    const device = this.devices.get(record.deviceId);
    if (device === undefined || device.revokedAt !== null) {
      return {
        ...structuredClone(record),
        revokedAt: device?.revokedAt ?? record.revokedAt ?? 0,
      };
    }
    return structuredClone(record);
  }

  async rotateRefreshToken(
    tokenId: string,
    presentedHash: string,
    now: number,
    issuance: RefreshIssuance,
  ): Promise<RefreshRotationResult> {
    return this.lock(() => {
      const current = this.refreshTokens.get(tokenId);
      if (current === undefined) return { status: 'not_found' };
      if (!tokenHashMatches(current.tokenHash, presentedHash))
        return { status: 'invalid' };
      if (current.expiresAt <= now) return { status: 'expired' };
      const device = this.devices.get(current.deviceId);
      if (
        device === undefined ||
        device.revokedAt !== null ||
        current.revokedAt !== null
      ) {
        return { status: 'revoked' };
      }
      if (current.usedAt !== null) {
        this.revokeFamily(current.familyId, now);
        return { status: 'replayed' };
      }
      const account = this.accounts.get(current.userId);
      if (account === undefined || account.tenantId !== current.tenantId) {
        return { status: 'revoked' };
      }
      current.usedAt = now;
      const hydratedIssuance: RefreshIssuance = {
        accessToken: {
          ...issuance.accessToken,
          familyId: current.familyId,
          tenantId: current.tenantId,
          userId: current.userId,
          deviceId: current.deviceId,
          scopes: [...current.scopes],
        },
        refreshToken: {
          ...issuance.refreshToken,
          familyId: current.familyId,
          tenantId: current.tenantId,
          userId: current.userId,
          deviceId: current.deviceId,
          scopes: [...current.scopes],
        },
      };
      current.replacedByTokenId = hydratedIssuance.refreshToken.tokenId;
      this.accessTokens.set(
        hydratedIssuance.accessToken.tokenId,
        structuredClone(hydratedIssuance.accessToken),
      );
      this.refreshTokens.set(
        hydratedIssuance.refreshToken.tokenId,
        structuredClone(hydratedIssuance.refreshToken),
      );
      device.lastSeenAt = now;
      return {
        status: 'rotated',
        account: structuredClone(account),
        issuance: structuredClone(hydratedIssuance),
      };
    });
  }

  async listDevices(tenantId: string, userId: string): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter(
        (device) => device.tenantId === tenantId && device.userId === userId,
      )
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((device) => structuredClone(device));
  }

  async revokeDevice(
    tenantId: string,
    userId: string,
    deviceId: string,
    now: number,
  ): Promise<boolean> {
    return this.lock(() => {
      const device = this.devices.get(deviceId);
      if (
        device === undefined ||
        device.tenantId !== tenantId ||
        device.userId !== userId
      ) {
        return false;
      }
      device.revokedAt ??= now;
      for (const token of this.accessTokens.values()) {
        if (token.deviceId === deviceId) token.revokedAt ??= now;
      }
      for (const token of this.refreshTokens.values()) {
        if (token.deviceId === deviceId) token.revokedAt ??= now;
      }
      return true;
    });
  }

  async revokeCredential(
    kind: 'access_token' | 'browser_session',
    credentialId: string,
    now: number,
  ): Promise<void> {
    await this.lock(() => {
      if (kind === 'browser_session') {
        const session = this.browserSessions.get(credentialId);
        if (session !== undefined) session.revokedAt ??= now;
      } else {
        const access = this.accessTokens.get(credentialId);
        if (access !== undefined) this.revokeFamily(access.familyId, now);
      }
    });
  }

  async appendAuditEvent(event: AuditEventRecord): Promise<void> {
    await this.lock(() => this.auditEvents.push(structuredClone(event)));
  }

  async listAuditEvents(tenantId: string): Promise<AuditEventRecord[]> {
    return this.auditEvents
      .filter((event) => event.tenantId === tenantId)
      .map((event) => structuredClone(event));
  }

  private revokeFamily(familyId: string, now: number): void {
    for (const token of this.accessTokens.values()) {
      if (token.familyId === familyId) token.revokedAt ??= now;
    }
    for (const token of this.refreshTokens.values()) {
      if (token.familyId === familyId) token.revokedAt ??= now;
    }
  }

  private async lock<T>(operation: () => T | Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lockTail;
    this.lockTail = previous.then(() => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
