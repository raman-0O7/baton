import type {
  MemoryReasonCode,
  MemoryScopeType,
  MemoryVerdict,
} from '@baton/protocol';

export interface MemoryEvidenceInput {
  eventId: string;
  projectId: string;
  workThreadId: string | null;
  text: string;
  role?: string;
}

export interface MemoryCandidateInput {
  claim: string;
  scopeType: MemoryScopeType;
  evidence: MemoryEvidenceInput[];
}

export interface MemoryValidation {
  verdict: MemoryVerdict;
  reasonCode: MemoryReasonCode;
  suggestedScopeType: MemoryScopeType | null;
  confidence: number;
}

// Prohibited sensitive categories. Detection runs on the INFERRED claim, so a
// benign event (an insulin appointment) can never be turned into a sensitive
// personal trait (a health condition). Extraction is a personalization aid, not
// a profiler.
const prohibitedPatterns: Array<{ pattern: RegExp; reason: MemoryReasonCode }> =
  [
    {
      pattern:
        /\b(diabet\w*|insulin|cancer|hiv|aids|depress\w*|anxiety|adhd|pregnan\w*|disabilit\w*|asthma|hypertension|medication|prescri\w*|diagnos\w*|disease|disorder|illness|therapy|mental health)\b/i,
      reason: 'sensitive_health_inference_prohibited',
    },
    {
      pattern:
        /\b(republican|democrat|liberal|conservative|left-wing|right-wing|political party|votes? (for|against))\b/i,
      reason: 'sensitive_political_inference_prohibited',
    },
    {
      pattern:
        /\b(christian|muslim|jewish|hindu|buddhist|atheist|religious|church|mosque|synagogue)\b/i,
      reason: 'sensitive_religion_inference_prohibited',
    },
    {
      pattern:
        /\b(gay|lesbian|bisexual|transgender|sexual orientation|ethnicity|\brace\b)\b/i,
      reason: 'sensitive_identity_inference_prohibited',
    },
    {
      pattern: /\b(password|api[\s-]?key|secret|private key|access token)\b/i,
      reason: 'sensitive_credential_prohibited',
    },
  ];

const terseSignal =
  /\b(concise|brief|terse|short|just (the )?commands?|only the commands|no detail|keep it short)\b/i;
const verboseSignal =
  /\b(explain (every|each) step|in detail|detailed|verbose|walk me through|step by step|elaborate)\b/i;

// A single instruction naming a specific file/artifact or qualified with
// "only" is a one-off, not a durable preference.
const narrowSignal =
  /\bonly\b|\b(this|the)\s+(generated\s+)?(file|makefile|dockerfile|readme|[\w-]+\.[a-z0-9]+)\b/i;

/**
 * Screen a claim for prohibited sensitive inference in isolation (no evidence
 * needed). Used both by the full validator and at approval time, so a user
 * cannot edit an approvable candidate's claim into a sensitive assertion and
 * approve it.
 */
export function screenProhibitedClaim(claim: string): MemoryReasonCode | null {
  for (const { pattern, reason } of prohibitedPatterns) {
    if (pattern.test(claim)) return reason;
  }
  return null;
}

function prohibited(claim: string): MemoryReasonCode | null {
  return screenProhibitedClaim(claim);
}

function hasContradiction(evidence: MemoryEvidenceInput[]): boolean {
  const terse = evidence.some((item) => terseSignal.test(item.text));
  const verbose = evidence.some((item) => verboseSignal.test(item.text));
  return terse && verbose;
}

function distinctProjects(evidence: MemoryEvidenceInput[]): number {
  return new Set(evidence.map((item) => item.projectId)).size;
}

/**
 * Deterministic validation of a proposed personal memory. Runs before any human
 * review and independently of the extractor: prohibited sensitive inferences,
 * contradictory contextual evidence, one-off narrow instructions, and
 * over-broad scope are all caught here. The order is fixed so the verdict is
 * reproducible.
 */
export function validateMemoryCandidate(
  input: MemoryCandidateInput,
): MemoryValidation {
  const evidence = input.evidence;

  const prohibitedReason = prohibited(input.claim);
  if (prohibitedReason !== null) {
    return {
      verdict: 'reject',
      reasonCode: prohibitedReason,
      suggestedScopeType: null,
      confidence: 0,
    };
  }

  if (hasContradiction(evidence)) {
    return {
      verdict: 'needs_review',
      reasonCode: 'contradictory_contextual_evidence',
      suggestedScopeType: null,
      confidence: 0.3,
    };
  }

  if (evidence.length === 1 && narrowSignal.test(evidence[0]!.text)) {
    return {
      verdict: 'reject',
      reasonCode: 'one_time_narrow_instruction',
      suggestedScopeType: null,
      confidence: 0,
    };
  }

  const projects = distinctProjects(evidence);
  if (input.scopeType === 'global' && projects <= 1) {
    return {
      verdict: 'reject',
      reasonCode: 'scope_too_broad',
      suggestedScopeType: 'project',
      confidence: 0,
    };
  }

  if (evidence.length < 2) {
    return {
      verdict: 'reject',
      reasonCode: 'one_time_narrow_instruction',
      suggestedScopeType: null,
      confidence: 0,
    };
  }

  const confidence = Math.min(
    0.95,
    Number((0.5 + 0.1 * evidence.length + 0.1 * projects).toFixed(4)),
  );
  return {
    verdict: 'accept',
    reasonCode: 'repeated_explicit_preference',
    suggestedScopeType: input.scopeType,
    confidence,
  };
}
