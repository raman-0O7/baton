export * from './claudecode.js';
export * from './codex.js';
export * from './materialize.js';
export * from './opencode.js';
export * from './types.js';

import type { AgentName } from '@baton/protocol';

import { ClaudeCodeAdapter } from './claudecode.js';
import { CodexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';
import type { IncrementalAdapter } from './types.js';

const adapters: Readonly<Record<AgentName, IncrementalAdapter>> = {
  claudecode: new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  opencode: new OpenCodeAdapter(),
};

export function adapterFor(agent: AgentName): IncrementalAdapter {
  return adapters[agent];
}
