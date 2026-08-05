import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../migrations/0000_phase1_identity.sql',
  import.meta.url,
);

describe('Phase 1 identity migration', () => {
  it('creates every identity and audit table', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of [
      'tenants',
      'users',
      'tenant_memberships',
      'browser_sessions',
      'device_authorizations',
      'devices',
      'token_families',
      'access_tokens',
      'refresh_tokens',
      'audit_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it('enforces tenant RLS on post-auth device and audit reads', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY');
    expect(sql).toContain('ALTER TABLE "devices" FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('CREATE POLICY "devices_tenant_isolation"');
    expect(sql).toContain(
      'ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      'ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain("current_setting('baton.tenant_id', true)");
  });

  it('stores only hashes for bearer credential secrets', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('"token_hash" text NOT NULL');
    expect(sql).toContain('"session_hash" text NOT NULL');
    expect(sql).not.toMatch(
      /"(access_token|refresh_token|session_token)" text/i,
    );
    expect(sql).not.toContain('conversation_text');
    expect(sql).not.toContain('raw_transcript');
  });
});
