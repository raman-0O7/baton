import { describe, expect, it } from 'vitest';

import {
  checkQuota,
  isRetentionExpired,
  quotaPlans,
  withinModelBudget,
} from '../src/index.js';

describe('checkQuota', () => {
  it('allows usage under every limit', () => {
    const check = checkQuota(
      { projects: 1, events: 10, chunks: 20, memories: 2, modelCostCents: 100 },
      quotaPlans.beta,
    );
    expect(check.allowed).toBe(true);
    expect(check.exceeded).toEqual([]);
  });

  it('reports each exceeded limit by name', () => {
    const check = checkQuota(
      {
        projects: 3,
        events: 10,
        chunks: 20,
        memories: 2,
        modelCostCents: 0,
      },
      quotaPlans.free,
    );
    // free plan: 3 projects is at the cap, and monthly model cost of 0 is met.
    expect(check.allowed).toBe(false);
    expect(check.exceeded).toEqual(
      expect.arrayContaining(['maxProjects', 'monthlyModelCostCents']),
    );
  });
});

describe('withinModelBudget', () => {
  it('permits a call that fits and rejects one that overruns', () => {
    expect(withinModelBudget(1500, 400, 2000)).toBe(true);
    expect(withinModelBudget(1800, 300, 2000)).toBe(false);
  });
});

describe('isRetentionExpired', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  it('never expires when retention is null', () => {
    expect(
      isRetentionExpired(
        '2020-01-01T00:00:00Z',
        { eventRetentionDays: null },
        now,
      ),
    ).toBe(false);
  });
  it('expires events older than the window', () => {
    expect(
      isRetentionExpired(
        '2026-06-01T00:00:00Z',
        { eventRetentionDays: 30 },
        now,
      ),
    ).toBe(true);
    expect(
      isRetentionExpired(
        '2026-08-01T00:00:00Z',
        { eventRetentionDays: 30 },
        now,
      ),
    ).toBe(false);
  });
});
