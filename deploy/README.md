# Deploying hosted Baton

This is the runbook for taking Baton from "runs on my laptop" to a hosted
service on a **$0 footprint**: **Neon** (Postgres free tier), and **Vercel**
(free tier) for both the dashboard and the API.

The API is stateless — every request reads/writes Postgres, with no in-memory
session store, background timers, or sockets — so it runs as a **single Vercel
serverless function** instead of an always-on paid container. No Railway/Render
bill. (The `apps/api/Dockerfile` is still there if you ever want to run it as a
long-running container instead; see the note at the end of §2.)

## Topology

```
   developer laptop                          cloud
  ┌────────────────┐        HTTPS       ┌───────────────────────────┐
  │ baton CLI      │ ─────ingest──────► │ API  (apps/api)           │
  │  + daemon      │                    │  Vercel serverless fn     │
  └────────────────┘                    │  api.example.com          │
                                        └─────────────┬─────────────┘
   browser                                            │ SQL (TLS, pooled)
  ┌────────────────┐        HTTPS                     ▼
  │ dashboard      │ ─────────────────► ┌───────────────────────────┐
  │  app.example   │ ◄──cookie/session  │ Postgres (Neon)           │
  │  (Vercel)      │                    └───────────────────────────┘
  └───────┬────────┘
          │ browser login redirect
          ▼
  ┌────────────────┐
  │ login provider │  (Google / GitHub / any OIDC)
  └────────────────┘
```

**What you host:**

| Piece               | Where                   | Notes                                  |
| ------------------- | ----------------------- | -------------------------------------- |
| Postgres            | Neon (free)             | Managed. Run migrations against it.    |
| Dashboard (Next.js) | Vercel (free)           | `apps/dashboard`.                      |
| **API (Fastify)**   | Vercel (free)           | `apps/api`. Serverless function. $0.   |
| Worker              | **later**               | `apps/worker` — Phase-1 stub for now.  |
| **Login provider**  | Google / GitHub / OIDC  | Prod turns dev-login OFF; you need ≥1. |
| CLI                 | each developer's laptop | Points `BATON_API_URL` at the API.     |

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

## 2. API on Vercel (serverless, free)

The whole Fastify app runs as one serverless function. `apps/api/vercel.json`
rewrites every path to `apps/api/api/index.ts`, which builds the wired app once
per warm instance and serves each request through Fastify. The build compiles
the workspace with `pnpm --filter @baton/api... build`.

Two config details make this work on Vercel and are already in `vercel.json`:

- **Empty `public/` output dir.** A `framework: null` project with a custom
  build command must emit an output directory, but this is a pure API with no
  static frontend. `apps/api/public/.gitkeep` gives Vercel an (empty) output
  directory to satisfy that check; the catch-all rewrite means nothing static is
  ever served — every path hits the function.
- **Relative import, not the package self-reference.** `api/index.ts` imports
  `../dist/server.js` (a real built file), not `@baton/api/server`. pnpm creates
  no self-symlink, so Vercel's function bundler cannot resolve a self-reference.

Create a **second Vercel project** (separate from the dashboard), same repo:

- **Root Directory:** `apps/api`
- **Framework Preset:** Other (the bundled `vercel.json` sets install/build).
- **Node.js version:** 22.x (Project → Settings → Node.js Version).
- **Custom domain:** `api.example.com` (see §5 — this matters for cookies).
- **Health check:** `GET /health/live` → `{"status":"ok"}`.

### API environment variables

| Variable               | Example / value                            | Required    |
| ---------------------- | ------------------------------------------ | ----------- |
| `NODE_ENV`             | `production`                               | yes         |
| `DATABASE_URL`         | Neon **pooled** string (`…-pooler…`)       | yes         |
| `BATON_TOKEN_PEPPER`   | random ≥32 chars — **rotate, keep secret** | yes         |
| `BATON_COOKIE_SECRET`  | random ≥32 chars — **rotate, keep secret** | yes         |
| `BATON_PUBLIC_API_URL` | `https://api.example.com`                  | yes (HTTPS) |
| `BATON_DASHBOARD_URL`  | `https://app.example.com`                  | yes (HTTPS) |
| _one login provider_   | Google and/or GitHub and/or OIDC — see §4  | yes (≥1)    |
| `BATON_DEV_LOGIN`      | **unset / never `true`**                   | —           |

