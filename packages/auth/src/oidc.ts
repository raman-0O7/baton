import { randomBytes } from 'node:crypto';

import { sha256Base64Url } from './crypto.js';
import { AuthError } from './errors.js';
import type { WebIdentity } from './types.js';

export interface WebIdentityProvider {
  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): URL;
  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<WebIdentity>;
}

export interface OidcProviderConfig {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret?: string;
}

export class OidcWebIdentityProvider implements WebIdentityProvider {
  constructor(
    private readonly config: OidcProviderConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    for (const endpoint of [
      config.issuer,
      config.authorizationEndpoint,
      config.tokenEndpoint,
      config.userinfoEndpoint,
    ]) {
      if (new URL(endpoint).protocol !== 'https:') {
        throw new TypeError('production OIDC endpoints must use HTTPS');
      }
    }
  }

  authorizationUrl(input: {
    state: string;
    codeVerifier: string;
    redirectUri: string;
  }): URL {
    const url = new URL(this.config.authorizationEndpoint);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', sha256Base64Url(input.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url;
  }

  async exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<WebIdentity> {
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    if (this.config.clientSecret !== undefined) {
      tokenBody.set('client_secret', this.config.clientSecret);
    }
    const tokenResponse = await this.fetcher(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const tokenPayload: unknown = await tokenResponse.json();
    if (!tokenResponse.ok || !isRecord(tokenPayload)) {
      throw new AuthError(
        'unauthorized',
        401,
        'The identity provider rejected login.',
      );
    }
    const accessToken = tokenPayload.access_token;
    if (typeof accessToken !== 'string') {
      throw new AuthError(
        'unauthorized',
        401,
        'The identity provider returned no access token.',
      );
    }
    const userinfoResponse = await this.fetcher(this.config.userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const userinfo: unknown = await userinfoResponse.json();
    if (!userinfoResponse.ok || !isRecord(userinfo)) {
      throw new AuthError(
        'unauthorized',
        401,
        'The identity provider profile request failed.',
      );
    }
    const subject = userinfo.sub;
    const email = userinfo.email;
    const displayName = userinfo.name ?? userinfo.preferred_username ?? email;
    if (
      typeof subject !== 'string' ||
      typeof email !== 'string' ||
      typeof displayName !== 'string' ||
      userinfo.email_verified === false
    ) {
      throw new AuthError(
        'unauthorized',
        401,
        'A verified email identity is required.',
      );
    }
    return { issuer: this.config.issuer, subject, email, displayName };
  }
}

/** Google is a standard OIDC provider; only the client credentials vary. */
export function createGoogleProvider(
  clientId: string,
  clientSecret: string,
  fetcher: typeof fetch = fetch,
): OidcWebIdentityProvider {
  return new OidcWebIdentityProvider(
    {
      issuer: 'https://accounts.google.com',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      clientId,
      clientSecret,
    },
    fetcher,
  );
}

export interface GithubProviderConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * GitHub speaks OAuth2, not OIDC: no PKCE, no `userinfo` with `sub` /
 * `email_verified`. We read the profile from the REST API and resolve a
 * verified primary email from `/user/emails` when the profile email is
 * private. Identity subject is the numeric GitHub user id.
 */
export class GithubOAuthProvider implements WebIdentityProvider {
  static readonly ISSUER = 'https://github.com';
  private static readonly AUTHORIZE_URL =
    'https://github.com/login/oauth/authorize';
  private static readonly TOKEN_URL =
    'https://github.com/login/oauth/access_token';
  private static readonly USER_URL = 'https://api.github.com/user';
  private static readonly EMAILS_URL = 'https://api.github.com/user/emails';

  constructor(
    private readonly config: GithubProviderConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  authorizationUrl(input: { state: string; redirectUri: string }): URL {
    const url = new URL(GithubOAuthProvider.AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', 'read:user user:email');
    url.searchParams.set('state', input.state);
    url.searchParams.set('allow_signup', 'false');
    return url;
  }

  async exchange(input: {
    code: string;
    redirectUri: string;
  }): Promise<WebIdentity> {
    const tokenResponse = await this.fetcher(GithubOAuthProvider.TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    const tokenPayload: unknown = await tokenResponse.json();
    if (!tokenResponse.ok || !isRecord(tokenPayload)) {
      throw new AuthError('unauthorized', 401, 'GitHub rejected login.');
    }
    const accessToken = tokenPayload.access_token;
    if (typeof accessToken !== 'string') {
      throw new AuthError(
        'unauthorized',
        401,
        'GitHub returned no access token.',
      );
    }

    const profile = await this.getJson(
      GithubOAuthProvider.USER_URL,
      accessToken,
    );
    const subject = profile.id;
    const login = profile.login;
    if (typeof subject !== 'number' || typeof login !== 'string') {
      throw new AuthError('unauthorized', 401, 'GitHub profile is incomplete.');
    }
    const email = await this.resolveVerifiedEmail(profile, accessToken);
    const displayName =
      typeof profile.name === 'string' && profile.name.length > 0
        ? profile.name
        : login;
    return {
      issuer: GithubOAuthProvider.ISSUER,
      subject: String(subject),
      email,
      displayName,
    };
  }

  private async resolveVerifiedEmail(
    profile: Record<string, unknown>,
    accessToken: string,
  ): Promise<string> {
    // GitHub only returns a public email on the profile. Fall back to the
    // /user/emails list and require a verified primary address.
    const emailsPayload: unknown = await this.fetchJson(
      GithubOAuthProvider.EMAILS_URL,
      accessToken,
    );
    if (Array.isArray(emailsPayload)) {
      const primary = emailsPayload.find(
        (entry): entry is { email: string } =>
          isRecord(entry) &&
          entry.primary === true &&
          entry.verified === true &&
          typeof entry.email === 'string',
      );
      if (primary !== undefined) return primary.email;
    }
    if (typeof profile.email === 'string') return profile.email;
    throw new AuthError(
      'unauthorized',
      401,
      'A verified GitHub email is required. Verify an email on GitHub and try again.',
    );
  }

  private async getJson(
    url: string,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    const payload = await this.fetchJson(url, accessToken);
    if (!isRecord(payload)) {
      throw new AuthError('unauthorized', 401, 'GitHub returned no profile.');
    }
    return payload;
  }

  private async fetchJson(url: string, accessToken: string): Promise<unknown> {
    const response = await this.fetcher(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        // GitHub's API rejects requests without a User-Agent.
        'user-agent': 'baton',
      },
    });
    if (!response.ok) {
      throw new AuthError(
        'unauthorized',
        401,
        'The GitHub profile request failed.',
      );
    }
    return response.json();
  }
}

export function createPkceMaterial(): { state: string; verifier: string } {
  return {
    state: randomBytes(24).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
