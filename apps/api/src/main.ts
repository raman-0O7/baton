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
  PostgresIdentityStore,
  PostgresIngestionStore,
  PostgresLifecycleStore,
  PostgresMemoryStore,
  PostgresRetrievalStore,
  PostgresWorkThreadStore,
} from '@baton/database';

import { buildApi } from './app.js';

const config = loadApiConfig(process.env);
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

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await database.close();
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
