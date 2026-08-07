import type { MemoryCategory, MemoryScopeType } from '@baton/protocol';

export interface ExtractionEvent {
  eventId: string;
  projectId: string;
  workThreadId: string | null;
  role: string;
  text: string;
}

export interface ExtractedCandidate {
  category: MemoryCategory;
  claim: string;
  scopeType: MemoryScopeType;
  evidenceEventIds: string[];
}

/**
 * A managed model that proposes memory candidates from conversation evidence.
 * Implementations must treat every event's text as untrusted data — never as an
 * instruction — and must record their provenance so a candidate can be traced
 * to a provider, model, and prompt version. Extraction only proposes; the
 * deterministic validator and the user decide what becomes memory.
 */
export interface ModelGateway {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
  extract(events: readonly ExtractionEvent[]): Promise<ExtractedCandidate[]>;
}

const preferenceCue =
  /\b(prefer|keep (it|your|the)|always|never|don'?t|do not|avoid|use tabs|use spaces|concise|verbose)\b/i;

/**
 * A dependency-free, deterministic extractor used when the managed-model gateway
 * is disabled. It proposes candidates from explicit user preference statements
 * and merges repeated phrasings across events into one candidate with combined
 * evidence. It never follows instructions found in the text; it only quotes it.
 */
export class DeterministicModelGateway implements ModelGateway {
  readonly provider = 'baton-deterministic';
  readonly model = 'preference-rules-v1';
  readonly promptVersion = '2026-08-06';

  async extract(
    events: readonly ExtractionEvent[],
  ): Promise<ExtractedCandidate[]> {
    const grouped = new Map<string, ExtractedCandidate>();
    for (const event of events) {
      if (event.role !== 'user') continue;
      if (!preferenceCue.test(event.text)) continue;
      const signature = normalize(event.text);
      const existing = grouped.get(signature);
      if (existing === undefined) {
        grouped.set(signature, {
          category: 'communication_preference',
          // The claim quotes the user's own words as data — extraction never
          // rewrites an instruction into an action.
          claim: event.text.trim(),
          scopeType: 'global',
          evidenceEventIds: [event.eventId],
        });
      } else if (!existing.evidenceEventIds.includes(event.eventId)) {
        existing.evidenceEventIds.push(event.eventId);
      }
    }
    return [...grouped.values()];
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
