import { randomUUID } from 'node:crypto';

import {
  tokenHashMatches,
  type AccountRecord,
  type AuditEventRecord,
  type AuthPrincipal,
  type DeviceApprovalResult,
  type DeviceExchangeResult,
  type DeviceGrantRecord,
  type DeviceRecord,
  type IdentityStore,
  type RefreshIssuance,
  type RefreshRotationResult,
  type StoredAccessToken,
  type StoredBrowserSession,
  type StoredRefreshToken,
  type TokenIssuance,
  type WebIdentity,
} from '@baton/auth';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  accessTokens,
  auditEvents,
  browserSessions,
  deviceAuthorizations,
  devices,
  identitySchema,
  refreshTokens,
  tenantMemberships,
  tenants,
  tokenFamilies,
  users,
} from './schema.js';

type Database = PostgresJsDatabase<typeof identitySchema>;

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly db: Database) {}

  async upsertAccount(
    identity: WebIdentity,
    now: number,
  ): Promise<AccountRecord> {
    return this.db.transaction(
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.issuer, identity.issuer),
              eq(users.subject, identity.subject),
            ),
          )
          .limit(1);
        const date = new Date(now);
        if (existing !== undefined) {
          const [updated] = await tx
            .update(users)
            .set({
              email: identity.email,
              displayName: identity.displayName,
              updatedAt: date,
            })
            .where(eq(users.userId, existing.userId))
            .returning();
          return accountFromRow(updated!);
        }
        const tenantId = randomUUID();
        const userId = randomUUID();
        await tx.insert(tenants).values({
          tenantId,
          kind: 'personal',
          displayName: `${identity.displayName}'s Baton`,
          createdAt: date,
          updatedAt: date,
        });
        const [created] = await tx
          .insert(users)
          .values({
            userId,
            primaryTenantId: tenantId,
            issuer: identity.issuer,
            subject: identity.subject,
            email: identity.email,
            displayName: identity.displayName,
            createdAt: date,
            updatedAt: date,
          })
          .returning();
        await tx.insert(tenantMemberships).values({
          tenantId,
          userId,
          role: 'owner',
          createdAt: date,
        });
        return accountFromRow(created!);
      },
      { isolationLevel: 'serializable' },
    );
  }

  async getAccount(
    tenantId: string,
    userId: string,
  ): Promise<AccountRecord | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.userId, userId), eq(users.primaryTenantId, tenantId)))
      .limit(1);
    return row === undefined ? null : accountFromRow(row);
  }

  async createBrowserSession(session: StoredBrowserSession): Promise<void> {
    await this.db.insert(browserSessions).values(browserSessionValues(session));
  }

  async findBrowserSession(
    sessionId: string,
  ): Promise<StoredBrowserSession | null> {
    const [row] = await this.db
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.sessionId, sessionId))
      .limit(1);
    return row === undefined ? null : browserSessionFromRow(row);
  }

  async createDeviceGrant(grant: DeviceGrantRecord): Promise<void> {
    await this.db.insert(deviceAuthorizations).values(deviceGrantValues(grant));
  }

  async approveDeviceGrant(
    userCodeHash: string,
    principal: AuthPrincipal,
    now: number,
  ): Promise<DeviceApprovalResult> {
    return this.db.transaction(
      async (tx) => {
        const [grant] = await tx
          .select()
          .from(deviceAuthorizations)
          .where(eq(deviceAuthorizations.userCodeHash, userCodeHash))
          .limit(1)
          .for('update');
        if (grant === undefined) return { status: 'not_found' };
        if (grant.expiresAt.getTime() <= now) return { status: 'expired' };
        if (grant.status !== 'pending') return { status: 'already_completed' };
        await tx
          .update(deviceAuthorizations)
          .set({
            status: 'approved',
            approvedUserId: principal.userId,
            approvedTenantId: principal.tenantId,
            approvedAt: new Date(now),
          })
          .where(
            and(
              eq(deviceAuthorizations.grantId, grant.grantId),
              eq(deviceAuthorizations.status, 'pending'),
            ),
          );
        return { status: 'approved', deviceName: grant.deviceName };
      },
      { isolationLevel: 'serializable' },
    );
  }

  async exchangeDeviceGrant(
    deviceCodeHash: string,
    now: number,
    issuance: TokenIssuance,
  ): Promise<DeviceExchangeResult> {
    return this.db.transaction(
      async (tx) => {
        const [grant] = await tx
          .select()
          .from(deviceAuthorizations)
          .where(eq(deviceAuthorizations.deviceCodeHash, deviceCodeHash))
          .limit(1)
          .for('update');
        if (grant === undefined) return { status: 'not_found' };
        if (grant.expiresAt.getTime() <= now) return { status: 'expired' };
        if (
          grant.lastPolledAt !== null &&
          now < grant.lastPolledAt.getTime() + grant.intervalSeconds * 1000
        ) {
          const intervalSeconds = Math.min(30, grant.intervalSeconds + 5);
          await tx
            .update(deviceAuthorizations)
            .set({ intervalSeconds, lastPolledAt: new Date(now) })
            .where(eq(deviceAuthorizations.grantId, grant.grantId));
          return { status: 'slow_down', intervalSeconds };
        }
        await tx
          .update(deviceAuthorizations)
          .set({ lastPolledAt: new Date(now) })
          .where(eq(deviceAuthorizations.grantId, grant.grantId));
        if (grant.status === 'pending') {
          return { status: 'pending', intervalSeconds: grant.intervalSeconds };
        }
        if (grant.status === 'denied') return { status: 'denied' };
        if (grant.status === 'consumed') return { status: 'consumed' };
        if (grant.approvedTenantId === null || grant.approvedUserId === null) {
          return { status: 'denied' };
        }
        const [accountRow] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.userId, grant.approvedUserId),
              eq(users.primaryTenantId, grant.approvedTenantId),
            ),
          )
          .limit(1);
        if (accountRow === undefined) return { status: 'denied' };
        const hydrated = hydrateDeviceIssuance(issuance, grant);
        await setTenant(tx, hydrated.device.tenantId);
        await tx.insert(devices).values(deviceValues(hydrated.device));
        await tx.insert(tokenFamilies).values({
          familyId: hydrated.accessToken.familyId,
          tenantId: hydrated.device.tenantId,
          userId: hydrated.device.userId,
          deviceId: hydrated.device.deviceId,
          createdAt: new Date(now),
          revokedAt: null,
        });
        await tx
          .insert(accessTokens)
          .values(accessTokenValues(hydrated.accessToken));
        await tx
          .insert(refreshTokens)
          .values(refreshTokenValues(hydrated.refreshToken));
        await tx
          .update(deviceAuthorizations)
          .set({
            status: 'consumed',
            consumedAt: new Date(now),
            consumedDeviceId: hydrated.device.deviceId,
          })
          .where(eq(deviceAuthorizations.grantId, grant.grantId));
        return {
          status: 'issued',
          account: accountFromRow(accountRow),
          issuance: hydrated,
        };
      },
      { isolationLevel: 'serializable' },
    );
  }

  async findAccessToken(tokenId: string): Promise<StoredAccessToken | null> {
    return this.db.transaction(async (tx) => {
      const [token] = await tx
        .select()
        .from(accessTokens)
        .where(eq(accessTokens.tokenId, tokenId))
        .limit(1);
      if (token === undefined) return null;
      await setTenant(tx, token.tenantId);
      const [device] = await tx
        .select({ revokedAt: devices.revokedAt })
        .from(devices)
        .where(
          and(
            eq(devices.deviceId, token.deviceId),
            eq(devices.tenantId, token.tenantId),
            eq(devices.userId, token.userId),
          ),
        )
        .limit(1);
      const record = accessTokenFromRow(token);
      if (device === undefined || device.revokedAt !== null) {
        record.revokedAt =
          device?.revokedAt?.getTime() ?? record.revokedAt ?? 0;
      }
      return record;
    });
  }

  async rotateRefreshToken(
    tokenId: string,
    presentedHash: string,
    now: number,
    issuance: RefreshIssuance,
  ): Promise<RefreshRotationResult> {
    return this.db.transaction(
      async (tx) => {
        const [current] = await tx
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.tokenId, tokenId))
          .limit(1)
          .for('update');
        if (current === undefined) return { status: 'not_found' };
        if (!tokenHashMatches(current.tokenHash, presentedHash))
          return { status: 'invalid' };
        if (current.expiresAt.getTime() <= now) return { status: 'expired' };
        await setTenant(tx, current.tenantId);
        const [device] = await tx
          .select()
          .from(devices)
          .where(
            and(
              eq(devices.deviceId, current.deviceId),
              eq(devices.tenantId, current.tenantId),
              eq(devices.userId, current.userId),
            ),
          )
          .limit(1);
        if (
          device === undefined ||
          device.revokedAt !== null ||
          current.revokedAt !== null
        ) {
          return { status: 'revoked' };
        }
        if (current.usedAt !== null) {
          await this.revokeFamily(tx, current.familyId, now);
          return { status: 'replayed' };
        }
        const [accountRow] = await tx
          .select()
          .from(users)
          .where(
            and(
              eq(users.userId, current.userId),
              eq(users.primaryTenantId, current.tenantId),
            ),
          )
          .limit(1);
        if (accountRow === undefined) return { status: 'revoked' };
        const hydrated = hydrateRefreshIssuance(
          issuance,
          refreshTokenFromRow(current),
        );
        await tx
          .update(refreshTokens)
          .set({
            usedAt: new Date(now),
            replacedByTokenId: hydrated.refreshToken.tokenId,
          })
          .where(
            and(
              eq(refreshTokens.tokenId, tokenId),
              eq(refreshTokens.tokenHash, presentedHash),
            ),
          );
        await tx
          .insert(accessTokens)
          .values(accessTokenValues(hydrated.accessToken));
        await tx
          .insert(refreshTokens)
          .values(refreshTokenValues(hydrated.refreshToken));
        await tx
          .update(devices)
          .set({ lastSeenAt: new Date(now) })
          .where(
            and(
              eq(devices.deviceId, current.deviceId),
              eq(devices.tenantId, current.tenantId),
            ),
          );
        return {
          status: 'rotated',
          account: accountFromRow(accountRow),
          issuance: hydrated,
        };
      },
      { isolationLevel: 'serializable' },
    );
  }

  async listDevices(tenantId: string, userId: string): Promise<DeviceRecord[]> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      const rows = await tx
        .select()
        .from(devices)
        .where(and(eq(devices.tenantId, tenantId), eq(devices.userId, userId)))
        .orderBy(desc(devices.lastSeenAt));
      return rows.map(deviceFromRow);
    });
  }

  async revokeDevice(
    tenantId: string,
    userId: string,
    deviceId: string,
    now: number,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      const [device] = await tx
        .update(devices)
        .set({ revokedAt: new Date(now) })
        .where(
          and(
            eq(devices.tenantId, tenantId),
            eq(devices.userId, userId),
            eq(devices.deviceId, deviceId),
          ),
        )
        .returning({ deviceId: devices.deviceId });
      if (device === undefined) return false;
      const families = await tx
        .select({ familyId: tokenFamilies.familyId })
        .from(tokenFamilies)
        .where(
          and(
            eq(tokenFamilies.tenantId, tenantId),
            eq(tokenFamilies.userId, userId),
            eq(tokenFamilies.deviceId, deviceId),
          ),
        );
      for (const family of families)
        await this.revokeFamily(tx, family.familyId, now);
      return true;
    });
  }

  async revokeCredential(
    kind: 'access_token' | 'browser_session',
    credentialId: string,
    now: number,
  ): Promise<void> {
    if (kind === 'browser_session') {
      await this.db
        .update(browserSessions)
        .set({ revokedAt: new Date(now) })
        .where(eq(browserSessions.sessionId, credentialId));
      return;
    }
    await this.db.transaction(async (tx) => {
      const [access] = await tx
        .select({ familyId: accessTokens.familyId })
        .from(accessTokens)
        .where(eq(accessTokens.tokenId, credentialId))
        .limit(1);
      if (access !== undefined)
        await this.revokeFamily(tx, access.familyId, now);
    });
  }

  async appendAuditEvent(event: AuditEventRecord): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (event.tenantId !== null) await setTenant(tx, event.tenantId);
      await tx.insert(auditEvents).values({
        auditEventId: event.auditEventId,
        tenantId: event.tenantId,
        actorUserId: event.actorUserId,
        actorDeviceId: event.actorDeviceId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        requestId: event.requestId,
        metadata: event.metadata,
        occurredAt: new Date(event.occurredAt),
      });
    });
  }

  async listAuditEvents(tenantId: string): Promise<AuditEventRecord[]> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      const rows = await tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.tenantId, tenantId))
        .orderBy(desc(auditEvents.occurredAt));
      return rows.map((row) => ({
        auditEventId: row.auditEventId,
        tenantId: row.tenantId,
        actorUserId: row.actorUserId,
        actorDeviceId: row.actorDeviceId,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        requestId: row.requestId,
        metadata: row.metadata,
        occurredAt: row.occurredAt.getTime(),
      }));
    });
  }

  private async revokeFamily(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    familyId: string,
    now: number,
  ): Promise<void> {
    const revokedAt = new Date(now);
    await tx
      .update(tokenFamilies)
      .set({ revokedAt })
      .where(eq(tokenFamilies.familyId, familyId));
    await tx
      .update(accessTokens)
      .set({ revokedAt })
      .where(eq(accessTokens.familyId, familyId));
    await tx
      .update(refreshTokens)
      .set({ revokedAt })
      .where(eq(refreshTokens.familyId, familyId));
  }
}

