import { describe, expect, it } from 'vitest';

import { createGoogleProvider, GithubOAuthProvider } from '../src/oidc.js';

describe('social login providers', () => {
  it('builds a Google authorization URL with PKCE', () => {
    const google = createGoogleProvider('google-client', 'google-secret');
    const url = google.authorizationUrl({
      state: 'state-value',
      codeVerifier: 'verifier-value',
      redirectUri: 'https://api.example.com/v1/auth/web/callback/google',
    });
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('client_id')).toBe('google-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
  });

  it('builds a GitHub authorization URL with the email scope', () => {
    const github = new GithubOAuthProvider({
      clientId: 'gh-client',
      clientSecret: 'gh-secret',
    });
    const url = github.authorizationUrl({
      state: 'state-value',
      redirectUri: 'https://api.example.com/v1/auth/web/callback/github',
    });
    expect(url.origin + url.pathname).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('state')).toBe('state-value');
  });

  it('exchanges a GitHub code and resolves a verified primary email', async () => {
    const calls: string[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push(url);
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'gh-token', token_type: 'bearer' });
      }
      if (url === 'https://api.github.com/user') {
        // Profile email is private (null); it must come from /user/emails.
        return jsonResponse({
          id: 4242,
          login: 'octocat',
          name: 'The Octocat',
          email: null,
        });
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse([
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'octo@example.com', primary: true, verified: true },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const github = new GithubOAuthProvider(
      { clientId: 'gh-client', clientSecret: 'gh-secret' },
      fetcher,
    );
    const identity = await github.exchange({
      code: 'auth-code',
      redirectUri: 'https://api.example.com/v1/auth/web/callback/github',
    });
    expect(identity).toEqual({
      issuer: 'https://github.com',
      subject: '4242',
      email: 'octo@example.com',
      displayName: 'The Octocat',
    });
    expect(calls).toContain('https://api.github.com/user/emails');
  });

  it('rejects a GitHub login without a verified email', async () => {
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return jsonResponse({ access_token: 'gh-token' });
      }
      if (url === 'https://api.github.com/user') {
        return jsonResponse({ id: 7, login: 'ghost', name: null, email: null });
      }
      if (url === 'https://api.github.com/user/emails') {
        return jsonResponse([
          { email: 'unverified@example.com', primary: true, verified: false },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const github = new GithubOAuthProvider(
      { clientId: 'gh-client', clientSecret: 'gh-secret' },
      fetcher,
    );
    await expect(
      github.exchange({
        code: 'auth-code',
        redirectUri: 'https://api.example.com/v1/auth/web/callback/github',
      }),
    ).rejects.toThrow(/verified GitHub email/);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
