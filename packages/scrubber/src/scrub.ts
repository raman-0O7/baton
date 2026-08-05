export type RedactionType =
  | 'aws-key'
  | 'github-token'
  | 'slack-token'
  | 'pem-block'
  | 'bearer-token'
  | 'generic-api-key'
  | 'connection-string'
  | 'high-entropy';

export interface Redaction {
  type: RedactionType;
  /** UTF-16 offset in the scrubbed JavaScript string. */
  offset: number;
  length: number;
}

export interface ScrubResult {
  value: string;
  redactions: Redaction[];
}

export interface ScrubPolicy {
  disableEntropy?: boolean;
  extraPatterns?: string[];
  entropyThreshold?: number;
}

interface DetectionPattern {
  expression: RegExp;
  type: RedactionType;
  group: number;
}

interface Span {
  start: number;
  end: number;
  type: RedactionType;
}

const defaultEntropyThreshold = 4.5;
const minEntropyToken = 24;

const patterns: DetectionPattern[] = [
  { expression: /\bAKIA[0-9A-Z]{16}\b/dg, type: 'aws-key', group: 0 },
  {
    expression:
      /aws_secret_access_key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{30,})/dgi,
    type: 'aws-key',
    group: 1,
  },
  {
    expression: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/dg,
    type: 'github-token',
    group: 0,
  },
  {
    expression: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/dg,
    type: 'github-token',
    group: 0,
  },
  {
    expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}/dg,
    type: 'slack-token',
    group: 0,
  },
  {
    expression:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----/dgs,
    type: 'pem-block',
    group: 0,
  },
  {
    expression: /\bbearer\s+([A-Za-z0-9._~+/=-]{20,})/dgi,
    type: 'bearer-token',
    group: 1,
  },
  {
    expression:
      /\b(api[_-]?key|apikey|access[_-]?key|secret|client[_-]?secret|token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']?([^\s"',;]{16,})/dgi,
    type: 'generic-api-key',
    group: 2,
  },
  {
    expression: /\bsk-[A-Za-z0-9_-]{20,}\b/dg,
    type: 'generic-api-key',
    group: 0,
  },
  {
    expression: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:([^@\s/]{4,})@/dgi,
    type: 'connection-string',
    group: 1,
  },
];

const entropyExclusions = [
  /^[0-9a-f]{40}$/,
  /^[0-9a-f]{64}$/,
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
];

export function scrub(value: string, policy: ScrubPolicy = {}): ScrubResult {
  let spans: Span[] = [];
  for (const pattern of patterns) {
    spans.push(...patternSpans(value, pattern));
  }

  for (const expression of policy.extraPatterns ?? []) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(expression, 'gd');
    } catch (error) {
      throw new TypeError(
        `scrubber: invalid extra pattern ${JSON.stringify(expression)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    spans.push(
      ...patternSpans(value, {
        expression: compiled,
        type: 'generic-api-key',
        group: 0,
      }),
    );
  }
  spans = resolveOverlaps(spans);

  if (policy.disableEntropy !== true) {
    const threshold =
      policy.entropyThreshold !== undefined && policy.entropyThreshold > 0
        ? policy.entropyThreshold
        : defaultEntropyThreshold;
    spans.push(...entropySpans(value, spans, threshold));
    spans = resolveOverlaps(spans);
  }

  if (spans.length === 0) return { value, redactions: [] };

  let output = '';
  let previous = 0;
  const redactions: Redaction[] = [];
  for (const span of spans) {
    output += value.slice(previous, span.start);
    const marker = `[REDACTED:${span.type}]`;
    redactions.push({
      type: span.type,
      offset: output.length,
      length: marker.length,
    });
    output += marker;
    previous = span.end;
  }
  output += value.slice(previous);
  return { value: output, redactions };
}

function patternSpans(value: string, pattern: DetectionPattern): Span[] {
  const spans: Span[] = [];
  pattern.expression.lastIndex = 0;
  for (const match of value.matchAll(pattern.expression)) {
    const indices = match.indices?.[pattern.group];
    if (indices === undefined) continue;
    spans.push({ start: indices[0], end: indices[1], type: pattern.type });
  }
  return spans;
}

function resolveOverlaps(spans: Span[]): Span[] {
  if (spans.length < 2) return spans;
  const sorted = [...spans].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const result: Span[] = [];
  for (const span of sorted) {
    const prior = result.at(-1);
    if (prior !== undefined && span.start < prior.end) continue;
    result.push(span);
  }
  return result;
}

function entropySpans(
  value: string,
  covered: Span[],
  threshold: number,
): Span[] {
  const spans: Span[] = [];
  let index = 0;
  while (index < value.length) {
    if (!isTokenCharacter(value[index]!)) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < value.length && isTokenCharacter(value[end]!)) end += 1;
    const token = value.slice(index, end);
    if (
      token.length >= minEntropyToken &&
      !covered.some((span) => index < span.end && span.start < end) &&
      !entropyExclusions.some((expression) => expression.test(token)) &&
      countCharacter(token, '/') < 2 &&
      characterClassMix(token) >= 2 &&
      shannonEntropy(token) >= threshold
    ) {
      spans.push({ start: index, end, type: 'high-entropy' });
    }
    index = end;
  }
  return spans;
}

function isTokenCharacter(character: string): boolean {
  return /^[A-Za-z0-9+/=_-]$/.test(character);
}

function countCharacter(value: string, expected: string): number {
  let count = 0;
  for (const character of value) if (character === expected) count += 1;
  return count;
}

function characterClassMix(value: string): number {
  return (
    Number(/[a-z]/.test(value)) +
    Number(/[A-Z]/.test(value)) +
    Number(/[0-9]/.test(value))
  );
}

function shannonEntropy(value: string): number {
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}
