import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0002_phase3_work_threads.sql',
  import.meta.url,
);

describe('Phase 3 work-thread migration', () => {
  it('creates the tenant-owned work-thread tables with forced RLS', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of ['work_threads', 'work_thread_sessions']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
    }
    expect(sql).toContain("current_setting('baton.tenant_id', true)");
  });

  it('scopes thread and session identity by tenant', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('PRIMARY KEY("tenant_id","work_thread_id")');
    expect(sql).toContain(
      'PRIMARY KEY("tenant_id","work_thread_id","source_session_id")',
    );
    // A source session may belong to at most one thread per tenant.
    expect(sql).toContain(
      '"work_thread_sessions_tenant_session_uidx" ON "work_thread_sessions" USING btree ("tenant_id","source_session_id")',
    );
  });

  it('constrains work-thread state and assignment enums', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      `"state" IN ('active', 'paused', 'completed', 'archived')`,
    );
    expect(sql).toContain(`"assignment" IN ('suggested', 'confirmed')`);
    expect(sql).not.toContain('raw_transcript');
    expect(sql).not.toContain('native_payload');
  });
});
