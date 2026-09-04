import {
  createGoogleProvider,
  GithubOAuthProvider,
  IdentityService,
  OidcWebIdentityProvider,
  type WebIdentityProvider,
} from '@baton/auth';
import { loadApiConfig } from '@baton/config';
import {
  createDatabaseClient,
  type DatabaseClient,
  PostgresIdentityStore,
  PostgresIngestionStore,
  PostgresLifecycleStore,
  PostgresMemoryStore,
  PostgresRetrievalStore,
  PostgresWorkThreadStore,
} from '@baton/database';

import { buildApi } from './app.js';

export interface ConfiguredApi {
  app: Awaited<ReturnType<typeof buildApi>>;
  database: DatabaseClient;
  host: string;
  port: number;
}

/**
 * Wire the API from environment configuration: config, database, identity
 * providers, and every Postgres-backed store. Shared by the long-running
 * server entrypoint (`main.ts`, used for Docker/Render) and the Vercel
 * serverless handler (`api/index.ts`), so both boot an identically wired app.
 */
export async function createConfiguredApi(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfiguredApi> {
  const config = loadApiConfig(env);
  const database = createDatabaseClient(config.databaseUrl);
  const identity = new IdentityService(new PostgresIdentityStore(database.db), {
    tokenPepper: config.tokenPepper,
    verificationUri: `${config.dashboardUrl}/activate`,
  });
  const provider =
    config.oidc === null ? null : new OidcWebIdentityProvider(config.oidc);
  const identityProviders: Record<string, WebIdentityProvider> = {};
  if (config.google !== null) {
    identityProviders.google = createGoogleProvider(
      config.google.clientId,
      config.google.clientSecret,
    );
  }
  if (config.github !== null) {
    identityProviders.github = new GithubOAuthProvider(config.github);
  }
  const app = await buildApi({
    identity,
    ingestionStore: new PostgresIngestionStore(database.db),
    workThreadStore: new PostgresWorkThreadStore(database.db),
    retrievalStore: new PostgresRetrievalStore(database.db),
    memoryStore: new PostgresMemoryStore(database.db),
    lifecycleStore: new PostgresLifecycleStore(database.db),
    identityProvider: provider,
    identityProviders,
    publicApiUrl: config.publicApiUrl,
    dashboardUrl: config.dashboardUrl,
    cookieSecret: config.cookieSecret,
    secureCookies: config.environment === 'production',
    devLogin: config.devLogin,
  });
  return { app, database, host: config.host, port: config.port };
}
