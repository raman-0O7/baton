# Data classification, collection, and consent

**Status:** Phase 0 privacy and ingestion contract  
**Default:** deny collection unless both the project and field category are
explicitly allowed

## 1. Data classification

| Class                                 | Examples                                                                                                                                                                                                            | Handling                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C0 — Public product data              | Public documentation and published schemas                                                                                                                                                                          | No tenant restriction required.                                                                                                                                                                                                |
| C1 — Account and operational metadata | User ID, email, device label, consent version, timestamps, service metrics, content-free audit events                                                                                                               | Tenant restricted where applicable; never use as conversation context unless required for the requested feature.                                                                                                               |
| C2 — Source metadata                  | Enabled project label, agent/model, branch, file paths, source-session and thread IDs, event timestamps and hashes                                                                                                  | Tenant restricted. Paths can be sensitive and receive the same access controls as content. Absolute local project paths remain on the device; only an optional user-visible label or non-reversible matching value may upload. |
| C3 — Customer content                 | User/assistant text, plans, todos, commands, bounded tool results, diffs, summaries, chunks, embeddings, decisions, evidence, and memory                                                                            | Highly confidential tenant data; readable by Baton only for consented features, encrypted in transit/at rest, excluded from ordinary logs and analytics.                                                                       |
| C4 — Restricted/prohibited            | Credentials, private keys, tokens, environment dumps, credential files, complete native session payloads, repository snapshots, binaries, ignored files, and inferred protected or highly sensitive personal traits | MUST NOT be intentionally collected. Detect and redact or reject before upload. An incident is opened if an unredacted credential is found in cloud storage.                                                                   |

Provider prompts and responses inherit the highest classification of their
inputs. Hashing or embedding C3 content does not lower its classification.

## 2. Collection pipeline

Collection is allowlist-first:

1. A supported adapter reads an agent source after the last acknowledged cursor.
2. It constructs canonical events using only fields allowed by the active,
   versioned project policy.
3. It applies field and payload-size caps and excludes ignored paths/categories.
4. The mandatory local scrubber redacts known credential patterns and
   high-entropy secrets.
5. Only the normalized, scrubbed event DTO is serialized for upload.
6. The server revalidates authentication, active project consent, tenant
   ownership, schema, size, hashes, and content policy, then performs a
   defense-in-depth secret scan.

The implementation MUST NOT serialize a complete native session and then rely on
redaction. The ingestion and artifact contracts MUST reject raw/native payload
fields, unknown fields, environment dumps, complete agent files, and complete
repository snapshots.

### Default allowlist

- user and assistant conversational text;
- explicit plans, tasks, and todo state;
- commands after local argument scrubbing;
- bounded, scrubbed tool results useful to failures or decisions;
- file paths and bounded unified diffs already present in the agent session; and
- agent, model, timestamp, project label, branch, session, ordering, and
  integrity metadata.

### Default denylist

- environment and process dumps;
- credential/key files and detected secrets;
- arbitrary files merely referenced by a conversation;
- complete repository or working-tree snapshots;
- complete native Claude, Codex, or OpenCode payloads;
- binary data and oversized output above the displayed policy cap;
- user-configured ignored paths and categories; and
- inferred health, biometric, sexual, political, religious, precise-location,
  financial-account, or other protected/highly sensitive personal traits.

An allowed diff can still contain a secret; the scrubber therefore runs after
the allowlist. Server scanning never makes bypassing the local scrubber
acceptable.

## 3. Consent experience

`baton login` does not grant collection consent. Each local project installation
requires an affirmative `baton enable` action or equivalent dashboard-confirmed
flow. Detecting a repository or finding historical sessions MUST NOT enable it.

Before enabling, Baton shows in plain language:

- the local project label and detected agents;
- each collected and excluded category, including payload caps;
- that capture is continuous until paused or disabled;
- that Baton Cloud can read and process uploaded content;
- that Baton-managed model providers may process minimum necessary excerpts;
- that customer content is not used to train models;
- the current subprocessor link and retention/deletion summary;
- how to narrow the policy, pause, disable, export, and delete; and
- that enabling new capture does not import historical sessions.

