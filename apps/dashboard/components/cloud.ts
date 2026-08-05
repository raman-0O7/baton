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

export function loginHref(returnTo: string): string {
  return `${apiUrl}/v1/auth/web/login?returnTo=${encodeURIComponent(returnTo)}`;
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
