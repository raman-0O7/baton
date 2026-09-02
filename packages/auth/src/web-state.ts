import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebLoginState {
  state: string;
  codeVerifier: string;
  returnTo: string;
  /** Which identity provider issued this login (e.g. 'google', 'github'). */
  provider: string;
  expiresAt: number;
}

export function encodeWebLoginState(
  value: WebLoginState,
  secret: string,
): string {
  if (secret.length < 32)
    throw new TypeError('web login state secret is too short');
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeWebLoginState(
  encoded: string,
  secret: string,
  now = Date.now(),
): WebLoginState | null {
  const separator = encoded.lastIndexOf('.');
  if (separator === -1) return null;
  const payload = encoded.slice(0, separator);
  const signature = encoded.slice(separator + 1);
  const expected = sign(payload, secret);
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    if (
      !isRecord(value) ||
      typeof value.state !== 'string' ||
      typeof value.codeVerifier !== 'string' ||
      typeof value.returnTo !== 'string' ||
      typeof value.provider !== 'string' ||
      typeof value.expiresAt !== 'number' ||
      value.expiresAt <= now
    ) {
      return null;
    }
    return value as unknown as WebLoginState;
  } catch {
    return null;
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
