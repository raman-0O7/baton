import {
  metrics,
  trace,
  type Counter,
  type Histogram,
} from '@opentelemetry/api';

export const tracer = trace.getTracer('baton');
const meter = metrics.getMeter('baton');

export const requestCounter: Counter = meter.createCounter(
  'baton.http.requests',
  {
    description: 'Completed HTTP requests',
  },
);
export const requestDuration: Histogram = meter.createHistogram(
  'baton.http.duration',
  {
    description: 'HTTP request duration in milliseconds',
    unit: 'ms',
  },
);

export interface HttpRequestObservation {
  finish(statusCode: number, durationMs: number): void;
}

export function beginHttpRequest(
  method: string,
  route: string,
): HttpRequestObservation {
  const span = tracer.startSpan(`${method} ${route}`, {
    attributes: { 'http.request.method': method, 'http.route': route },
  });
  return {
    finish(statusCode, durationMs) {
      const attributes = {
        'http.request.method': method,
        'http.route': route,
        'http.response.status_code': statusCode,
      };
      requestCounter.add(1, attributes);
      requestDuration.record(durationMs, attributes);
      span.setAttributes(attributes);
      if (statusCode >= 500) span.setAttribute('error.type', 'server_error');
      span.end();
    },
  };
}

const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'device_code',
  'devicecode',
  'client_secret',
  'clientsecret',
  'code_verifier',
  'codeverifier',
  'token',
  'secret',
]);

export function redactSensitive(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (Array.isArray(value))
    return value.map((item) => redactSensitive(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sensitiveKeys.has(key.toLowerCase())
        ? '[REDACTED]'
        : redactSensitive(entry, seen),
    ]),
  );
}

export function safeError(error: unknown): { name: string; message: string } {
  if (!(error instanceof Error))
    return { name: 'Error', message: 'Unknown error' };
  return { name: error.name, message: redactMessage(error.message) };
}

export class ServiceMetrics {
  private requests = 0;
  private failures = 0;
  private totalDurationMs = 0;

  observe(statusCode: number, durationMs: number): void {
    this.requests += 1;
    this.totalDurationMs += durationMs;
    if (statusCode >= 500) this.failures += 1;
  }

  prometheus(): string {
    return [
      '# HELP baton_http_requests_total Completed HTTP requests.',
      '# TYPE baton_http_requests_total counter',
      `baton_http_requests_total ${this.requests}`,
      '# HELP baton_http_failures_total Completed HTTP 5xx responses.',
      '# TYPE baton_http_failures_total counter',
      `baton_http_failures_total ${this.failures}`,
      '# HELP baton_http_duration_milliseconds_total Aggregate HTTP response time.',
      '# TYPE baton_http_duration_milliseconds_total counter',
      `baton_http_duration_milliseconds_total ${this.totalDurationMs}`,
      '',
    ].join('\n');
  }
}

export const loggerRedactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  'accessToken',
  'refreshToken',
  'deviceCode',
  'codeVerifier',
  '*.accessToken',
  '*.refreshToken',
  '*.deviceCode',
];

function redactMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/bat_(?:at|rt|bs)_[A-Za-z0-9._~-]+/g, '[REDACTED]');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
