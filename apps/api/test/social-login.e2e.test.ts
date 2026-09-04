import {
  IdentityService,
  InMemoryIdentityStore,
  type WebIdentity,
  type WebIdentityProvider,
} from '@baton/auth';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '../src/app.js';

const pepper = 'test-pepper-value-that-is-longer-than-thirty-two-characters';
const cookieSecret =
  'test-cookie-secret-that-is-longer-than-thirty-two-characters';

class FakeGithubProvider implements WebIdentityProvider {
  authorizationUrl(input: { state: string; redirectUri: string }): URL {
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('redirect_uri', input.redirectUri);
    return url;
  }

  async exchange(input: { code: string }): Promise<WebIdentity> {
    return {
      issuer: 'https://github.com',
      subject: input.code,
      email: `${input.code}@example.com`,
      displayName: 'Octo Cat',
    };
  }
}

describe('social login routes', () => {
  const identity = new IdentityService(new InMemoryIdentityStore(), {
    tokenPepper: pepper,
    verificationUri: 'http://dashboard.example.test/activate',
  });
  const appPromise = buildApi({
    identity,
    identityProvider: null,
    identityProviders: { github: new FakeGithubProvider() },
    publicApiUrl: 'http://api.example.test',
    dashboardUrl: 'http://dashboard.example.test',
    cookieSecret,
    secureCookies: false,
    logger: false,
  });

  beforeAll(async () => (await appPromise).ready());
  afterAll(async () => (await appPromise).close());

  it('lists the configured providers', async () => {
    const app = await appPromise;
    const response = await app.inject({
      method: 'GET',
      url: '/v1/auth/providers',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ providers: ['github'] });
  });

  it('redirects login to the provider with a provider-scoped callback', async () => {
    const app = await appPromise;
    const login = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login/github?returnTo=http://dashboard.example.test/work',
    });
    expect(login.statusCode).toBe(302);
    const location = new URL(requiredHeader(login.headers.location));
    expect(location.origin + location.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://api.example.test/v1/auth/web/callback/github',
    );
    expect(
      cookieNamed(login.headers['set-cookie'], 'baton_login_state'),
    ).toContain('baton_login_state=');
  });

  it('establishes a session on the provider callback', async () => {
    const app = await appPromise;
    const login = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login/github?returnTo=http://dashboard.example.test/work',
    });
    const stateCookie = cookieNamed(
      login.headers['set-cookie'],
      'baton_login_state',
    );
    const state = new URL(
      requiredHeader(login.headers.location),
    ).searchParams.get('state');

    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/web/callback/github?code=octo&state=${encodeURIComponent(requiredHeader(state))}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(
      'http://dashboard.example.test/work',
    );
    expect(
      cookieNamed(callback.headers['set-cookie'], 'baton_session'),
    ).toContain('baton_session=');
  });

  it('rejects a callback whose state names a different provider', async () => {
    const app = await appPromise;
    const login = await app.inject({
      method: 'GET',
      url: '/v1/auth/web/login/github?returnTo=http://dashboard.example.test/work',
    });
    const stateCookie = cookieNamed(
      login.headers['set-cookie'],
      'baton_login_state',
    );
    const state = new URL(
      requiredHeader(login.headers.location),
    ).searchParams.get('state');

    // There is no `google` provider registered, so this path 404s rather than
    // accepting the github-issued state.
    const callback = await app.inject({
      method: 'GET',
      url: `/v1/auth/web/callback/google?code=octo&state=${encodeURIComponent(requiredHeader(state))}`,
      headers: { cookie: stateCookie },
    });
    expect(callback.statusCode).toBe(404);
  });
});

function cookieNamed(
  header: string | string[] | undefined,
  name: string,
): string {
  const cookies = Array.isArray(header)
    ? header
    : header === undefined
      ? []
      : [header];
  const match = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`missing cookie ${name}`);
  return match.split(';')[0] ?? '';
}

function requiredHeader(value: string | string[] | undefined | null): string {
  if (typeof value !== 'string') throw new Error('missing header value');
  return value;
}
