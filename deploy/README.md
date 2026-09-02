# Deploying hosted Baton

This is the runbook for taking Baton from "runs on my laptop" to a hosted
service, using **Neon** (Postgres), **Vercel** (dashboard), and a container host
such as **Railway / Render / Fly.io** for the API.

## Topology

```
   developer laptop                          cloud
  ┌────────────────┐        HTTPS       ┌───────────────────────────┐
  │ baton CLI      │ ─────ingest──────► │ API  (apps/api)           │
  │  + daemon      │                    │  Railway / Render / Fly   │
  └────────────────┘                    │  api.example.com          │
                                        └─────────────┬─────────────┘
   browser                                            │ SQL (TLS)
  ┌────────────────┐        HTTPS                     ▼
  │ dashboard      │ ─────────────────► ┌───────────────────────────┐
  │  app.example   │ ◄──cookie/session  │ Postgres (Neon)           │
  │  (Vercel)      │                    └───────────────────────────┘
  └───────┬────────┘
          │ browser login redirect
          ▼
  ┌────────────────┐
  │ OIDC provider  │  (Auth0 / Clerk / WorkOS / Cognito / …)
  └────────────────┘
```

**What you host:**

| Piece               | Where                   | Notes                                   |
| ------------------- | ----------------------- | --------------------------------------- |
| Postgres            | Neon                    | Managed. Run migrations against it.     |
| Dashboard (Next.js) | Vercel                  | `apps/dashboard`.                       |
| **API (Fastify)**   | Railway / Render / Fly  | `apps/api`. Always-on. Dockerized.      |
| Worker              | same host, **later**    | `apps/worker` — Phase-1 stub for now.   |
| **OIDC provider**   | external SaaS           | Prod turns dev-login OFF; you need one. |
| CLI                 | each developer's laptop | Points `BATON_API_URL` at the API.      |

---

## 1. Postgres on Neon

1. Create a Neon project. Grab the connection string (it ends with
   `?sslmode=require`).
2. Set it as `DATABASE_URL` for the API (and later the worker).
3. Run migrations once, from a machine that has this repo checked out:

   ```bash
   DATABASE_URL="postgres://…neon…/baton?sslmode=require" pnpm db:migrate
   ```

   Use Neon's **direct** (non-pooled) connection string for migrations. The API
   runtime can use either; the pooled endpoint is fine for request traffic.

### Row-level security — do not skip

Tenant isolation is enforced by Postgres RLS. The schema uses
`FORCE ROW LEVEL SECURITY`, and every request sets `baton.tenant_id` before it
touches tenant tables. Two rules for the runtime DB role:

- It must **not** have the `BYPASSRLS` attribute.
- It is subject to policy even as table owner (that is what `FORCE` buys us).

A role that skips setting `baton.tenant_id` sees **zero** rows (the policy
compares `tenant_id = NULL`). That is the intended failure mode — if the
dashboard shows nothing after deploy, confirm the session GUC is being set, not
that data is missing. (See the `baton-postgres-rls-gate` note.)

---

## 2. API on Railway / Render / Fly

The API is a long-running Fastify server (device-flow polling + session
cookies), so it needs an always-on container — not Vercel serverless.

- **Dockerfile:** `apps/api/Dockerfile`
- **Build context / root directory:** the **repository root** (the image needs
  the whole pnpm workspace).
- **Health check:** `GET /health/live` → `{"status":"ok"}`
- **Custom domain:** `api.example.com` (see §5 — this matters for cookies).

Local build to sanity-check before wiring a host:

```bash
docker build -f apps/api/Dockerfile -t baton-api .
docker run --rm -p 4000:4000 --env-file deploy/api.env baton-api
```

### API environment variables

