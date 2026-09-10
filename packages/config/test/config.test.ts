import { describe, expect, it } from 'vitest';

import {
  loadApiConfig,
  loadCliConfig,
  loadWorkerConfig,
} from '../src/index.js';

const secret = 'a-secure-value-with-at-least-32-characters';

describe('runtime configuration', () => {
  it('loads local API defaults without an identity provider', () => {
    const config = loadApiConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://baton:baton@localhost/baton',
      BATON_TOKEN_PEPPER: secret,
      BATON_COOKIE_SECRET: secret,
    });
    expect(config.oidc).toBeNull();
    expect(config.publicApiUrl).toBe('http://localhost:4000');
  });

  it('requires complete HTTPS hosted configuration', () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://baton:baton@database/baton',
        BATON_TOKEN_PEPPER: secret,
        BATON_COOKIE_SECRET: secret,
        BATON_PUBLIC_API_URL: 'http://api.example.com',
        BATON_DASHBOARD_URL: 'https://app.example.com',
      }),
    ).toThrow();
  });

  it('accepts a production deployment with only a social provider', () => {
    const config = loadApiConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://baton:baton@database/baton',
      BATON_TOKEN_PEPPER: secret,
      BATON_COOKIE_SECRET: secret,
      BATON_PUBLIC_API_URL: 'https://api.example.com',
      BATON_DASHBOARD_URL: 'https://app.example.com',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
    });
    expect(config.oidc).toBeNull();
    expect(config.google).toEqual({
      clientId: 'google-client',
      clientSecret: 'google-secret',
    });
    expect(config.github).toBeNull();
  });

  it('rejects a partially configured social provider', () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgres://baton:baton@localhost/baton',
        BATON_TOKEN_PEPPER: secret,
        BATON_COOKIE_SECRET: secret,
        GITHUB_CLIENT_ID: 'github-client',
      }),
    ).toThrow();
  });

  it('normalizes CLI and worker settings', () => {
    expect(
      loadCliConfig({ BATON_API_URL: 'https://api.example.com/' }).apiUrl,
    ).toBe('https://api.example.com');
    expect(
      loadWorkerConfig({ DATABASE_URL: 'postgres://localhost/baton' })
        .heartbeatIntervalMs,
    ).toBe(30_000);
  });

  it('treats empty extraction env vars as unset (GitHub Actions injects "")', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgres://localhost/baton',
      ANTHROPIC_API_KEY: '',
      BATON_EXTRACTION_MODEL: '',
      BATON_EXTRACTION_WINDOW: '',
      BATON_EXTRACTION_MAX_PROJECTS: '',
    });
    expect(config.extraction).toEqual({
      anthropicApiKey: null,
      model: 'claude-opus-5',
      windowPerProject: 200,
      maxProjectsPerRun: 100,
    });
  });

  it('reads extraction overrides when the env vars are set', () => {
    const config = loadWorkerConfig({
      DATABASE_URL: 'postgres://localhost/baton',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      BATON_EXTRACTION_MODEL: 'claude-sonnet-5',
      BATON_EXTRACTION_WINDOW: '50',
      BATON_EXTRACTION_MAX_PROJECTS: '5',
    });
    expect(config.extraction).toEqual({
      anthropicApiKey: 'sk-ant-test',
      model: 'claude-sonnet-5',
      windowPerProject: 50,
      maxProjectsPerRun: 5,
    });
  });

  it('accepts explicit native-agent and operational-state locations', () => {
    expect(
      loadCliConfig({
        BATON_STATE_PATH: '/tmp/baton-state.json',
        BATON_CLAUDE_PROJECTS_DIR: '/tmp/claude',
        BATON_CODEX_SESSIONS_DIR: '/tmp/codex',
        BATON_OPENCODE_DATABASE: '/tmp/opencode.db',
      }),
    ).toMatchObject({
      statePath: '/tmp/baton-state.json',
      claudeProjectsDirectory: '/tmp/claude',
      codexSessionsDirectory: '/tmp/codex',
      openCodeDatabase: '/tmp/opencode.db',
    });
  });
});
