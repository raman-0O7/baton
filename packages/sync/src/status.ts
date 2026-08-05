import type { ProjectIdentity } from './installation-map.js';

export type SyncStatusState =
  | 'disabled'
  | 'paused'
  | 'initializing'
  | 'watching'
  | 'queued'
  | 'syncing'
  | 'offline'
  | 'action_required'
  | 'error';

export interface SyncStatus {
  projectIdentity: ProjectIdentity;
  displayName: string;
  state: SyncStatusState;
  summary: string;
  nextAction: string | null;
  pendingTriggers: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  errorCode: string | null;
  retryable: boolean | null;
}

export class SyncStatusTracker {
  private readonly statuses = new Map<ProjectIdentity, SyncStatus>();

  set(status: SyncStatus): void {
    this.statuses.set(status.projectIdentity, Object.freeze({ ...status }));
  }

  patch(
    identity: ProjectIdentity,
    patch: Partial<Omit<SyncStatus, 'projectIdentity'>>,
  ): void {
    const current = this.statuses.get(identity);
    if (current === undefined) return;
    this.set({ ...current, ...patch });
  }

  get(identity: ProjectIdentity): SyncStatus | null {
    const status = this.statuses.get(identity);
    return status === undefined ? null : { ...status };
  }

  list(): SyncStatus[] {
    return [...this.statuses.values()]
      .sort((left, right) => left.displayName.localeCompare(right.displayName))
      .map((status) => ({ ...status }));
  }
}

export function initialStatus(input: {
  projectIdentity: ProjectIdentity;
  displayName: string;
  state: 'enabled' | 'paused' | 'disabled';
  baselinePending: boolean;
}): SyncStatus {
  if (input.state === 'disabled') {
    return base(
      input,
      'disabled',
      'Capture is disabled.',
      'Run baton enable and review the current disclosure to capture again.',
    );
  }
  if (input.state === 'paused') {
    return base(
      input,
      'paused',
      'Capture is paused.',
      'Run baton resume when you want collection to continue.',
    );
  }
  if (input.baselinePending) {
    return base(
      input,
      'initializing',
      'Establishing the new-capture baseline; no historical content will upload.',
      null,
    );
  }
  return base(input, 'watching', 'Watching for new conversation events.', null);
}

function base(
  input: { projectIdentity: ProjectIdentity; displayName: string },
  state: SyncStatusState,
  summary: string,
  nextAction: string | null,
): SyncStatus {
  return {
    projectIdentity: input.projectIdentity,
    displayName: input.displayName,
    state,
    summary,
    nextAction,
    pendingTriggers: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    errorCode: null,
    retryable: null,
  };
}