| Variable                      | Example / value                            | Required               |
| ----------------------------- | ------------------------------------------ | ---------------------- |
| `NODE_ENV`                    | `production`                               | yes                    |
| `DATABASE_URL`                | `postgres://…neon…/baton?sslmode=require`  | yes                    |
| `BATON_TOKEN_PEPPER`          | random ≥32 chars — **rotate, keep secret** | yes                    |
| `BATON_COOKIE_SECRET`         | random ≥32 chars — **rotate, keep secret** | yes                    |
| `BATON_PUBLIC_API_URL`        | `https://api.example.com`                  | yes (HTTPS)            |
| `BATON_DASHBOARD_URL`         | `https://app.example.com`                  | yes (HTTPS)            |
| `PORT`                        | platform-provided (default 4000)           | usually auto           |
| `OIDC_ISSUER`                 | `https://your-tenant.auth0.com/`           | yes                    |
| `OIDC_AUTHORIZATION_ENDPOINT` | from the provider                          | yes                    |
| `OIDC_TOKEN_ENDPOINT`         | from the provider                          | yes                    |
| `OIDC_USERINFO_ENDPOINT`      | from the provider                          | yes                    |
| `OIDC_CLIENT_ID`              | from the provider                          | yes                    |
| `OIDC_CLIENT_SECRET`          | from the provider                          | if confidential client |
| `BATON_DEV_LOGIN`             | **unset / never `true`**                   | —                      |

In production the config loader **requires** the OIDC set, requires the URLs to
be HTTPS, and forces `devLogin` off regardless of `BATON_DEV_LOGIN`. Generate a
secret with `openssl rand -hex 24`.

---

## 3. Dashboard on Vercel

- **Root directory:** `apps/dashboard` (Vercel detects the pnpm workspace and
  installs from the repo root).
- **Build command:** default (`next build`) works; or
  `pnpm --filter @baton/dashboard build`.
- **Custom domain:** `app.example.com`.
- **Environment:**

  | Variable                    | Value                     |
  | --------------------------- | ------------------------- |
  | `NEXT_PUBLIC_BATON_API_URL` | `https://api.example.com` |

  (`NEXT_PUBLIC_*` is baked in at build time — redeploy after changing it.)

---

## 4. OIDC provider

Pick any OIDC provider (Auth0, Clerk, WorkOS, Cognito, Okta, …). Create an
application and set:

- **Redirect / callback URL:** `https://api.example.com/v1/auth/web/callback`
- **Grant:** Authorization Code + PKCE (the API sends PKCE).
- Copy issuer + the three endpoints + client id/secret into the API env (§2).

Login flow: dashboard → `GET https://api.example.com/v1/auth/web/login` →
provider → back to `/v1/auth/web/callback` → session cookie → dashboard.

---

## 5. The cookie / domain gotcha (read this)

The session is a cookie set by the API and sent by the dashboard on
`fetch(..., { credentials })`. Whether the browser sends it depends on whether
API and dashboard are the **same site**.

**Do this:** put both behind one registrable domain via subdomains —
`app.example.com` (Vercel) and `api.example.com` (Railway). Then they are
same-site, the current `SameSite=Lax` + `__Host-` cookies work as-is, and CORS
already allows the dashboard origin with credentials. No code change.

**Do NOT** rely on the raw platform hostnames (`something.vercel.app` +
`something.up.railway.app`). Those are **different sites** → the `Lax` session
cookie is not sent on cross-site requests, and Safari blocks third-party cookies
outright, so login silently fails. Making that work would require switching the
cookie to `SameSite=None; Secure` in `apps/api/src/app.ts` (`cookieOptions`).
Use custom subdomains instead and avoid the problem.

Cookie behavior is already correct for HTTPS: `secure` flips on automatically
(the cookie name becomes `__Host-baton_session`) when `BATON_PUBLIC_API_URL` is
`https:`.

---

## 6. Point the CLI at production

On each developer laptop:

```bash
export BATON_API_URL=https://api.example.com
baton login                 # device flow → browser → your OIDC
baton enable                # in each project to capture
baton service install       # always-on daemon, auto-starts at login
```

One daemon covers every enabled project. Per-laptop state
(`~/.config/baton/installation-map.json` + credentials) is local and not synced
between machines; the captured conversation data lives server-side, so the
dashboard shows all machines together.

---

## 7. Worker (later)

`apps/worker` is a heartbeat-only stub today (durable jobs = Phase 2). When
those land, deploy `apps/worker/Dockerfile` as a second service on the same host
with the same `DATABASE_URL`. It needs no inbound port.
