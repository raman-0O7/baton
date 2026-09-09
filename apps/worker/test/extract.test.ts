import type {
  CollectExtractionOptions,
  ExtractionSourceEvent,
  MemoryProposeInput,
  TenantExtractionWork,
} from '@baton/database';
import type { ExtractedCandidate, ModelGateway } from '@baton/memory';
import { describe, expect, it, vi } from 'vitest';

import {
  runMemoryExtraction,
  type CandidateSink,
  type ExtractionWorkSource,
} from '../src/extract.js';

const options: CollectExtractionOptions = {
  windowPerProject: 200,
  maxProjectsPerRun: 100,
};

function event(id: string): ExtractionSourceEvent {
  return {
    eventId: id,
    projectId: 'p1',
    workThreadId: null,
    role: 'user',
    text: `message ${id}`,
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    ingestedAt: new Date('2026-01-01T00:05:00.000Z'),
  };
}

function gatewayReturning(candidates: ExtractedCandidate[]): ModelGateway {
  return {
    provider: 'anthropic',
    model: 'claude-opus-5',
    promptVersion: 'v-test',
    extract: vi.fn(async () => candidates),
  };
}

function silentLog(): (m: string, f?: Record<string, unknown>) => void {
  return () => {};
}

describe('runMemoryExtraction', () => {
  it('proposes candidates with project scope, built evidence, and gateway provenance', async () => {
    const cursor = new Date('2026-01-01T00:05:00.000Z');
    const source: ExtractionWorkSource = {
      listTenantIds: async () => ['t1'],
      collectWork: async (): Promise<TenantExtractionWork> => ({
        windows: [{ projectId: 'p1', events: [event('e1'), event('e2')] }],
        newestIngestedAt: cursor,
      }),
      advanceCursor: vi.fn(async () => {}),
    };
    const proposeCandidate = vi.fn(async () => ({ status: 'proposed' }));
    const sink: CandidateSink = { proposeCandidate };

    const summary = await runMemoryExtraction({
      source,
      sink,
      gateway: gatewayReturning([
        {
          category: 'engineering_workflow',
          claim: 'Uses tabs',
          scopeType: 'project',
          evidenceEventIds: ['e1', 'e2'],
        },
      ]),
      options,
      log: silentLog(),
    });

    expect(proposeCandidate).toHaveBeenCalledTimes(1);
    const input = proposeCandidate.mock.calls[0]![1] as MemoryProposeInput;
    expect(input.scope).toEqual({ type: 'project', id: 'p1' });
    expect(input.evidence.map((item) => item.eventId)).toEqual(['e1', 'e2']);
    expect(input.evidence[0]!.text).toBe('message e1');
    expect(input.provenance).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      promptVersion: 'v-test',
    });
    expect(source.advanceCursor).toHaveBeenCalledWith('t1', cursor);
    expect(summary).toMatchObject({
      tenants: 1,
      tenantsWithWork: 1,
      projectsProcessed: 1,
      candidatesProposed: 1,
      candidatesAccepted: 1,
    });
  });

  it('skips a candidate whose evidence does not resolve to two window events', async () => {
    const proposeCandidate = vi.fn(async () => ({ status: 'proposed' }));
    const source: ExtractionWorkSource = {
      listTenantIds: async () => ['t1'],
      collectWork: async () => ({
        windows: [{ projectId: 'p1', events: [event('e1'), event('e2')] }],
        newestIngestedAt: new Date(),
      }),
      advanceCursor: async () => {},
    };
    await runMemoryExtraction({
      source,
      sink: { proposeCandidate },
      gateway: gatewayReturning([
        {
          category: 'tooling_preference',
          claim: 'Only one real event',
          scopeType: 'project',
          evidenceEventIds: ['e1', 'ghost'],
        },
      ]),
      options,
      log: silentLog(),
    });
    expect(proposeCandidate).not.toHaveBeenCalled();
  });

  it('does not advance the cursor for a tenant with no new work', async () => {
    const advanceCursor = vi.fn(async () => {});
    await runMemoryExtraction({
      source: {
        listTenantIds: async () => ['t1'],
        collectWork: async () => ({ windows: [], newestIngestedAt: null }),
        advanceCursor,
      },
      sink: { proposeCandidate: vi.fn(async () => ({ status: 'proposed' })) },
      gateway: gatewayReturning([]),
      options,
      log: silentLog(),
    });
    expect(advanceCursor).not.toHaveBeenCalled();
  });

  it('isolates a failing tenant so others still run', async () => {
    const advanceCursor = vi.fn(async () => {});
    const proposeCandidate = vi.fn(async () => ({ status: 'proposed' }));
    const source: ExtractionWorkSource = {
      listTenantIds: async () => ['bad', 'good'],
      collectWork: async (tenantId) => {
        if (tenantId === 'bad') throw new Error('boom');
        return {
          windows: [{ projectId: 'p1', events: [event('e1'), event('e2')] }],
          newestIngestedAt: new Date(),
        };
      },
      advanceCursor,
    };
    const summary = await runMemoryExtraction({
      source,
      sink: { proposeCandidate },
      gateway: gatewayReturning([
        {
          category: 'process_preference',
          claim: 'Runs tests before commit',
          scopeType: 'project',
          evidenceEventIds: ['e1', 'e2'],
        },
      ]),
      options,
      log: silentLog(),
    });
    expect(proposeCandidate).toHaveBeenCalledTimes(1);
    expect(advanceCursor).toHaveBeenCalledTimes(1);
    expect(summary.tenantsWithWork).toBe(1);
  });

  it('counts a proposal that only needs review as proposed but not accepted', async () => {
    const summary = await runMemoryExtraction({
      source: {
        listTenantIds: async () => ['t1'],
        collectWork: async () => ({
          windows: [{ projectId: 'p1', events: [event('e1'), event('e2')] }],
          newestIngestedAt: new Date(),
        }),
        advanceCursor: async () => {},
      },
      sink: { proposeCandidate: async () => ({ status: 'needs_review' }) },
      gateway: gatewayReturning([
        {
          category: 'communication_preference',
          claim: 'Sometimes terse, sometimes verbose',
          scopeType: 'project',
          evidenceEventIds: ['e1', 'e2'],
        },
      ]),
      options,
      log: silentLog(),
    });
    expect(summary.candidatesProposed).toBe(1);
    expect(summary.candidatesAccepted).toBe(0);
  });
});
