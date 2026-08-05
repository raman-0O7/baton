# Retention and deletion matrix

**Status:** Phase 0 lifecycle contract  
**Time basis:** maximum elapsed time after Baton accepts the request or the
record becomes eligible for expiry

## 1. Principles

- Retain customer content only while needed to provide a user-requested feature
  or meet an explicitly disclosed obligation.
- Pause, disable, and consent withdrawal stop collection but do not pretend to
  delete existing data.
- Deletion makes affected content unavailable from live product reads first,
  then purges every controlled copy and derivative.
- Derived data has no longer lifetime than the source that supports it.
- Backups are expiry based and are not searched or selectively modified during
  routine deletion. Restores reapply deletion tombstones before serving traffic.
- Legal holds are exceptional, scoped, access restricted, and disclosed when
  legally permitted. They do not authorize continued product use of held data.

## 2. Retention matrix

| Data/store                                                                            | Normal retention                                                                             | On scoped deletion                                                                                                  | Maximum deadline                                                                     | Owner / proof                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Canonical events and event edges                                                      | Until the user deletes the event/session/thread/project/account                              | Freeze ingestion; tombstone immediately; hard-delete content and relationships                                      | Unavailable from live reads in 1 hour; purged from primary/replicas in 24 hours      | Data service; deletion ledger plus negative query test |
| Source sessions, work threads, snapshots, decisions, tasks, errors, and file activity | While their project exists                                                                   | Delete or rebuild without deleted sources                                                                           | Same as canonical events                                                             | Data service; projection reconciliation                |
| Chunks, full-text indexes, and embeddings                                             | While supporting source events exist                                                         | Delete entries/vectors for deleted sources and invalidate retrieval caches                                          | 24 hours                                                                             | Retrieval service; search for canary returns zero      |
| Summaries and model-derived projections                                               | While supporting sources exist or until superseded                                           | Delete or regenerate without deleted sources                                                                        | 24 hours                                                                             | Worker; provenance scan returns no deleted source      |
| Memory candidates                                                                     | Until acted on, or 90 days after last evidence update                                        | Delete candidate and evidence links                                                                                 | 24 hours on user deletion; otherwise automatic expiry at 90 days                     | Memory service; expiry metric and evidence check       |
| Approved memories, revisions, and evidence                                            | Until revoked/expired/deleted; reviewed when their evidence changes                          | Remove deleted evidence; delete a memory that has no remaining eligible evidence; otherwise mark it for user review | 24 hours                                                                             | Memory service; unsupported-memory check               |
| Allowed object artifacts                                                              | While their source event exists                                                              | Revoke grants and delete object plus metadata                                                                       | Grant revoked within 1 hour; object deleted in 24 hours                              | Object lifecycle worker; object HEAD/read fails        |
| Ingestion request buffers and failed/rejected payloads                                | Process in memory where possible; never retained for debugging as raw bodies                 | Drop immediately                                                                                                    | 1 hour maximum temporary processing lifetime                                         | API/platform; storage inventory                        |
| Baton-controlled model prompts/responses and job payloads                             | Minimum necessary; no content in normal logs. Ephemeral job payloads expire after completion | Delete controlled caches/jobs and cancel pending jobs                                                               | 24 hours; routine automatic expiry no later than 7 days                              | AI/worker owner; cache and jobs scan                   |
| Model-provider copies                                                                 | Provider contract must prohibit training and publish a bounded retention period              | Submit deletion where supported; otherwise provider expiry applies                                                  | No more than 30 days after processing/deletion                                       | Privacy owner; subprocessor register and contract      |
| Export archives                                                                       | Until download/expiry                                                                        | Revoke download and delete archive                                                                                  | Automatically within 24 hours of creation; within 1 hour of account/project deletion | Export worker; object lifecycle report                 |
| Consent records and content-free deletion receipts                                    | Account lifetime plus 3 years, or longer only when legally required and documented           | Pseudonymize direct identifiers; retain policy/version/timestamps needed to prove the action                        | 30 days after account deletion for pseudonymization                                  | Privacy owner; data inventory                          |
| Content-free security/audit events                                                    | 365 days                                                                                     | Pseudonymize user/device identifiers on account deletion; retain security event facts                               | 30 days for pseudonymization; automatic expiry at 365 days                           | Security owner; lifecycle policy                       |
| Service logs, traces, and content-free analytics                                      | 30 days by default; security logs follow the audit row above                                 | Remove direct account selectors where present                                                                       | 30 days                                                                              | Platform owner; logging retention config               |
| Browser sessions, device credentials, refresh-token families, MCP grants              | Until expiry or revoke; inactive device credentials expire after 90 days                     | Revoke immediately and delete secret material                                                                       | Authorization denied within 5 minutes; secret material removed in 24 hours           | Identity service; replay/revoke test                   |
| Database/object backups                                                               | Rolling encrypted backups only                                                               | Record deletion tombstone; backups expire without reuse of deleted content                                          | 35 days maximum                                                                      | Platform owner; backup inventory and restore drill     |
| Billing/tax records (paid beta onward)                                                | Only fields legally required; no conversation content                                        | Remove optional fields and retain required record for the applicable statutory period                               | Jurisdiction-specific schedule published before paid beta                            | Finance/privacy owner; record inventory                |

