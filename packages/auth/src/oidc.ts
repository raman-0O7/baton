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

export function createPkceMaterial(): { state: string; verifier: string } {
  return {
    state: randomBytes(24).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
