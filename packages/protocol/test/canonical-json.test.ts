import { describe, expect, it } from 'vitest';

import {
  SourceEventSchema,
  canonicalJson,
  canonicalJsonSha256,
  createSourceEvent,
} from '../src/index.js';

const sessionId = '018f0f90-2222-7222-8222-222222222222';

function eventInput() {
  return {
    sourceSessionId: sessionId,
    workThreadId: null,
    sourceAgent: 'codex' as const,
    sourceDeviceId: '018f0f90-1111-7111-8111-111111111111',
    nativeSequence: 7,
    parentEventId: null,
    occurredAt: '2026-07-29T00:00:00.000Z',
    observedAt: '2026-07-29T00:00:01.000Z',
    schemaVersion: 1 as const,
    payload: {
      kind: 'message' as const,
      role: 'assistant' as const,
      text: 'Use café, 雪, and 👩🏽‍💻 without normalization.',
    },
  };
}

describe('canonicalJson', () => {
  it('sorts nested object keys while preserving array order', () => {
    const first = {
      z: [{ beta: 2, alpha: 1 }, 'last'],
      a: { snow: '雪', cafe: 'café' },
    };
    const second = {
      a: { cafe: 'café', snow: '雪' },
      z: [{ alpha: 1, beta: 2 }, 'last'],
    };

    expect(canonicalJson(first)).toBe(
      '{"a":{"cafe":"café","snow":"雪"},"z":[{"alpha":1,"beta":2},"last"]}',
    );
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
  });

  it('preserves Unicode code points instead of applying normalization', () => {
    const composed = canonicalJson({ text: 'é' });
    const decomposed = canonicalJson({ text: 'e\u0301' });

    expect(composed).toBe('{"text":"é"}');
    expect(decomposed).toBe('{"text":"é"}');
    expect(canonicalJsonSha256({ text: 'é' })).not.toBe(
      canonicalJsonSha256({ text: 'e\u0301' }),
    );
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n])(
    'rejects a value JSON would omit or coerce: %s',
    (value) => {
      expect(() => canonicalJson({ value })).toThrow(TypeError);
    },
  );

  it('rejects cycles and non-plain objects', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
    expect(() => canonicalJson(new Date())).toThrow(/non-plain/);
  });

  it('rejects sparse arrays instead of emitting invalid JSON', () => {
    const sparse = new Array<string>(2);
    sparse[1] = 'present';

    expect(() => canonicalJson(sparse)).toThrow(/sparse array element/);
  });
});

describe('source event identity', () => {
  it('creates deterministic integrity and idempotency fields', () => {
    const first = createSourceEvent(eventInput());
    const observedElsewhere = createSourceEvent({
      ...eventInput(),
      sourceDeviceId: '018f0f90-8888-7888-8888-888888888888',
      observedAt: '2026-07-29T00:05:00.000Z',
      workThreadId: '018f0f90-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      parentEventId: '018f0f90-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
    });

    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.idempotencyKey).toMatch(/^evt:v1:[a-f0-9]{64}$/);
    expect(first.eventId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(observedElsewhere.contentHash).toBe(first.contentHash);
    expect(observedElsewhere.idempotencyKey).toBe(first.idempotencyKey);
    expect(observedElsewhere.eventId).toBe(first.eventId);
  });

  it('changes both identities when normalized content changes', () => {
    const first = createSourceEvent(eventInput());
    const changed = createSourceEvent({
      ...eventInput(),
      payload: { ...eventInput().payload, text: 'Different content' },
    });

    expect(changed.contentHash).not.toBe(first.contentHash);
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('rejects unknown source input and forged integrity fields', () => {
    const unknownInput: unknown = {
      ...eventInput(),
      raw: 'native transcript',
    };
    expect(() =>
      createSourceEvent(
        unknownInput as Parameters<typeof createSourceEvent>[0],
      ),
    ).toThrow();

    const event = createSourceEvent(eventInput());
    expect(
      SourceEventSchema.safeParse({
        ...event,
        contentHash: 'a'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      SourceEventSchema.safeParse({
        ...event,
        eventId: '018f0f90-9999-8999-8999-999999999999',
      }).success,
    ).toBe(false);
  });
});
