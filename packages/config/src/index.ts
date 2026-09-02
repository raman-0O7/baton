import { z } from 'zod';

const EnvironmentSchema = z.enum(['development', 'test', 'production']);
const HttpsUrlSchema = z
  .url()
  .refine((value) => new URL(value).protocol === 'https:', {
    message: 'must use HTTPS',
  });

const ApiEnvironmentSchema = z
  .object({
    NODE_ENV: EnvironmentSchema.default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
    DATABASE_URL: z.url(),
    BATON_TOKEN_PEPPER: z.string().min(32),
    BATON_COOKIE_SECRET: z.string().min(32),
    BATON_PUBLIC_API_URL: z.url().default('http://localhost:4000'),
    BATON_DASHBOARD_URL: z.url().default('http://localhost:3000'),
    OIDC_ISSUER: z.url().optional(),
    OIDC_AUTHORIZATION_ENDPOINT: z.url().optional(),
    OIDC_TOKEN_ENDPOINT: z.url().optional(),
    OIDC_USERINFO_ENDPOINT: z.url().optional(),
    OIDC_CLIENT_ID: z.string().min(1).optional(),
    OIDC_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    BATON_DEV_LOGIN: z.enum(['true', 'false']).default('false'),
  })
  .passthrough()
  .superRefine((environment, context) => {
    if (
      environment.BATON_DEV_LOGIN === 'true' &&
      environment.NODE_ENV === 'production'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BATON_DEV_LOGIN'],
        message: 'the dev login route must never be enabled in production',
      });
    }
    const oidcKeys = [
      'OIDC_ISSUER',
      'OIDC_AUTHORIZATION_ENDPOINT',
      'OIDC_TOKEN_ENDPOINT',
      'OIDC_USERINFO_ENDPOINT',
      'OIDC_CLIENT_ID',
    ] as const;
    const configured = oidcKeys.filter((key) => environment[key] !== undefined);
    const oidcFullyConfigured = configured.length === oidcKeys.length;
    if (configured.length !== 0 && !oidcFullyConfigured) {
      context.addIssue({
        code: 'custom',
        path: ['OIDC_ISSUER'],
        message:
          'OIDC configuration must include issuer, endpoints, and client ID',
      });
    }

    // Each social provider needs both halves of its client credential.
    const socialProviders = [
      { id: 'GOOGLE', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
      { id: 'GITHUB', keys: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] },
    ] as const;
    const socialConfigured: Record<string, boolean> = {};
    for (const provider of socialProviders) {
      const present = provider.keys.filter(
        (key) => environment[key] !== undefined,
      );
      socialConfigured[provider.id] = present.length === provider.keys.length;
      if (present.length !== 0 && present.length !== provider.keys.length) {
        context.addIssue({
          code: 'custom',
          path: [provider.keys[0]],
          message: `${provider.id} login requires both a client ID and secret`,
        });
      }
    }

    if (environment.NODE_ENV === 'production') {
      const anyProvider =
        oidcFullyConfigured ||
        socialConfigured.GOOGLE === true ||
        socialConfigured.GITHUB === true;
      if (!anyProvider) {
        context.addIssue({
          code: 'custom',
          path: ['OIDC_ISSUER'],
          message:
            'at least one login provider (OIDC, Google, or GitHub) must be configured in production',
        });
      }
      for (const key of [
        'BATON_PUBLIC_API_URL',
        'BATON_DASHBOARD_URL',
        'OIDC_ISSUER',
        'OIDC_AUTHORIZATION_ENDPOINT',
        'OIDC_TOKEN_ENDPOINT',
        'OIDC_USERINFO_ENDPOINT',
      ] as const) {
        const value = environment[key];
        if (value !== undefined && !HttpsUrlSchema.safeParse(value).success) {
          context.addIssue({
            code: 'custom',
            path: [key],
            message: 'must use HTTPS in production',
          });
        }
      }
    }
  });

export interface ApiConfig {
  environment: z.infer<typeof EnvironmentSchema>;
  host: string;
  port: number;
  databaseUrl: string;
  tokenPepper: string;
  cookieSecret: string;
  publicApiUrl: string;
  dashboardUrl: string;
  oidc: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string;
    clientId: string;
    clientSecret?: string;
  } | null;
  /** Google OAuth2/OIDC login (endpoints are fixed; only credentials vary). */
  google: { clientId: string; clientSecret: string } | null;
  /** GitHub OAuth2 login (endpoints are fixed; only credentials vary). */
  github: { clientId: string; clientSecret: string } | null;
  /** Local-only browser login bypass; never true in production. */
  devLogin: boolean;
}