async function setTenant(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  tenantId: string,
): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}

function hydrateDeviceIssuance(
  issuance: TokenIssuance,
  grant: typeof deviceAuthorizations.$inferSelect,
): TokenIssuance {
  const tenantId = grant.approvedTenantId!;
  const userId = grant.approvedUserId!;
  return {
    device: {
      ...issuance.device,
      tenantId,
      userId,
      name: grant.deviceName,
      platform: grant.platform,
      clientVersion: grant.clientVersion,
    },
    accessToken: {
      ...issuance.accessToken,
      tenantId,
      userId,
      deviceId: issuance.device.deviceId,
      scopes: grant.scopes,
    },
    refreshToken: {
      ...issuance.refreshToken,
      tenantId,
      userId,
      deviceId: issuance.device.deviceId,
      scopes: grant.scopes,
    },
  };
}

function hydrateRefreshIssuance(
  issuance: RefreshIssuance,
  current: StoredRefreshToken,
): RefreshIssuance {
  return {
    accessToken: {
      ...issuance.accessToken,
      familyId: current.familyId,
      tenantId: current.tenantId,
      userId: current.userId,
      deviceId: current.deviceId,
      scopes: current.scopes,
    },
    refreshToken: {
      ...issuance.refreshToken,
      familyId: current.familyId,
      tenantId: current.tenantId,
      userId: current.userId,
      deviceId: current.deviceId,
      scopes: current.scopes,
    },
  };
}

