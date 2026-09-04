import type { Memory, MemoryScopeType, SoulDocument } from '@baton/protocol';

// Specific context overrides broad context: a work-thread memory is rendered
// before a global one so a reader resolves conflicts toward the narrower scope.
const scopeOrder: Record<MemoryScopeType, number> = {
  work_thread: 0,
  project: 1,
  organization: 2,
  global: 3,
};

const scopeHeading: Record<MemoryScopeType, string> = {
  work_thread: 'This work thread',
  project: 'This project',
  organization: 'Organization',
  global: 'Always',
};

function estimateTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : Math.max(1, Math.ceil(trimmed.length / 4));
}

/**
 * Render approved memories as a budgeted `SOUL.md`. Memories are grouped by
 * scope (most specific first) and every rendered claim cites the source events
 * it rests on, so a reader can always verify it. Rendering stops when the token
 * budget is reached; nothing unapproved is ever included (the caller passes
 * only approved memories).
 */
export function renderSoul(
  memories: readonly Memory[],
  options: { tokenBudget: number },
): SoulDocument {
  const ordered = [...memories].sort((left, right) => {
    const scope = scopeOrder[left.scope.type] - scopeOrder[right.scope.type];
    if (scope !== 0) return scope;
    if (right.confidence !== left.confidence)
      return right.confidence - left.confidence;
    return left.claim.localeCompare(right.claim);
  });

  const lines = ['# SOUL'];
  const memoryIds: string[] = [];
  let tokenEstimate = estimateTokens('# SOUL');
  let truncated = false;
  let currentScope: MemoryScopeType | null = null;

  for (const memory of ordered) {
    const pieces: string[] = [];
    if (memory.scope.type !== currentScope) {
      pieces.push('', `## ${scopeHeading[memory.scope.type]}`);
    }
    pieces.push(
      `- ${memory.claim} (${memory.category}) — evidence ${memory.evidenceEventIds.join(', ')}`,
    );
    const block = pieces.join('\n');
    const blockTokens = estimateTokens(block);
    if (tokenEstimate + blockTokens > options.tokenBudget) {
      truncated = true;
      continue;
    }
    lines.push(...pieces);
    tokenEstimate += blockTokens;
    memoryIds.push(memory.memoryId);
    currentScope = memory.scope.type;
  }

  return {
    text: lines.join('\n'),
    tokenEstimate,
    memoryIds,
    truncated,
  };
}
