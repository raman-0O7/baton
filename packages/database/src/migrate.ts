import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { createDatabaseClient } from './client.js';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new TypeError('DATABASE_URL is required');
const client = createDatabaseClient(databaseUrl);

try {
  await migrate(client.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
} finally {
  await client.close();
}
