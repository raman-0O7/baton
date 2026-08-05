import { randomUUID } from 'node:crypto';

import {
  DeviceAuthorizationRequestSchema,
  TokenRequestSchema,
  type Account,
  type Device,
  type DeviceAuthorizationRequest,
  type OAuthScope,
  type TokenRequest,
  type TokenResponse,
} from '@baton/protocol';

import {
  createDeviceCode,
  createOpaqueToken,
  createUserCode,
  hashToken,
  normalizeUserCode,
  parseOpaqueToken,
  tokenHashMatches,
} from './crypto.js';
import { AuthError } from './errors.js';
import type { IdentityStore } from './store.js';
import type {
  AccountRecord,
  AuditEventRecord,
  AuthPrincipal,
  DeviceRecord,
  RefreshIssuance,
  StoredAccessToken,
  StoredBrowserSession,
  StoredRefreshToken,
  TokenIssuance,
  WebIdentity,
} from './types.js';

export interface IdentityServiceConfig {
  tokenPepper: string;
  verificationUri: string;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  browserSessionTtlSeconds?: number;
  deviceCodeTtlSeconds?: number;
  devicePollingIntervalSeconds?: number;
  allowedClientIds?: readonly string[];
}

export interface BrowserSessionResult {
  account: Account;
  sessionToken: string;
  expiresAt: string;
}

export interface DeviceAuthorizationResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface RequestAuditContext {
  requestId: string;
}

export class IdentityService {
  private readonly accessTtlMs: number;
  private readonly refreshTtlMs: number;
  private readonly browserTtlMs: number;
  private readonly deviceCodeTtlMs: number;
  private readonly pollingIntervalSeconds: number;
  private readonly allowedClientIds: ReadonlySet<string>;

  constructor(
    private readonly store: IdentityStore,
    private readonly config: IdentityServiceConfig,
    private readonly now: () => number = Date.now,
  ) {
    if (config.tokenPepper.length < 32) {
      throw new TypeError(
        'identity token pepper must contain at least 32 characters',
      );
    }
    this.accessTtlMs = (config.accessTokenTtlSeconds ?? 900) * 1000;
    this.refreshTtlMs = (config.refreshTokenTtlSeconds ?? 7_776_000) * 1000;
    this.browserTtlMs = (config.browserSessionTtlSeconds ?? 43_200) * 1000;
    this.deviceCodeTtlMs = (config.deviceCodeTtlSeconds ?? 900) * 1000;
    this.pollingIntervalSeconds = config.devicePollingIntervalSeconds ?? 5;
    this.allowedClientIds = new Set(config.allowedClientIds ?? ['baton-cli']);
    if (this.allowedClientIds.size === 0) {
      throw new TypeError('at least one OAuth client ID must be allowed');
    }
  }

