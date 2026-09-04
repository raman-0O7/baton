export const apiUrl = (
  process.env.NEXT_PUBLIC_BATON_API_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

export function cloudFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: { accept: 'application/json', ...init?.headers },
  });
}

export function loginHref(returnTo: string, provider?: string): string {
  const path =
    provider === undefined
      ? '/v1/auth/web/login'
      : `/v1/auth/web/login/${provider}`;
  return `${apiUrl}${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Named social login providers the API has configured (e.g. google, github). */
export async function fetchProviders(): Promise<string[]> {
  try {
    const response = await cloudFetch('/v1/auth/providers');
    if (!response.ok) return [];
    const body: unknown = await response.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      Array.isArray((body as { providers?: unknown }).providers)
    ) {
      return (body as { providers: unknown[] }).providers.filter(
        (value): value is string => typeof value === 'string',
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function relativeTime(iso: string): string {
  const deltaMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(deltaMs)) return 'recently';
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
