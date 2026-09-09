import { and, desc, eq, gt, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  identitySchema,
  memoryExtractionState,
  sourceEvents,
  tenants,
} from './schema.js';

type Database = PostgresJsDatabase<typeof identitySchema>;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * One captured message event, flattened to the fields the memory extractor
 * needs. `role` and `text` come from the message payload; non-message events
 * (tool calls, file changes, …) are never returned — preferences are only ever
 * inferred from what a person actually said.
 */
export interface ExtractionSourceEvent {
  eventId: string;
  projectId: string;
  workThreadId: string | null;
  role: string;
  text: string;
  occurredAt: Date;
  ingestedAt: Date;
}

export interface ProjectExtractionWindow {
  projectId: string;
  events: ExtractionSourceEvent[];
}

export interface TenantExtractionWork {
  /** Recent message-event windows for projects that have new events. */
  windows: ProjectExtractionWindow[];
  /**
   * The newest `ingested_at` among the new message events — the value to store
   * as the tenant's cursor after a successful run. Null when nothing is new.
   */
  newestIngestedAt: Date | null;
}

export interface CollectExtractionOptions {
  windowPerProject: number;
  maxProjectsPerRun: number;
}

/**
 * Reads the source events the managed-model memory extractor works from, and
 * keeps a per-tenant high-water cursor so a scheduled run only calls the model
 * when new events have arrived.
 *
 * Tenant enumeration reads the `tenants` table, which is not row-level-security
 * protected (it is control-plane data). Every read or write of tenant-scoped
 * data instead runs inside a transaction that first sets `baton.tenant_id`, so
 * RLS confines it to exactly one tenant — the worker never bypasses RLS.
 */
export class PostgresMemoryExtractionStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  /** All tenant ids. Not RLS-scoped — `tenants` is control-plane data. */
  async listTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ tenantId: tenants.tenantId })
      .from(tenants);
    return rows.map((row) => row.tenantId);
  }

  private async cursor(
    tx: Transaction,
    tenantId: string,
  ): Promise<Date | null> {
    const [row] = await tx
      .select({ lastIngestedAt: memoryExtractionState.lastIngestedAt })
      .from(memoryExtractionState)
      .where(eq(memoryExtractionState.tenantId, tenantId));
    return row?.lastIngestedAt ?? null;
  }

  /**
   * Gather recent message-event windows for a tenant's projects that have new
   * events since the cursor. Returns empty windows (and a null cursor) when
   * nothing new has been ingested, so the caller can skip the model entirely.
   */
  async collectWork(
    tenantId: string,
    options: CollectExtractionOptions,
  ): Promise<TenantExtractionWork> {
    return this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      const since = await this.cursor(tx, tenantId);
      const isMessage = sql`${sourceEvents.payload} ->> 'kind' = 'message'`;

      // Projects with message events newer than the cursor, and the newest
      // ingested_at among them (the next cursor value).
      const fresh = await tx
        .select({
          projectId: sourceEvents.projectId,
          newest: sql<Date>`max(${sourceEvents.ingestedAt})`,
        })
        .from(sourceEvents)
        .where(
          since === null
            ? isMessage
            : and(isMessage, gt(sourceEvents.ingestedAt, since)),
        )
        .groupBy(sourceEvents.projectId)
        .orderBy(desc(sql`max(${sourceEvents.ingestedAt})`))
        .limit(options.maxProjectsPerRun);

      if (fresh.length === 0) return { windows: [], newestIngestedAt: null };

      let newestIngestedAt: Date | null = null;
      for (const row of fresh) {
        const value = new Date(row.newest);
        if (newestIngestedAt === null || value > newestIngestedAt) {
          newestIngestedAt = value;
        }
      }

      const windows: ProjectExtractionWindow[] = [];
      for (const { projectId } of fresh) {
        // The window is the most recent message events for the project, in
        // chronological order — this lets the model see a preference repeated
        // across sessions, which the deterministic validator then requires.
        const recent = await tx
          .select({
            eventId: sourceEvents.eventId,
            projectId: sourceEvents.projectId,
            workThreadId: sourceEvents.workThreadId,
            payload: sourceEvents.payload,
            occurredAt: sourceEvents.occurredAt,
            ingestedAt: sourceEvents.ingestedAt,
          })
          .from(sourceEvents)
          .where(and(eq(sourceEvents.projectId, projectId), isMessage))
          .orderBy(desc(sourceEvents.occurredAt))
          .limit(options.windowPerProject);

        const events: ExtractionSourceEvent[] = [];
        // `recent` is newest-first; reverse into chronological order.
        for (const row of recent.reverse()) {
          if (row.payload.kind !== 'message') continue;
          events.push({
            eventId: row.eventId,
            projectId: row.projectId,
            workThreadId: row.workThreadId,
            role: row.payload.role,
            text: row.payload.text,
            occurredAt: row.occurredAt,
            ingestedAt: row.ingestedAt,
          });
        }
        if (events.length > 0) windows.push({ projectId, events });
      }

      return { windows, newestIngestedAt };
    });
  }

  /** Advance the tenant's cursor after a successful extraction pass. */
  async advanceCursor(tenantId: string, lastIngestedAt: Date): Promise<void> {
    const now = new Date(this.now());
    await this.db.transaction(async (tx) => {
      await setTenant(tx, tenantId);
      await tx
        .insert(memoryExtractionState)
        .values({ tenantId, lastIngestedAt, updatedAt: now })
        .onConflictDoUpdate({
          target: memoryExtractionState.tenantId,
          set: { lastIngestedAt, updatedAt: now },
        });
    });
  }
}

async function setTenant(tx: Transaction, tenantId: string): Promise<void> {
  await tx.execute(
    sql`select set_config('baton.tenant_id', ${tenantId}, true)`,
  );
}
