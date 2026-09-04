# ADR 0005: Hosted content and model processing

- Status: accepted
- Date: 2026-08-01

## Context

Retrieval ranking, thread summaries, and evidence-backed memory candidates can
benefit from hosted language models. Customer conversations are confidential and
may contain adversarial instructions. Binding the product to one provider or
sending full transcripts would create avoidable privacy and portability risk.

## Decision

Model processing is an explicit, provider-agnostic subsystem operating only on
minimum necessary excerpts from projects with current model-processing consent.

- No model provider is selected by this ADR. Providers implement a bounded
  adapter with model/version, region, retention, training-use, and deletion
  capabilities recorded in a subprocessor register.
- A provider contract must prohibit training or fine-tuning shared models on
  Baton customer content. Provider retention may not exceed 30 days; Baton
  requests zero retention where technically and contractually available.
- Prompts contain explicit source delimiters and treat conversation content as
  untrusted evidence, never system instructions. Tools and network access are
  disabled for summarization and memory extraction jobs.
- Requests are scoped by tenant, project, work thread, purpose, token budget,
  and source event IDs. Full native transcripts are not model inputs.
- Outputs must validate against task-specific structured schemas and record
  model, prompt version, source coverage, and evidence references.
- Model output cannot authorize data access, widen memory scope, approve a
  memory, change consent, or execute a tool. Personal memory remains a user
  approval workflow.
- Prompt/response bodies are excluded from normal logs. Controlled job payloads
  and caches follow the deletion and retention matrix.

## Consequences

- Phase 4 can begin with deterministic/full-text retrieval and add embeddings
  only when evaluation demonstrates value.
- Phase 6 memory candidates require evidence and policy validation independent
  of the model.
- Provider changes do not alter event, retrieval, or memory wire contracts.
- A subprocessor inventory and contract review are mandatory before the first
  customer excerpt is sent externally.
