import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { identitySchema } from './schema.js';

export interface DatabaseClient {
  db: PostgresJsDatabase<typeof identitySchema>;
  close(): Promise<void>;
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const sql = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return {
    db: drizzle(sql, { schema: identitySchema }),
    close: async () => sql.end({ timeout: 5 }),
  };
}
