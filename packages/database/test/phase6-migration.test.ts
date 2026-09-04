import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0004_phase6_memory.sql',
  import.meta.url,
);

describe('Phase 6 memory migration', () => {
  it('creates the memory tables with forced RLS', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of ['memory_candidates', 'memories']) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(`CREATE POLICY "${table}_tenant_isolation"`);
    }
    expect(sql).toContain("current_setting('baton.tenant_id', true)");
  });

  it('constrains status, scope, and confidence', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      `"scope_type" IN ('global', 'organization', 'project', 'work_thread')`,
    );
    expect(sql).toContain(
      `"status" IN ('proposed', 'approved', 'rejected', 'revoked', 'expired', 'needs_review')`,
    );
    expect(sql).toContain(`"confidence_milli" BETWEEN 0 AND 1000`);
    expect(sql).toContain('nothing here reaches an agent until approved');
  });
});
