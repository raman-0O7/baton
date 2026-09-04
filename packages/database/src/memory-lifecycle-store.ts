import type { DeletionReceipt } from '@baton/protocol';

import {
  IngestionStoreError,
  type IngestionRequestContext,
} from './ingestion-store.js';
import type { InMemoryIngestionStore } from './memory-ingestion-store.js';
import type { InMemoryMemoryStore } from './memory-memory-store.js';
import type { InMemoryRetrievalStore } from './memory-retrieval-store.js';
import type { InMemoryWorkThreadStore } from './memory-work-thread-store.js';
import {
  mergeCounts,
  type ExportContent,
  type LifecycleStore,
} from './lifecycle-store.js';

/**
 * Orchestrates export and cascading deletion across the in-memory stores so a
 * gate test can prove that deleted content is no longer queryable through any
 * store's read API.
 */
export class InMemoryLifecycleStore implements LifecycleStore {
  constructor(
    private readonly ingestion: InMemoryIngestionStore,
    private readonly workThreads: InMemoryWorkThreadStore,
    private readonly retrieval: InMemoryRetrievalStore,
    private readonly memory: InMemoryMemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  async exportContent(
    context: IngestionRequestContext,
    projectId: string | null,
  ): Promise<ExportContent> {
    const tenantId = context.principal.tenantId;
    if (
      projectId !== null &&
      !this.ingestion.projectExists(tenantId, projectId)
    ) {
      throw new IngestionStoreError(
        'not_found',
        404,
        'The project was not found.',
      );
    }
    const projects = this.ingestion
      .exportProjects(tenantId)
      .filter(
        (project) => projectId === null || project.projectId === projectId,
      );
    return {
      projects,
      workThreads: this.workThreads.exportThreads(tenantId, projectId),
      memories: this.memory.exportMemories(tenantId, projectId),
      events: this.ingestion.exportEvents(tenantId, projectId),
    };
  }

  async deleteProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<DeletionReceipt> {
    const tenantId = context.principal.tenantId;
    if (!this.ingestion.projectExists(tenantId, projectId)) {
      throw new IngestionStoreError(
        'not_found',
        404,
        'The project was not found.',
      );
    }
    return this.purge(context, projectId);
  }

  async deleteAccount(
    context: IngestionRequestContext,
  ): Promise<DeletionReceipt> {
    return this.purge(context, null);
  }

  private purge(
    context: IngestionRequestContext,
    projectId: string | null,
  ): DeletionReceipt {
    const tenantId = context.principal.tenantId;
    const deletedCounts = mergeCounts(
      this.retrieval.purge(tenantId, projectId),
      this.memory.purge(tenantId, projectId),
      this.workThreads.purge(tenantId, projectId),
      this.ingestion.purge(tenantId, projectId),
    );
    return {
      scope: projectId === null ? 'account' : 'project',
      targetId: projectId,
      deletedAt: new Date(this.now()).toISOString(),
      deletedCounts,
      complete: true,
    };
  }
}