  async establishBrowserSession(
    identity: WebIdentity,
    audit: RequestAuditContext,
  ): Promise<BrowserSessionResult> {
    const now = this.now();
    const account = await this.store.upsertAccount(identity, now);
    const token = createOpaqueToken('bat_bs');
    const session: StoredBrowserSession = {
      sessionId: token.id,
      sessionHash: hashToken(token.secret, this.config.tokenPepper),
      tenantId: account.tenantId,
      userId: account.userId,
      createdAt: now,
      expiresAt: now + this.browserTtlMs,
      revokedAt: null,
    };
    await this.store.createBrowserSession(session);
    await this.audit(
      account,
      null,
      'identity.web_login.completed',
      'browser_session',
      session.sessionId,
      audit,
    );
    return {
      account: accountResponse(account, null),
      sessionToken: token.value,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  async authenticateBrowserSession(rawToken: string): Promise<AuthPrincipal> {
    const parsed = parseOpaqueToken(rawToken, 'bat_bs');
    if (parsed === null) throw unauthorized();
    const record = await this.store.findBrowserSession(parsed.id);
    const presented = hashToken(parsed.secret, this.config.tokenPepper);
    if (
      record === null ||
      record.revokedAt !== null ||
      record.expiresAt <= this.now() ||
      !tokenHashMatches(record.sessionHash, presented)
    ) {
      throw unauthorized();
    }
    return {
      tenantId: record.tenantId,
      userId: record.userId,
      deviceId: null,
      scopes: allBrowserScopes,
      credentialKind: 'browser_session',
      credentialId: record.sessionId,
    };
  }

  async beginDeviceAuthorization(
    input: DeviceAuthorizationRequest,
  ): Promise<DeviceAuthorizationResult> {
    const request = DeviceAuthorizationRequestSchema.parse(input);
    this.requireAllowedClient(request.clientId);
    const now = this.now();
    const deviceCode = createDeviceCode();
    const userCode = createUserCode();
    await this.store.createDeviceGrant({
      grantId: randomUUID(),
      deviceCodeHash: hashToken(deviceCode, this.config.tokenPepper),
      userCodeHash: hashToken(
        normalizeUserCode(userCode),
        this.config.tokenPepper,
      ),
      clientId: request.clientId,
      deviceName: request.clientName,
      platform: request.platform,
      clientVersion: request.clientVersion,
      scopes: request.requestedScopes,
      status: 'pending',
      intervalSeconds: this.pollingIntervalSeconds,
      lastPolledAt: null,
      expiresAt: now + this.deviceCodeTtlMs,
      approvedUserId: null,
      approvedTenantId: null,
      consumedDeviceId: null,
      createdAt: now,
      approvedAt: null,
      consumedAt: null,
    });
    const verificationUri = new URL(this.config.verificationUri);
    const complete = new URL(verificationUri);
    complete.searchParams.set('user_code', userCode);
    return {
      deviceCode,
      userCode,
      verificationUri: verificationUri.toString(),
      verificationUriComplete: complete.toString(),
      expiresIn: Math.floor(this.deviceCodeTtlMs / 1000),
      interval: this.pollingIntervalSeconds,
    };
  }

  async approveDevice(
    userCode: string,
    principal: AuthPrincipal,
    audit: RequestAuditContext,
  ): Promise<{ approved: true; deviceName: string }> {
    const normalized = normalizeUserCode(userCode);
    const result = await this.store.approveDeviceGrant(
      hashToken(normalized, this.config.tokenPepper),
      principal,
      this.now(),
    );
    if (result.status !== 'approved') {
      const code =
        result.status === 'expired' ? 'expired_grant' : 'invalid_grant';
      throw new AuthError(
        code,
        result.status === 'already_completed' ? 409 : 400,
        'The device code is invalid, expired, or already completed.',
      );
    }
    const account = await this.requireAccount(principal);
    await this.audit(
      account,
      principal.deviceId,
      'identity.device_authorization.approved',
      'device_grant',
      null,
      audit,
    );
    return { approved: true, deviceName: result.deviceName };
  }

  async exchangeToken(
    input: TokenRequest,
    audit: RequestAuditContext,
  ): Promise<TokenResponse> {
    const request = TokenRequestSchema.parse(input);
    this.requireAllowedClient(request.clientId);
    return request.grantType === 'refresh_token'
      ? this.rotateRefreshToken(request.refreshToken, audit)
      : this.exchangeDeviceCode(request.deviceCode, audit);
  }

  async authenticateAccessToken(
    rawToken: string,
    requiredScopes: readonly OAuthScope[] = [],
  ): Promise<AuthPrincipal> {
    const parsed = parseOpaqueToken(rawToken, 'bat_at');
    if (parsed === null) throw unauthorized();
    const record = await this.store.findAccessToken(parsed.id);
    const presented = hashToken(parsed.secret, this.config.tokenPepper);
    if (
      record === null ||
      record.revokedAt !== null ||
      record.expiresAt <= this.now() ||
      !tokenHashMatches(record.tokenHash, presented)
    ) {
      throw unauthorized();
    }
    for (const scope of requiredScopes) {
      if (!record.scopes.includes(scope)) {
        throw new AuthError(
          'insufficient_scope',
          403,
          `The access token is missing the required ${scope} scope.`,
        );
      }
    }
    return accessPrincipal(record);
  }

  async accountFor(principal: AuthPrincipal): Promise<Account> {
    const account = await this.requireAccount(principal);
    return accountResponse(account, principal.deviceId);
  }

  async listDevices(principal: AuthPrincipal): Promise<Device[]> {
    const devices = await this.store.listDevices(
      principal.tenantId,
      principal.userId,
    );
    return devices.map(deviceResponse);
  }

  async revokeDevice(
    principal: AuthPrincipal,
    deviceId: string,
    audit: RequestAuditContext,
  ): Promise<void> {
    const revoked = await this.store.revokeDevice(
      principal.tenantId,
      principal.userId,
      deviceId,
      this.now(),
    );
    if (!revoked) {
      throw new AuthError('not_found', 404, 'The device was not found.');
    }
    const account = await this.requireAccount(principal);
    await this.audit(
      account,
      principal.deviceId,
      'identity.device.revoked',
      'device',
      deviceId,
      audit,
    );
  }

  async logout(
    principal: AuthPrincipal,
    audit: RequestAuditContext,
  ): Promise<void> {
    await this.store.revokeCredential(
      principal.credentialKind,
      principal.credentialId,
      this.now(),
    );
    const account = await this.requireAccount(principal);
    await this.audit(
      account,
      principal.deviceId,
      'identity.logout',
      principal.credentialKind,
      principal.credentialId,
      audit,
    );
  }

  private async exchangeDeviceCode(
    deviceCode: string,
    audit: RequestAuditContext,
  ): Promise<TokenResponse> {
    const now = this.now();
    const deviceId = randomUUID();
    const familyId = randomUUID();
    const access = createOpaqueToken('bat_at');
    const refresh = createOpaqueToken('bat_rt');
    const placeholderTenant = '00000000-0000-0000-0000-000000000000';
    const issuance = createTokenIssuance(
      {
        deviceId,
        tenantId: placeholderTenant,
        userId: placeholderTenant,
        name: 'pending',
        platform: 'pending',
        clientVersion: 'pending',
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      },
      familyId,
      [],
      access,
      refresh,
      now,
      this.accessTtlMs,
      this.refreshTtlMs,
      this.config.tokenPepper,
    );
    const result = await this.store.exchangeDeviceGrant(
      hashToken(deviceCode, this.config.tokenPepper),
      now,
      issuance,
    );
    if (result.status !== 'issued') {
      throw deviceExchangeError(result.status, result.intervalSeconds);
    }
    await this.audit(
      result.account,
      result.issuance.device.deviceId,
      'identity.device.registered',
      'device',
      result.issuance.device.deviceId,
      audit,
    );
    return tokenResponse(
      result.account,
      result.issuance.device.deviceId,
      access.value,
      refresh.value,
      result.issuance.accessToken.scopes,
      this.accessTtlMs,
    );
  }

  private async rotateRefreshToken(
    rawRefreshToken: string,
    audit: RequestAuditContext,
  ): Promise<TokenResponse> {
    const parsed = parseOpaqueToken(rawRefreshToken, 'bat_rt');
    if (parsed === null) throw invalidGrant();
    const now = this.now();
    const access = createOpaqueToken('bat_at');
    const refresh = createOpaqueToken('bat_rt');
    const placeholder = '00000000-0000-0000-0000-000000000000';
    const issuance: RefreshIssuance = {
      accessToken: storedAccess(
        access.id,
        access.secret,
        placeholder,
        placeholder,
        placeholder,
        placeholder,
        [],
        now,
        now + this.accessTtlMs,
        this.config.tokenPepper,
      ),
      refreshToken: storedRefresh(
        refresh.id,
        refresh.secret,
        placeholder,
        placeholder,
        placeholder,
        placeholder,
        [],
        now,
        now + this.refreshTtlMs,
        this.config.tokenPepper,
      ),
    };
    const result = await this.store.rotateRefreshToken(
      parsed.id,
      hashToken(parsed.secret, this.config.tokenPepper),
      now,
      issuance,
    );
    if (result.status !== 'rotated') {
      throw invalidGrant(
        result.status === 'replayed'
          ? 'Refresh-token replay revoked the credential family.'
          : undefined,
      );
    }
    await this.audit(
      result.account,
      result.issuance.accessToken.deviceId,
      'identity.refresh.rotated',
      'device',
      result.issuance.accessToken.deviceId,
      audit,
    );
    return tokenResponse(
      result.account,
      result.issuance.accessToken.deviceId,
      access.value,
      refresh.value,
      result.issuance.accessToken.scopes,
      this.accessTtlMs,
    );
  }

  private async requireAccount(
    principal: AuthPrincipal,
  ): Promise<AccountRecord> {
    const account = await this.store.getAccount(
      principal.tenantId,
      principal.userId,
    );
    if (account === null) throw unauthorized();
    return account;
  }

  private requireAllowedClient(clientId: string): void {
    if (!this.allowedClientIds.has(clientId)) {
      throw new AuthError(
        'invalid_request',
        400,
        'The OAuth client is not allowed.',
      );
    }
  }

  private async audit(
    account: AccountRecord,
    deviceId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    request: RequestAuditContext,
  ): Promise<void> {
    const event: AuditEventRecord = {
      auditEventId: randomUUID(),
      tenantId: account.tenantId,
      actorUserId: account.userId,
      actorDeviceId: deviceId,
      action,
      targetType,
      targetId,
      requestId: request.requestId,
      metadata: {},
      occurredAt: this.now(),
    };
    await this.store.appendAuditEvent(event);
  }
}

const allBrowserScopes: OAuthScope[] = [
  'account:read',
  'devices:read',
  'devices:write',
  'projects:read',
  'projects:write',
  'work:read',
];

function createTokenIssuance(
  device: DeviceRecord,
  familyId: string,
  scopes: OAuthScope[],
  access: { id: string; secret: string },
  refresh: { id: string; secret: string },
  now: number,
  accessTtlMs: number,
  refreshTtlMs: number,
  pepper: string,
): TokenIssuance {
  return {
    device,
    accessToken: storedAccess(
      access.id,
      access.secret,
      familyId,
      device.tenantId,
      device.userId,
      device.deviceId,
      scopes,
      now,
      now + accessTtlMs,
      pepper,
    ),
    refreshToken: storedRefresh(
      refresh.id,
      refresh.secret,
      familyId,
      device.tenantId,
      device.userId,
      device.deviceId,
      scopes,
      now,
      now + refreshTtlMs,
      pepper,
    ),
  };
}

function storedAccess(
  tokenId: string,
  secret: string,
  familyId: string,
  tenantId: string,
  userId: string,
  deviceId: string,
  scopes: OAuthScope[],
  createdAt: number,
  expiresAt: number,
  pepper: string,
): StoredAccessToken {
  return {
    tokenId,
    tokenHash: hashToken(secret, pepper),
    familyId,
    tenantId,
    userId,
    deviceId,
    scopes,
    createdAt,
    expiresAt,
    revokedAt: null,
  };
}

function storedRefresh(
  tokenId: string,
  secret: string,
  familyId: string,
  tenantId: string,
  userId: string,
  deviceId: string,
  scopes: OAuthScope[],
  createdAt: number,
  expiresAt: number,
  pepper: string,
): StoredRefreshToken {
  return {
    tokenId,
    tokenHash: hashToken(secret, pepper),
    familyId,
    tenantId,
    userId,
    deviceId,
    scopes,
    createdAt,
    expiresAt,
    usedAt: null,
    revokedAt: null,
    replacedByTokenId: null,
  };
}

function tokenResponse(
  account: AccountRecord,
  deviceId: string,
  accessToken: string,
  refreshToken: string,
  scopes: OAuthScope[],
  accessTtlMs: number,
): TokenResponse {
  return {
    tokenType: 'Bearer',
    accessToken,
    expiresIn: Math.floor(accessTtlMs / 1000),
    refreshToken,
    scopes,
    userId: account.userId,
    tenantId: account.tenantId,
    deviceId,
  };
}

function accessPrincipal(record: StoredAccessToken): AuthPrincipal {
  return {
    userId: record.userId,
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    scopes: record.scopes,
    credentialKind: 'access_token',
    credentialId: record.tokenId,
  };
}

function accountResponse(
  account: AccountRecord,
  deviceId: string | null,
): Account {
  return {
    userId: account.userId,
    tenantId: account.tenantId,
    email: account.email,
    displayName: account.displayName,
    currentDeviceId: deviceId,
  };
}

function deviceResponse(device: DeviceRecord): Device {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    clientVersion: device.clientVersion,
    createdAt: new Date(device.createdAt).toISOString(),
    lastSeenAt: new Date(device.lastSeenAt).toISOString(),
    revokedAt:
      device.revokedAt === null
        ? null
        : new Date(device.revokedAt).toISOString(),
  };
}

function unauthorized(): AuthError {
  return new AuthError(
    'unauthorized',
    401,
    'The credential is invalid or expired.',
  );
}

function invalidGrant(
  detail = 'The OAuth grant is invalid, expired, or revoked.',
): AuthError {
  return new AuthError('invalid_grant', 401, detail);
}

function deviceExchangeError(
  status: Exclude<
    Awaited<ReturnType<IdentityStore['exchangeDeviceGrant']>>['status'],
    'issued'
  >,
  interval?: number,
): AuthError {
  switch (status) {
    case 'pending':
      return new AuthError(
        'authorization_pending',
        400,
        'Device approval is pending.',
        interval,
      );
    case 'slow_down':
      return new AuthError(
        'slow_down',
        429,
        'The client is polling too quickly.',
        interval,
      );
    case 'denied':
      return new AuthError(
        'access_denied',
        401,
        'The device authorization was denied.',
      );
    case 'expired':
      return new AuthError(
        'expired_grant',
        401,
        'The device authorization expired.',
      );
    case 'not_found':
    case 'consumed':
      return invalidGrant();
  }
}
