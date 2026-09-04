import { describe, expect, it } from 'vitest';

import { redactSensitive, safeError, ServiceMetrics } from '../src/index.js';

describe('safe observability', () => {
  it('recursively redacts credentials while retaining useful fields', () => {
    expect(
      redactSensitive({
        requestId: 'request-1',
        authorization: 'Bearer secret',
        nested: { refreshToken: 'bat_rt_private', action: 'login' },
      }),
    ).toEqual({
      requestId: 'request-1',
      authorization: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]', action: 'login' },
    });
  });

  it('redacts bearer and Baton credentials from errors', () => {
    expect(
      safeError(new Error('failed Bearer abc and bat_at_secret')).message,
    ).toBe('failed Bearer [REDACTED] and [REDACTED]');
  });

  it('exports a small Prometheus surface without dimensions', () => {
    const metrics = new ServiceMetrics();
    metrics.observe(503, 12);
    expect(metrics.prometheus()).toContain('baton_http_failures_total 1');
  });
});
