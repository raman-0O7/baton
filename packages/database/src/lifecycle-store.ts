import type {
  DeletionReceipt,
  Memory,
  Project,
  SourceEvent,
  WorkThread,
} from '@baton/protocol';

import type { IngestionRequestContext } from './ingestion-store.js';

export interface ExportContent {
  projects: Project[];
  workThreads: WorkThread[];
  memories: Memory[];
  events: SourceEvent[];
}

export interface LifecycleStore {
  /** Read the caller's own content for export (whole account, or one project). */
  exportContent(
    context: IngestionRequestContext,
    projectId: string | null,
  ): Promise<ExportContent>;
  /**
   * Delete a project across every store — events, sessions, checkpoints, work
   * threads, chunks, and project-scoped memories — returning a receipt with
   * per-collection counts so completion is observable and provable.
   */
  deleteProject(
    context: IngestionRequestContext,
    projectId: string,
  ): Promise<DeletionReceipt>;
  /** Delete all of the caller's content across every store. */
  deleteAccount(context: IngestionRequestContext): Promise<DeletionReceipt>;
}

export function mergeCounts(
  ...parts: Array<Record<string, number>>
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const part of parts) {
    for (const [key, value] of Object.entries(part)) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return merged;
}