export function loadApiConfig(environment: NodeJS.ProcessEnv): ApiConfig {
  const value = ApiEnvironmentSchema.parse(environment);
  const oidc =
    value.OIDC_ISSUER === undefined
      ? null
      : {
          issuer: value.OIDC_ISSUER,
          authorizationEndpoint: requireValue(
            value.OIDC_AUTHORIZATION_ENDPOINT,
          ),
          tokenEndpoint: requireValue(value.OIDC_TOKEN_ENDPOINT),
          userinfoEndpoint: requireValue(value.OIDC_USERINFO_ENDPOINT),
          clientId: requireValue(value.OIDC_CLIENT_ID),
          ...(value.OIDC_CLIENT_SECRET === undefined
            ? {}
            : { clientSecret: value.OIDC_CLIENT_SECRET }),
        };
  return {
    environment: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    tokenPepper: value.BATON_TOKEN_PEPPER,
    cookieSecret: value.BATON_COOKIE_SECRET,
    publicApiUrl: stripTrailingSlash(value.BATON_PUBLIC_API_URL),
    dashboardUrl: stripTrailingSlash(value.BATON_DASHBOARD_URL),
    oidc,
    google:
      value.GOOGLE_CLIENT_ID === undefined ||
      value.GOOGLE_CLIENT_SECRET === undefined
        ? null
        : {
            clientId: value.GOOGLE_CLIENT_ID,
            clientSecret: value.GOOGLE_CLIENT_SECRET,
          },
    github:
      value.GITHUB_CLIENT_ID === undefined ||
      value.GITHUB_CLIENT_SECRET === undefined
        ? null
        : {
            clientId: value.GITHUB_CLIENT_ID,
            clientSecret: value.GITHUB_CLIENT_SECRET,
          },
    devLogin:
      value.BATON_DEV_LOGIN === 'true' && value.NODE_ENV !== 'production',
  };
}

const CliEnvironmentSchema = z
  .object({
    BATON_API_URL: z.url().default('https://api.baton.dev'),
    BATON_CREDENTIAL_STORE: z.enum(['auto', 'file']).default('auto'),
    BATON_STATE_PATH: z.string().min(1).optional(),
    BATON_CLAUDE_PROJECTS_DIR: z.string().min(1).optional(),
    BATON_CODEX_SESSIONS_DIR: z.string().min(1).optional(),
    BATON_OPENCODE_DATABASE: z.string().min(1).optional(),
  })
  .passthrough();

export interface CliConfig {
  apiUrl: string;
  credentialStore: 'auto' | 'file';
  statePath?: string;
  claudeProjectsDirectory?: string;
  codexSessionsDirectory?: string;
  openCodeDatabase?: string;
}

export function loadCliConfig(environment: NodeJS.ProcessEnv): CliConfig {
  const value = CliEnvironmentSchema.parse(environment);
  return {
    apiUrl: stripTrailingSlash(value.BATON_API_URL),
    credentialStore: value.BATON_CREDENTIAL_STORE,
    ...(value.BATON_STATE_PATH === undefined
      ? {}
      : { statePath: value.BATON_STATE_PATH }),
    ...(value.BATON_CLAUDE_PROJECTS_DIR === undefined
      ? {}
      : { claudeProjectsDirectory: value.BATON_CLAUDE_PROJECTS_DIR }),
    ...(value.BATON_CODEX_SESSIONS_DIR === undefined
      ? {}
      : { codexSessionsDirectory: value.BATON_CODEX_SESSIONS_DIR }),
    ...(value.BATON_OPENCODE_DATABASE === undefined
      ? {}
      : { openCodeDatabase: value.BATON_OPENCODE_DATABASE }),
  };
}

export interface WorkerConfig {
  environment: z.infer<typeof EnvironmentSchema>;
  databaseUrl: string;
  heartbeatIntervalMs: number;
}

const WorkerEnvironmentSchema = z
  .object({
    NODE_ENV: EnvironmentSchema.default('development'),
    DATABASE_URL: z.url(),
    BATON_WORKER_HEARTBEAT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .default(30_000),
  })
  .passthrough();

export function loadWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig {
  const value = WorkerEnvironmentSchema.parse(environment);
  return {
    environment: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    heartbeatIntervalMs: value.BATON_WORKER_HEARTBEAT_MS,
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requireValue(value: string | undefined): string {
  if (value === undefined) throw new TypeError('configuration is incomplete');
  return value;
}
