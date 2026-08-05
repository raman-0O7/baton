import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

const userCodeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface OpaqueToken {
  id: string;
  secret: string;
  value: string;
}

export function createOpaqueToken(prefix: string): OpaqueToken {
  const id = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, value: `${prefix}_${id}.${secret}` };
}

export function parseOpaqueToken(
  value: string,
  prefix: string,
): { id: string; secret: string } | null {
  const expectedPrefix = `${prefix}_`;
  if (!value.startsWith(expectedPrefix)) return null;
  const separator = value.indexOf('.', expectedPrefix.length);
  if (separator === -1) return null;
  const id = value.slice(expectedPrefix.length, separator);
  const secret = value.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || secret.length < 32) return null;
  return { id, secret };
}

export function hashToken(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function tokenHashMatches(
  expectedHex: string,
  presentedHex: string,
): boolean {
  if (expectedHex.length !== presentedHex.length) return false;
  return timingSafeEqual(
    Buffer.from(expectedHex, 'hex'),
    Buffer.from(presentedHex, 'hex'),
  );
}

export function createDeviceCode(): string {
  return `bat_dc_${randomBytes(32).toString('base64url')}`;
}

export function createUserCode(): string {
  let raw = '';
  const bytes = randomBytes(8);
  for (const byte of bytes)
    raw += userCodeAlphabet[byte % userCodeAlphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(value: string): string {
  const compact = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return compact.length === 8
    ? `${compact.slice(0, 4)}-${compact.slice(4)}`
    : value;
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