In production the config loader **requires at least one login provider**
(Google, GitHub, or a full generic OIDC set — §4), requires the public/dashboard
URLs to be HTTPS, and forces `devLogin` off regardless of `BATON_DEV_LOGIN`.
Generate a secret with `openssl rand -hex 24`.

**Use Neon's pooled endpoint** for `DATABASE_URL` here. Each serverless instance
opens its own pool, so many warm instances × a direct connection would exhaust
Neon's connection limit. The pooled (`-pooler`) endpoint fronts them with
PgBouncer; the client already sets `prepare: false`, which pooling requires.

> **Container alternative.** If you ever want the API as a long-running
> container instead of serverless, `apps/api/Dockerfile` still builds it
> (context = repo root, health `GET /health/live`, listens on `PORT`/4000).
> `apps/api/src/main.ts` and the serverless handler share the same wiring
> (`apps/api/src/server.ts`), so both stay in lockstep.

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

## 4. Login providers

Baton builds its own sessions, CLI device flow, and tokens — it does not store
passwords. The human "who are you" step is delegated to a provider. Configure
one or more; the dashboard reads `GET /v1/auth/providers` and renders one button
per configured provider automatically.

Login flow: dashboard → `GET /v1/auth/web/login/<provider>` → provider → back to
`/v1/auth/web/callback/<provider>` → session cookie → dashboard.

### Google (built in — just credentials)

Endpoints are hardcoded; you supply only the client credentials.

1. Google Cloud Console → APIs & Services → Credentials → **OAuth client ID**
   (type: Web application).
2. **Authorized redirect URI:**
   `https://api.example.com/v1/auth/web/callback/google`
3. Set on the API:

   | Variable               | Value                         |
   | ---------------------- | ----------------------------- |
   | `GOOGLE_CLIENT_ID`     | `…apps.googleusercontent.com` |
   | `GOOGLE_CLIENT_SECRET` | from the console              |

### GitHub (built in — just credentials)

GitHub is OAuth2 (not OIDC); Baton reads the profile from the GitHub API and
requires a **verified** primary email.

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App.
2. **Authorization callback URL:**
   `https://api.example.com/v1/auth/web/callback/github`
3. Set on the API:

   | Variable               | Value              |
   | ---------------------- | ------------------ |
   | `GITHUB_CLIENT_ID`     | from the OAuth App |
   | `GITHUB_CLIENT_SECRET` | from the OAuth App |

### Generic OIDC (optional — any other provider)

For Auth0/Clerk/WorkOS/Cognito/Okta/etc., set the full `OIDC_*` set (issuer, the
three endpoints, client id, and secret if confidential). Callback URL:
`https://api.example.com/v1/auth/web/callback`. Authorization Code + PKCE.

---

## 5. The cookie / domain gotcha (read this)

The session is a cookie set by the API and sent by the dashboard on
`fetch(..., { credentials })`. Whether the browser sends it depends on whether
API and dashboard are the **same site**.

**Do this:** put both behind one registrable domain via subdomains —
`app.example.com` and `api.example.com`, each mapped to its Vercel project. Then
they are same-site, the current `SameSite=Lax` + `__Host-` cookies work as-is,
and CORS already allows the dashboard origin with credentials. No code change.

**Do NOT** rely on the raw `*.vercel.app` hostnames (`dashboard-xxx.vercel.app`

- `api-xxx.vercel.app`). `vercel.app` is on the Public Suffix List, so those two
  subdomains are **different sites** → the `Lax` session cookie is not sent on
  cross-site requests, and Safari blocks third-party cookies outright, so login
  silently fails. Making that work would require switching the cookie to
  `SameSite=None; Secure` in `apps/api/src/app.ts` (`cookieOptions`). Use custom
  subdomains of one real domain instead and avoid the problem.

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

`apps/worker` is a heartbeat-only stub today (durable jobs = Phase 2). Unlike
the API, it is a **long-running background loop**, not request/response, so it
does not fit Vercel serverless. When durable jobs land, run
`apps/worker/Dockerfile` on a container host (Fly/Render) — or drive the work
from a scheduler (e.g. Vercel Cron hitting an internal endpoint) — with the same
`DATABASE_URL`. It needs no inbound port.
