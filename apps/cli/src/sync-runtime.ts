import { access, watch } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ClaudeCodeEventSource,
  CodexEventSource,
  DatabaseSyncOpenCodeProvider,
  OpenCodeEventSource,
} from '@baton/capture';
import type { AgentName } from '@baton/protocol';
import {
  InstallationMap,
  JsonInstallationStore,
  type SourceChangeWatcher,
} from '@baton/sync';

import { CaptureSyncEventSource } from './capture-source.js';

export interface NativeSourceOptions {
  statePath?: string;
  claudeProjectsDirectory?: string;
  codexSessionsDirectory?: string;
  openCodeDatabase?: string;
  homeDirectory?: string;
  xdgConfigHome?: string;
  xdgDataHome?: string;
}

export interface NativeSyncRuntime {
  installations: InstallationMap;
  eventSources: CaptureSyncEventSource[];
  detectedAgents: AgentName[];
  watcher: SourceChangeWatcher;
  paths: {
    state: string;
    claude: string;
    codex: string;
    openCode: string;
  };
}

export async function createNativeSyncRuntime(
  options: NativeSourceOptions = {},
): Promise<NativeSyncRuntime> {
  const home = options.homeDirectory ?? homedir();
  const configHome = options.xdgConfigHome ?? join(home, '.config');
  const dataHome = options.xdgDataHome ?? join(home, '.local', 'share');
  const paths = {
    state:
      options.statePath ?? join(configHome, 'baton', 'installation-map.json'),
    claude:
      options.claudeProjectsDirectory ?? join(home, '.claude', 'projects'),
    codex: options.codexSessionsDirectory ?? join(home, '.codex', 'sessions'),
    openCode:
      options.openCodeDatabase ?? join(dataHome, 'opencode', 'opencode.db'),
  };

  const eventSources = [
    new CaptureSyncEventSource(
      new ClaudeCodeEventSource({ projectsDirectory: paths.claude }),
    ),
    new CaptureSyncEventSource(
      new CodexEventSource({ sessionsDirectory: paths.codex }),
    ),
  ];
  const detectedAgents: AgentName[] = [];
  if (await exists(paths.claude)) detectedAgents.push('claudecode');
  if (await exists(paths.codex)) detectedAgents.push('codex');
  if (await exists(paths.openCode)) {
    eventSources.push(
      new CaptureSyncEventSource(
        new OpenCodeEventSource(
          new DatabaseSyncOpenCodeProvider({ databasePath: paths.openCode }),
        ),
      ),
    );
    detectedAgents.push('opencode');
  }

  return {
    installations: new InstallationMap(new JsonInstallationStore(paths.state)),
    eventSources,
    detectedAgents,
    watcher: new NativeFileWatcher([
      paths.claude,
      paths.codex,
      dirname(paths.openCode),
    ]),
    paths,
  };
}

/** Best-effort low-latency trigger; periodic reconciliation remains canonical. */
export class NativeFileWatcher implements SourceChangeWatcher {
  constructor(
    private readonly paths: string[],
    private readonly settleMs = 300,
  ) {}

  async watch(
    _binding: unknown,
    onSettledChange: () => void,
  ): Promise<{ close(): Promise<void> }> {
    const controllers: AbortController[] = [];
    const tasks: Promise<void>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const path of [...new Set(this.paths)]) {
      if (!(await exists(path))) continue;
      const controller = new AbortController();
      controllers.push(controller);
      tasks.push(
        (async () => {
          try {
            for await (const _event of watch(path, {
              recursive: true,
              signal: controller.signal,
            })) {
              if (timer !== undefined) clearTimeout(timer);
              timer = setTimeout(onSettledChange, this.settleMs);
              timer.unref();
            }
          } catch (error) {
            // Native file notifications are an optimization only. Unsupported
            // recursive watching falls back to periodic reconciliation.
            if (!controller.signal.aborted) onSettledChange();
          }
        })(),
      );
    }
    return {
      close: async () => {
        if (timer !== undefined) clearTimeout(timer);
        for (const controller of controllers) controller.abort();
        await Promise.all(tasks);
      },
    };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