No production store may hold C3 customer content unless it appears in this
matrix. Adding one requires updating this contract, the subprocessor/data-flow
inventory, and the deletion orchestrator before deployment.

## 3. Deletion semantics by scope

- **Event:** delete the event content and derivatives. Preserve only a
  content-free tombstone needed to prevent replay until its source session is
  deleted.
- **Source session:** delete all events unique to it and rebuild affected thread
  projections. Shared approved memory survives only if it retains eligible
  evidence.
- **Work thread:** delete its joins and thread-derived data; source sessions
  explicitly attached only to that thread are included after user confirmation.
- **Project:** stop all project ingestion, revoke project-scoped grants, and
  delete installations, sessions, threads, events, artifacts, retrieval data,
  project memories, and project-derived evidence.
- **Memory:** delete candidate/memory, revisions containing its content,
  evidence joins, rendering, and retrieval/cache entries without deleting the
  underlying conversation unless separately requested.
- **Account:** revoke every session/credential/grant, stop ingestion, and delete
  every project and personal memory. Retain only pseudonymized content-free
  records explicitly listed in the matrix.

The confirmation screen enumerates inclusions and exclusions. It never uses a
soft-delete label when content remains available to Baton features.

## 4. Deletion workflow

1. Authenticate and, for project/account deletion, require recent or step-up
   authentication.
2. Resolve scope under the authenticated tenant; issue an opaque deletion ID.
3. Mark the scope `deletion_pending`, reject new ingestion, revoke scoped object
   and MCP grants, and hide it from live product reads.
4. Delete primary content and enqueue idempotent child jobs for projections,
   search/vector indexes, objects, model caches/jobs, memory evidence, exports,
   replicas, and external processors where supported.
5. Reconcile every child job against an inventory; retry safely and alert on a
   missed deadline.
6. Run negative read/search/object tests and a provenance scan for unsupported
   summaries and memories.
7. Show `complete_from_live_systems` with the backup-expiry date. Issue a
   content-free receipt and audit event.
8. Keep a tombstone through the backup window. Any restore MUST apply tombstones
   and rerun reconciliation before becoming queryable.
9. Mark final purge complete when the last eligible backup and provider copy has
   expired.

Deletion APIs are idempotent. Repeating a request returns the same outcome
without revealing whether an identifier belongs to another tenant.

## 5. Export contract

Users may export canonical projects, threads, source events, evidence, approved
memories, and consent metadata as documented JSON/Markdown. Exports:

- require recent/step-up authentication and explicit scope selection;
- preserve timestamps, source IDs, provenance, and schema versions;
- contain normalized Baton events, not complete native agent payloads;
- are encrypted at rest and downloaded through a short-lived, one-use,
  tenant-scoped grant;
- are not placed in logs, email attachments, or analytics; and
- expire and are deleted within 24 hours even if never downloaded.

An export request does not pause retention or deletion. If its source is deleted
while generation is pending, the job fails closed and deletes partial output.

## 6. Measurable pre-beta gate

- Automated project and account lifecycle tests cover every row in the matrix
  and fail when a registered store has no deletion handler.
- Within **1 hour** of a deletion request, live API, dashboard, MCP, search, and
  signed-object reads return no deleted content; the beta target is **5
  minutes** and the contractual maximum is 1 hour.
- Within **24 hours**, primary, replica, index, object, Baton-controlled model
  cache/job, memory, and export scans find **zero** copies or unsupported
  derivatives.
- A restore drill reapplies tombstones before traffic and returns **zero**
  deleted canary records.
- Backup inventory proves no recoverable customer-content backup is older than
  **35 days**.
- Export tests prove cross-tenant IDs, revoked grants, expired grants, and
  deleted sources yield **zero** archive bytes.
- Deletion deadline and failure metrics alert an on-call owner before the
  published deadline; no deletion job may silently remain pending.
- The dashboard reports deletion ID, live-system status, requested time,
  completion time, and final backup-expiry date without exposing deleted
  content.
