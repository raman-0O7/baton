import { loadWorkerConfig } from '@baton/config';
import {
  createDatabaseClient,
  PostgresMemoryExtractionStore,
  PostgresMemoryStore,
} from '@baton/database';
import { createAnthropicModelGateway } from '@baton/memory';
import { safeError } from '@baton/observability';

import { runMemoryExtraction } from './extract.js';

function log(
  message: string,
  fields: Record<string, string | number | boolean> = {},
): void {
  console.log(JSON.stringify({ level: 'info', message, ...fields }));
}

const config = loadWorkerConfig(process.env);

if (config.extraction.anthropicApiKey === null) {
  // A missing key is a no-op, not a failure: the scheduled job succeeds and
  // extraction simply does not run until a key is configured.
  log('memory extraction skipped: ANTHROPIC_API_KEY is not set');
  process.exit(0);
}

const database = createDatabaseClient(config.databaseUrl);
const gateway = createAnthropicModelGateway(
  config.extraction.anthropicApiKey,
  config.extraction.model,
);

try {
  const summary = await runMemoryExtraction({
    source: new PostgresMemoryExtractionStore(database.db),
    sink: new PostgresMemoryStore(database.db),
    gateway,
    options: {
      windowPerProject: config.extraction.windowPerProject,
      maxProjectsPerRun: config.extraction.maxProjectsPerRun,
    },
    log,
  });
  log('memory extraction complete', { ...summary, model: gateway.model });
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'memory extraction failed',
      error: safeError(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
