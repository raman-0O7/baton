import { randomUUID } from 'node:crypto';

import type { IngestionRequestContext } from '@baton/database';
import type {
  CollectExtractionOptions,
  ExtractionSourceEvent,
  TenantExtractionWork,
} from '@baton/database';
import type { MemoryEvidence, MemoryProposeInput } from '@baton/database';
import type { ExtractionEvent, ModelGateway } from '@baton/memory';

/** The extraction-store surface the orchestrator needs (see `@baton/database`). */
export interface ExtractionWorkSource {
  listTenantIds(): Promise<string[]>;
  collectWork(
    tenantId: string,
    options: CollectExtractionOptions,
  ): Promise<TenantExtractionWork>;
  advanceCursor(tenantId: string, lastIngestedAt: Date): Promise<void>;
}

/** The memory-store surface the orchestrator needs — proposal only. */
export interface CandidateSink {
  proposeCandidate(
    context: IngestionRequestContext,
    input: MemoryProposeInput,
  ): Promise<{ status: string }>;
}

export interface MemoryExtractionDependencies {
  source: ExtractionWorkSource;
  sink: CandidateSink;
  gateway: ModelGateway;
  options: CollectExtractionOptions;
  log(
    message: string,
    fields?: Record<string, string | number | boolean>,
  ): void;
}

export interface MemoryExtractionSummary {
  tenants: number;
  tenantsWithWork: number;
  projectsProcessed: number;
  candidatesProposed: number;
  candidatesAccepted: number;
}

/**
 * Run one pass of managed-model memory extraction across every tenant.
 *
 * For each tenant it collects the recent message-event windows for projects
 * with new events, asks the model to propose durable preferences, and records
 * each proposal through the memory store — whose deterministic validator and
 * signature de-duplication decide what actually enters the approval inbox.
 * Nothing here approves a memory; a person still does that in the dashboard.
 *
 * The pass is resilient per tenant: one tenant's failure is logged and skipped
 * so a single bad tenant cannot stall extraction for everyone. A tenant's
 * cursor advances only after its windows are processed without throwing.
 */
export async function runMemoryExtraction(
  dependencies: MemoryExtractionDependencies,
): Promise<MemoryExtractionSummary> {
  const { source, sink, gateway, options, log } = dependencies;
  const provenance = {
    provider: gateway.provider,
    model: gateway.model,
    promptVersion: gateway.promptVersion,
  };

  const tenantIds = await source.listTenantIds();
  const summary: MemoryExtractionSummary = {
    tenants: tenantIds.length,
    tenantsWithWork: 0,
    projectsProcessed: 0,
    candidatesProposed: 0,
    candidatesAccepted: 0,
  };

  for (const tenantId of tenantIds) {
    try {
      const work = await source.collectWork(tenantId, options);
      if (work.windows.length === 0) continue;
      summary.tenantsWithWork += 1;

      const context: IngestionRequestContext = {
        principal: {
          userId: SYSTEM_PRINCIPAL_ID,
          tenantId,
          deviceId: null,
          scopes: ['memory:write'],
          credentialKind: 'access_token',
          credentialId: 'system-memory-extractor',
        },
        requestId: `extract-${randomUUID()}`,
      };

      for (const window of work.windows) {
        summary.projectsProcessed += 1;
        const byId = new Map<string, ExtractionSourceEvent>(
          window.events.map((event) => [event.eventId, event]),
        );
        const events: ExtractionEvent[] = window.events.map((event) => ({
          eventId: event.eventId,
          projectId: event.projectId,
          workThreadId: event.workThreadId,
          role: event.role,
          text: event.text,
        }));

        const candidates = await gateway.extract(events);
        for (const candidate of candidates) {
          const evidence: MemoryEvidence[] = [];
          for (const eventId of candidate.evidenceEventIds) {
            const event = byId.get(eventId);
            if (event === undefined) continue;
            evidence.push({
              eventId: event.eventId,
              projectId: event.projectId,
              workThreadId: event.workThreadId,
              text: event.text,
              role: event.role,
            });
          }
          if (evidence.length < 2) continue;

          const input: MemoryProposeInput = {
            category: candidate.category,
            claim: candidate.claim,
            scope: { type: 'project', id: window.projectId },
            evidence,
            provenance,
          };
          const result = await sink.proposeCandidate(context, input);
          summary.candidatesProposed += 1;
          if (result.status === 'proposed') summary.candidatesAccepted += 1;
        }
      }

      if (work.newestIngestedAt !== null) {
        await source.advanceCursor(tenantId, work.newestIngestedAt);
      }
    } catch (error) {
      log('memory extraction tenant failed', {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return summary;
}

// A fixed, non-personal identifier for extractor-authored proposals. The memory
// store keys writes by tenant, not by this id; it exists only so provenance and
// audit records name a stable system actor rather than a real user.
const SYSTEM_PRINCIPAL_ID = '00000000-0000-0000-0000-000000000000';
