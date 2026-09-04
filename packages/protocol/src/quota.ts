import { z } from 'zod';

/**
 * Per-account quotas and model-cost budgets. These bound cost and abuse for a
 * paid beta; enforcement is deterministic so a user can see exactly which limit
 * they hit. The deterministic capture and retrieval paths keep working when a
 * cost budget is exhausted — only optional managed-model features degrade.
 */
export interface QuotaLimits {
  maxProjects: number;
  maxEvents: number;
  maxChunks: number;
  maxMemories: number;
  monthlyModelCostCents: number;
}

export const quotaPlans = {
  free: {
    maxProjects: 3,
    maxEvents: 50_000,
    maxChunks: 100_000,
    maxMemories: 200,
    monthlyModelCostCents: 0,
  },
  beta: {
    maxProjects: 25,
    maxEvents: 1_000_000,
    maxChunks: 2_000_000,
    maxMemories: 5_000,
    monthlyModelCostCents: 2_000,
  },
} as const satisfies Record<string, QuotaLimits>;

export type QuotaPlanName = keyof typeof quotaPlans;

export const QuotaPlanNameSchema = z.enum(['free', 'beta']);

export interface QuotaUsage {
  projects: number;
  events: number;
  chunks: number;
  memories: number;
  modelCostCents: number;
}

export interface QuotaCheck {
  allowed: boolean;
  exceeded: Array<keyof QuotaLimits>;
}

/**
 * Report which limits the usage meets or exceeds. A limit of 0 means the
 * feature is unavailable on the plan (e.g. managed-model cost on free).
 */
export function checkQuota(usage: QuotaUsage, limits: QuotaLimits): QuotaCheck {
  const exceeded: Array<keyof QuotaLimits> = [];
  if (usage.projects >= limits.maxProjects) exceeded.push('maxProjects');
  if (usage.events >= limits.maxEvents) exceeded.push('maxEvents');
  if (usage.chunks >= limits.maxChunks) exceeded.push('maxChunks');
  if (usage.memories >= limits.maxMemories) exceeded.push('maxMemories');
  if (usage.modelCostCents >= limits.monthlyModelCostCents) {
    exceeded.push('monthlyModelCostCents');
  }
  return { allowed: exceeded.length === 0, exceeded };
}

/**
 * Whether a managed-model call costing `addCents` fits inside the remaining
 * monthly budget. Returns false when the budget would be exceeded, so the
 * caller can fall back to the deterministic path.
 */
export function withinModelBudget(
  spentCents: number,
  addCents: number,
  limitCents: number,
): boolean {
  return spentCents + addCents <= limitCents;
}

export interface RetentionPolicy {
  /** Days to keep events before an expiry sweep; null keeps them indefinitely. */
  eventRetentionDays: number | null;
}

export const defaultRetentionPolicy: RetentionPolicy = {
  eventRetentionDays: null,
};

/**
 * Whether an event has aged past a retention window. Deterministic given the
 * clock; a retention of null never expires.
 */
export function isRetentionExpired(
  occurredAtIso: string,
  policy: RetentionPolicy,
  nowMs: number,
): boolean {
  if (policy.eventRetentionDays === null) return false;
  const ageMs = nowMs - Date.parse(occurredAtIso);
  return ageMs > policy.eventRetentionDays * 24 * 60 * 60 * 1000;
}
