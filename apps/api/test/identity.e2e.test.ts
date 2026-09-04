import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentityProvider,
} from '@baton/auth';
import {
  AccountSchema,
  ApiProblemSchema,
  DeviceAuthorizationResponseSchema,
  DeviceListSchema,
  TokenResponseSchema,
  type TokenResponse,
} from '@baton/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'test-pepper-value-that-is-longer-than-thirty-two-characters';
const cookieSecret =
  'test-cookie-secret-that-is-longer-than-thirty-two-characters';

class FakeIdentityProvider implements WebIdentityProvider {
  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): URL {
    const url = new URL('https://identity.example.com/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('verifier_length', String(input.codeVerifier.length));
    return url;
  }

  async exchange(input: { code: string }): Promise<{
    issuer: string;
    subject: string;
    email: string;
    displayName: string;
  }> {
    return {
      issuer: 'https://identity.example.com',
      subject: input.code,
      email: `${input.code}@example.com`,
      displayName: input.code === 'ada' ? 'Ada Lovelace' : 'Grace Hopper',
    };
  }
}

describe('hosted identity gate', () => {
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    tokenPepper: pepper,
    verificationUri: 'http://dashboard.example.test/activate',
    devicePollingIntervalSeconds: 1,
  });
  const appPromise = buildApi({
    identity,
    identityProvider: new FakeIdentityProvider(),
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('rejects cross-origin login returns', async () => {
    const app = await appPromise;
    const sameOrigin = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login?returnTo=%2Factivate',
    });
    expect(sameOrigin.statusCode).toBe(302);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login?returnTo=https://attacker.example/',
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain(
      'application/problem+json',
    );
    expect(ApiProblemSchema.parse(response.json()).code).toBe(
      'invalid_request',
    );
  });

  it('allows credentialed browser requests only from the configured dashboard', async () => {
    const app = await appPromise;
    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v1/account',
      headers: { origin: 'http://dashboard.example.test' },
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/v1/account',
      headers: { origin: 'https://attacker.example' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('logs in two CLIs, rotates credentials, revokes one, and isolates tenants', async () => {
    const app = await appPromise;
    const adaCookie = await webLogin('ada');
    const first = await registerDevice(adaCookie, 'Ada laptop');
    const second = await registerDevice(adaCookie, 'Ada workstation');

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(second.accessToken),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      DeviceListSchema.parse(listed.json())
        .devices.map((device) => device.name)
        .sort(),
    ).toEqual(['Ada laptop', 'Ada workstation']);

    const refresh = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grantType: 'refresh_token',
        clientId: 'baton-cli',
        refreshToken: first.refreshToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
    const rotated = TokenResponseSchema.parse(refresh.json());
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${first.deviceId}`,
      headers: { cookie: adaCookie },
    });
    expect(revoke.statusCode).toBe(204);

    const revokedAccount = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: bearer(rotated.accessToken),
    });
    expect(revokedAccount.statusCode).toBe(401);

    const liveAccount = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: bearer(second.accessToken),
    });
    expect(AccountSchema.parse(liveAccount.json()).displayName).toBe(
      'Ada Lovelace',
    );

    const graceCookie = await webLogin('grace');
    const grace = await registerDevice(graceCookie, 'Grace terminal');
    const crossTenantRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/devices/${grace.deviceId}`,
      headers: { cookie: adaCookie },
    });
    expect(crossTenantRevoke.statusCode).toBe(404);
    const graceAccount = await app.inject({
      method: 'GET',
      url: '/v1/account',
      headers: bearer(grace.accessToken),
    });
    expect(AccountSchema.parse(graceAccount.json()).email).toBe(
      'grace@example.com',
    );
  });

  async function webLogin(code: string): Promise<string> {
    const app = await appPromise;
    const login = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login?returnTo=http://dashboard.example.test/devices',
    });
    expect(login.statusCode).toBe(302);
    const stateCookie = cookieNamed(
      login.headers['set-cookie'],
      'baton_login_state',
    );
    const state = new URL(
      requiredHeader(login.headers.location),
    ).searchParams.get('state');
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/web/callback?code=${code}&state=${encodeURIComponent(requiredHeader(state))}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      'http://dashboard.example.test/devices',
    );
    return cookieNamed(callback.headers['set-cookie'], 'baton_session');
  }

  async function registerDevice(
    browserCookie: string,
    clientName: string,
  ): Promise<TokenResponse> {
    const app = await appPromise;
    const authorization = await app.inject({
      method: 'POST',
      url: '/oauth/device/authorize',
      payload: {
        clientId: 'baton-cli',
        clientName,
        clientVersion: '0.1.0',
        platform: 'test',
        requestedScopes: [
          'account:read',
          'devices:read',
          'devices:write',
          'projects:read',
          'projects:write',
          'work:read',
        ],
      },
    });
    expect(authorization.statusCode).toBe(200);
    const grant = DeviceAuthorizationResponseSchema.parse(authorization.json());
    const approval = await app.inject({
      method: 'POST',
      url: '/v1/auth/device/approve',
      headers: { cookie: browserCookie },
      payload: { userCode: grant.userCode },
    });
    expect(approval.statusCode).toBe(200);
    const token = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        clientId: 'baton-cli',
        deviceCode: grant.deviceCode,
      },
    });
    expect(token.statusCode).toBe(200);
    return TokenResponseSchema.parse(token.json());
  }
});

function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function cookieNamed(
  header: string | string[] | undefined,
  name: string,
): string {
  const values = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) throw new Error(`Missing ${name} cookie`);
  return cookie.split(';', 1)[0]!;
}

function requiredHeader(value: string | null | undefined): string {
  if (value === undefined || value === null)
    throw new Error('Missing expected header value');
  return value;
}