The final action is unchecked/affirmative and specific to that installation.
Consent MUST NOT be inferred from CLI installation, login, silence, a bundled
terms checkbox, an agent/MCP call, or prior enablement of another project or
device.

The server records:

```text
consent_record_id
user_id and tenant_id
cloud_project_id and project_installation_id
device_id
policy_version and disclosure_version
allowed categories and caps
cloud/model processing acknowledgement
captured_at and effective_at
capture surface (CLI/dashboard)
revoked_at (nullable)
```

The disclosure text or a stable digest of it is retained with its version.

## 4. Policy changes and historical import

- Narrowing a policy takes effect before the next read/upload. Baton explains
  that prior data remains until the user deletes the affected scope and offers
  that deletion action.
- Widening categories or caps requires a new affirmative confirmation; a remote
  MCP tool cannot widen them.
- A material new purpose, data category, subprocessor use, or retention period
  requires a new disclosure version and re-consent before collection under that
  version. Failure to re-consent keeps capture stopped, not silently downgraded.
- Security fixes and changes that reduce collection do not require renewed
  consent but are recorded.

Historical import is a separate, one-time consent. Its preview MUST show agents,
date range, conversation count, estimated post-policy upload size, active
categories/caps, and likely redaction count. The user can select a date range or
skip. Canceling an import does not disable new capture; enabling new capture
does not authorize history.

## 5. User controls

| Action                                | Immediate effect                                                                                     | Existing cloud data                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Pause                                 | Stop new reads/uploads for the installation until resumed.                                           | Retained and available.                                                                                       |
| Disable installation                  | Stop watching and uploading from that device/project installation; revoke its active consent record. | Retained and available until separately deleted.                                                              |
| Withdraw project consent              | Reject new ingestion for the cloud project from every device, even if a watcher is stale.            | Retained but clearly offered for project deletion.                                                            |
| Narrow policy                         | Reject newly disallowed fields/categories before the next upload.                                    | Retained until category/project deletion is requested.                                                        |
| Delete session/thread/project/account | Freeze affected ingestion and start the deletion workflow.                                           | Unavailable from live product reads as specified in the retention matrix, then purged from backups on expiry. |
| Revoke device                         | Revoke its credentials and prevent ingestion/readback.                                               | Other devices and retained cloud data are unaffected.                                                         |

The daemon displays current sync state and a visible pause control. The
dashboard shows all enabled installations/devices, policy version, last upload,
and consent status. A stale or revoked client receives a non-retryable consent
error and MUST NOT advance its local checkpoint.

## 6. Purpose limitation and personalization

C3 data is used only to ingest, synchronize, organize, search, retrieve,
summarize, personalize, secure, support, export, and delete the user's Baton
data, plus aggregate service metrics that contain no raw content.

Baton and its subprocessors MUST NOT train or fine-tune foundation or shared
models on customer content. Product experiments using identifiable customer
content require a separate explicit opt-in and cannot be bundled with core
service consent.

Memory extraction excludes prohibited sensitive categories. A model can only
propose a structured candidate with source evidence. It cannot approve the
candidate, change its scope without validation, or expose it to agents. Only a
user-approved memory is retrievable, and the user can edit, reject, expire,
export, or delete it.

## 7. Measurable pre-beta gate

- **100%** of upload fields map to a versioned allowlist entry and data class.
- **100%** of enabled installations have an active consent record matching the
  accepted server policy; ingestion without one is rejected before storage.
- New login, agent discovery, and historical discovery result in **zero**
  automatic project enables or historical uploads.
- Widening-policy and history-import tests require separate affirmative actions
  and preserve the exact disclosure/policy versions.
- Revocation/disable tests reject the next batch from every affected device and
  do not advance its checkpoint.
- The seeded-secret and forbidden-payload corpus yields **zero** unredacted
  secrets, environment dumps, credential files, complete repository snapshots,
  or complete native payloads in accepted storage.
- Model-provider contracts are inventoried and contractually prohibit training
  on customer content before the first customer event is sent.
- Dashboard/CLI copy passes a review proving users can distinguish pause,
  disable, withdrawal, export, and deletion without consulting documentation.