function accountFromRow(row: typeof users.$inferSelect): AccountRecord {
  return {
    userId: row.userId,
    tenantId: row.primaryTenantId,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    displayName: row.displayName,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function deviceValues(record: DeviceRecord): typeof devices.$inferInsert {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    lastSeenAt: new Date(record.lastSeenAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
  };
}

function deviceFromRow(row: typeof devices.$inferSelect): DeviceRecord {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    lastSeenAt: row.lastSeenAt.getTime(),
    revokedAt: row.revokedAt?.getTime() ?? null,
  };
}

function deviceGrantValues(
  record: DeviceGrantRecord,
): typeof deviceAuthorizations.$inferInsert {
  return {
    ...record,
    lastPolledAt:
      record.lastPolledAt === null ? null : new Date(record.lastPolledAt),
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
    approvedAt: record.approvedAt === null ? null : new Date(record.approvedAt),
    consumedAt: record.consumedAt === null ? null : new Date(record.consumedAt),
  };
}

function browserSessionValues(
  record: StoredBrowserSession,
): typeof browserSessions.$inferInsert {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
  };
}

function browserSessionFromRow(
  row: typeof browserSessions.$inferSelect,
): StoredBrowserSession {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    revokedAt: row.revokedAt?.getTime() ?? null,
  };
}

function accessTokenValues(
  record: StoredAccessToken,
): typeof accessTokens.$inferInsert {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
  };
}

function accessTokenFromRow(
  row: typeof accessTokens.$inferSelect,
): StoredAccessToken {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    revokedAt: row.revokedAt?.getTime() ?? null,
  };
}

function refreshTokenValues(
  record: StoredRefreshToken,
): typeof refreshTokens.$inferInsert {
  return {
    ...record,
    createdAt: new Date(record.createdAt),
    expiresAt: new Date(record.expiresAt),
    usedAt: record.usedAt === null ? null : new Date(record.usedAt),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt),
  };
}

function refreshTokenFromRow(
  row: typeof refreshTokens.$inferSelect,
): StoredRefreshToken {
  return {
    ...row,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    usedAt: row.usedAt?.getTime() ?? null,
    revokedAt: row.revokedAt?.getTime() ?? null,
  };
}
