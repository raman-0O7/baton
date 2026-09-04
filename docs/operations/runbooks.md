# Baton operations runbooks

These runbooks cover the operational lifecycle for the individual-developer
private beta. The application code for export, deletion, quotas, and retention
is implemented and tested; the infrastructure steps below (managed PostgreSQL,
object storage, backups, alerting) are provisioned per environment and are
described here as the operator contract, not as automated code in this
repository.

## Backup and restore

- **Primary store (PostgreSQL):** enable managed point-in-time recovery (PITR)
  with a minimum 7-day window. Take a nightly base backup; retain 30 days.
- **Object storage (allowlisted artifacts):** enable versioning and a lifecycle
  policy matching the published retention window.
- **Restore drill (run monthly):**
  1. Provision a scratch database from the latest PITR snapshot.
  2. Run `pnpm --filter @baton/database db:migrate` against it to confirm the
     schema applies cleanly from the committed migrations.
  3. Run the database integration suite against the restored instance with
     `TEST_DATABASE_URL` pointed at it; all tenant-isolation (RLS) tests must
     pass.
  4. Record the restore time; the target is < 1 hour to a queryable state.

## Disaster recovery

- **RPO:** ≤ 5 minutes (PITR WAL shipping). **RTO:** ≤ 1 hour.
- Keep one warm standby in a second availability zone. Failover promotes the
  standby and repoints `DATABASE_URL`.
- Object storage is region-replicated; no promotion step is required.
- After any failover, run the restore drill's steps 3–4 against the promoted
  primary before re-enabling writes.

## Deletion drill (run monthly, and after any deletion incident)

The deletion workflow is `PostgresLifecycleStore.deleteProject` /
`deleteAccount`, exposed at `POST /v1/projects/:id/delete` and
`POST /v1/account/delete`. Each returns a receipt with per-collection counts.

1. Seed a disposable tenant with events, work threads, chunks, and memories.
2. Call account deletion and capture the receipt.
3. Assert that every content read path returns empty for the tenant:
   `/v1/projects`, `/v1/work-threads`, `/v1/retrieval/search`,
   `/v1/memory/memories`. The automated gate
   (`apps/api/test/lifecycle.e2e.test.ts` and
   `packages/database/test/lifecycle-store.test.ts`) proves this on every CI
   run.
4. Confirm object-storage artifacts for the tenant are removed or tombstoned and
   that any model-input/output caches Baton controls are purged.
5. Record completion time; deletion must be observably complete, not eventual.

## Quotas, cost budgets, and graceful degradation

- Plans and limits: `@baton/protocol` `quotaPlans` (`free`, `beta`).
- Enforcement points check `checkQuota(usage, limits)` before creating new
  projects/events/chunks/memories; `withinModelBudget` gates managed-model
  calls. When a model budget is exhausted, capture and lexical retrieval keep
  working — only optional managed-model features degrade.
- Retention: `RetentionPolicy` + `isRetentionExpired` drive a periodic expiry
  sweep that removes events past their window using the same purge primitives as
  deletion.

## Staged rollout

Follow plan §17 in order, gating each stage on the prior one's metrics:

1. **Internal dogfood** — one account, synthetic and sanitized data.
2. **Design partners** — a small set using at least two agents; content
   processing and retention consent are explicit.
3. **Private beta** — individual accounts, quotas on, support channel, export
   and deletion verified per account.
4. **Paid beta** — metered managed-AI usage, published reliability targets.
5. **GA** — only after adapter-format monitoring, deletion drills, backup
   restores, and cross-agent continuation metrics are stable.

Feature-flag historical import, embeddings, model-generated summaries, SOUL
extraction, and any MCP write tools. The deterministic capture + lexical
retrieval path must continue to work with every optional AI feature disabled.

## Notifications (operator contract)

Emit product/email notifications for: repeated sync failures for an enabled
project, pending security events (new device, credential rotation/revocation),
and quota/budget thresholds. Never place conversation content in notification
bodies or logs.
