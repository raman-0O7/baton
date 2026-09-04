# Hosted Baton local development

The hosted TypeScript runtime includes cloud identity and Phase 2 incremental
capture. Node 22.17+ and pnpm 10.13 are required.

## Start the services

1. Copy `.env.example` to `.env` and keep it out of version control.
2. Start PostgreSQL with `docker compose -f deploy/compose.yml up -d postgres`.
3. Run `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm db:migrate`.
4. Start the API with `pnpm dev:api` and the dashboard with
   `pnpm dev:dashboard`.
5. Point the CLI at it with
   `BATON_API_URL=http://localhost:4000 pnpm baton-cloud doctor`.

The CLI's login flow requires the configured dashboard/OIDC path. After login,
the local capture flow is:

```console
cd /path/to/project
BATON_API_URL=http://localhost:4000 pnpm baton-cloud enable
BATON_API_URL=http://localhost:4000 pnpm baton-cloud daemon
```

`enable` displays the frozen collection disclosure and establishes current
source cursors without importing earlier conversations. See
[`incremental-sync.md`](./incremental-sync.md) for controls and path overrides.

The development API deliberately has no fake login route. Supply a real OIDC
configuration when exercising browser login. Tests inject a deterministic
provider and never weaken the production entry point.

## Security conventions

- The API derives tenant and user identity from a hashed credential, never a
  request body or query parameter.
- Access tokens last 15 minutes. Every refresh rotates the refresh token; replay
  revokes its entire credential family.
- Browser sessions are HTTP-only and secure in production. Dashboard requests
  include them with credentialed requests to the one configured API origin.
- The API only permits credentialed CORS from `BATON_DASHBOARD_URL`.
- PostgreSQL stores credential hashes, not raw tokens. Tenant-owned device and
  audit tables enforce row-level policies.
- Production uses a non-superuser API database role without `BYPASSRLS`; schema
  migrations run under a separate owner role.
- Logs redact authorization, cookie, token, device-code, and verifier fields.
  Conversation content is never included in application audit metadata or
  request logs. Ingestion audits contain IDs and counts only.

## Production configuration

Production startup fails unless API/dashboard URLs use HTTPS and the OIDC
issuer, authorization, token, userinfo, and client-ID settings are complete. Use
independently generated values of at least 32 characters for
`BATON_TOKEN_PEPPER` and `BATON_COOKIE_SECRET`; do not reuse the examples.
