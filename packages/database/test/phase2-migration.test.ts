import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0001_phase2_ingestion.sql',
  import.meta.url,
);

describe('Phase 2 ingestion migration', () => {
  it('creates the tenant-owned capture and artifact tables', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of [
      'projects',
      'project_installations',
      'consent_records',
      'source_sessions',
      'source_events',
      'ingestion_batches',
      'ingestion_checkpoints',
      'artifacts',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
    }
  });

  it('scopes event and batch identities by tenant', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      'CONSTRAINT "source_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id")',
    );
    expect(sql).toContain(
      'CONSTRAINT "ingestion_batches_tenant_id_batch_id_pk" PRIMARY KEY("tenant_id","batch_id")',
    );
    expect(sql).toContain(
      '"source_events_tenant_idempotency_uidx" ON "source_events" USING btree ("tenant_id","idempotency_key")',
    );
  });

  it('restricts artifact classes and documents the native-payload prohibition', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      `"artifact_class" IN ('scrubbed_diff', 'scrubbed_tool_result')`,
    );
    expect(sql).toContain(`"media_type" IN ('application/json', 'text/plain')`);
    expect(sql).toContain('complete native agent payloads are prohibited');
    expect(sql).not.toContain('raw_transcript');
    expect(sql).not.toContain('native_payload');
  });
});
