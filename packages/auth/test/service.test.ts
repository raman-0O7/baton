import type { DeviceAuthorizationRequest } from '@baton/protocol';
import { describe, expect, it } from 'vitest';

import {
  AuthError,
  IdentityService,
  InMemoryIdentityStore,
} from '../src/index.js';

const deviceRequest: DeviceAuthorizationRequest = {
  clientId: 'baton-cli',
  clientName: 'Development laptop',
  clientVersion: '0.1.0',
  platform: 'darwin-arm64',
  requestedScopes: ['account:read', 'devices:read', 'devices:write'],
};

function fixture() {
  let now = Date.parse('2026-08-02T00:00:00Z');
  const store = new InMemoryIdentityStore();
  const service = new IdentityService(
    store,
    {
      tokenPepper: 'test-only-token-pepper-that-is-at-least-32-characters',
      verificationUri: 'https://app.baton.dev/activate',
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 3600,
      deviceCodeTtlSeconds: 900,
      devicePollingIntervalSeconds: 5,
    },
    () => now,
  );
  return {
    store,
    service,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

async function browserPrincipal(
  service: IdentityService,
  subject: string,
  requestId: string,
) {
  const session = await service.establishBrowserSession(
    {
      issuer: 'https://identity.example.test',
      subject,
      email: `${subject}@example.test`,
      displayName: subject,
    },
    { requestId },
  );
  return {
    session,
    principal: await service.authenticateBrowserSession(session.sessionToken),
  };
}

async function registerDevice(
  service: IdentityService,
  principal: Awaited<ReturnType<typeof browserPrincipal>>['principal'],
  request: DeviceAuthorizationRequest,
  requestId: string,
) {
  const authorization = await service.beginDeviceAuthorization(request);
  await service.approveDevice(authorization.userCode, principal, { requestId });
  const tokens = await service.exchangeToken(
    {
      grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      clientId: request.clientId,
      deviceCode: authorization.deviceCode,
    },
    { requestId },
  );
  return { authorization, tokens };
}

describe('IdentityService', () => {
  it('rejects unregistered OAuth clients', async () => {
    const { service } = fixture();
    await expect(
      service.beginDeviceAuthorization({
        ...deviceRequest,
        clientId: 'unknown-client',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('registers two devices, rotates credentials, and revokes one', async () => {
    const { service } = fixture();
    const { principal } = await browserPrincipal(
      service,
      'user-a',
      'req-login',
    );
    const first = await registerDevice(
      service,
      principal,
      deviceRequest,
      'req-device-1',
    );
    const second = await registerDevice(
      service,
      principal,
      { ...deviceRequest, clientName: 'Travel laptop', platform: 'linux-x64' },
      'req-device-2',
    );

    expect(await service.listDevices(principal)).toHaveLength(2);
    const refreshed = await service.exchangeToken(
      {
        grantType: 'refresh_token',
        clientId: 'baton-cli',
        refreshToken: first.tokens.refreshToken,
      },
      { requestId: 'req-refresh' },
    );
    expect(refreshed.refreshToken).not.toBe(first.tokens.refreshToken);
    expect(
      await service.authenticateAccessToken(refreshed.accessToken, [
        'account:read',
      ]),
    ).toMatchObject({ deviceId: first.tokens.deviceId });

    await service.revokeDevice(principal, first.tokens.deviceId, {
      requestId: 'req-revoke',
    });
    await expect(
      service.authenticateAccessToken(refreshed.accessToken),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(
      await service.authenticateAccessToken(second.tokens.accessToken),
    ).toMatchObject({ deviceId: second.tokens.deviceId });
  });

  it('revokes a whole refresh family when an old token is replayed', async () => {
    const { service } = fixture();
    const { principal } = await browserPrincipal(
      service,
      'user-a',
      'req-login',
    );
    const registered = await registerDevice(
      service,
      principal,
      deviceRequest,
      'req-device',
    );
    const rotated = await service.exchangeToken(
      {
        grantType: 'refresh_token',
        clientId: 'baton-cli',
        refreshToken: registered.tokens.refreshToken,
      },
      { requestId: 'req-refresh' },
    );

    await expect(
      service.exchangeToken(
        {
          grantType: 'refresh_token',
          clientId: 'baton-cli',
          refreshToken: registered.tokens.refreshToken,
        },
        { requestId: 'req-replay' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(
      service.authenticateAccessToken(rotated.accessToken),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('enforces polling intervals and device-code expiry', async () => {
    const { service, advance } = fixture();
    const authorization = await service.beginDeviceAuthorization(deviceRequest);

    await expect(
      service.exchangeToken(
        {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          clientId: 'baton-cli',
          deviceCode: authorization.deviceCode,
        },
        { requestId: 'req-poll-1' },
      ),
    ).rejects.toMatchObject({ code: 'authorization_pending' });
    await expect(
      service.exchangeToken(
        {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          clientId: 'baton-cli',
          deviceCode: authorization.deviceCode,
        },
        { requestId: 'req-poll-2' },
      ),
    ).rejects.toMatchObject({ code: 'slow_down' });

    advance(901_000);
    await expect(
      service.exchangeToken(
        {
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          clientId: 'baton-cli',
          deviceCode: authorization.deviceCode,
        },
        { requestId: 'req-expired' },
      ),
    ).rejects.toMatchObject({ code: 'expired_grant' });
  });

  it('does not reveal or revoke another tenant device', async () => {
    const { service } = fixture();
    const accountA = await browserPrincipal(service, 'user-a', 'req-login-a');
    const accountB = await browserPrincipal(service, 'user-b', 'req-login-b');
    const deviceA = await registerDevice(
      service,
      accountA.principal,
      deviceRequest,
      'req-device-a',
    );

    expect(await service.listDevices(accountB.principal)).toEqual([]);
    await expect(
      service.revokeDevice(accountB.principal, deviceA.tokens.deviceId, {
        requestId: 'req-cross-tenant',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await service.authenticateAccessToken(deviceA.tokens.accessToken),
    ).toMatchObject({ tenantId: accountA.principal.tenantId });
  });

  it('requires explicitly requested access-token scopes', async () => {
    const { service } = fixture();
    const { principal } = await browserPrincipal(
      service,
      'user-a',
      'req-login',
    );
    const registered = await registerDevice(
      service,
      principal,
      { ...deviceRequest, requestedScopes: ['account:read'] },
      'req-device',
    );

    await expect(
      service.authenticateAccessToken(registered.tokens.accessToken, [
        'devices:write',
      ]),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
