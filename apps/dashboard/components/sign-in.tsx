'use client';

import { useEffect, useState } from 'react';

import { fetchProviders, loginHref } from './cloud';

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Continue with Google',
  github: 'Continue with GitHub',
};

/**
 * Renders one sign-in button per social provider the API has configured. Falls
 * back to a single generic login link when none are reported (e.g. a plain
 * OIDC deployment or local dev-login).
 */
export function SignInButtons({
  returnTo,
  fallbackLabel = 'Sign in to Baton',
}: {
  returnTo: string;
  fallbackLabel?: string;
}) {
  const [providers, setProviders] = useState<string[] | null>(null);

  useEffect(() => {
    let active = true;
    void fetchProviders().then((list) => {
      if (active) setProviders(list);
    });
    return () => {
      active = false;
    };
  }, []);

  if (providers === null) {
    return <span className="form-message">Loading sign-in options…</span>;
  }

  if (providers.length === 0) {
    return (
      <a className="orange-button" href={loginHref(returnTo)}>
        {fallbackLabel}
      </a>
    );
  }

  return (
    <span className="sign-in-buttons">
      {providers.map((provider) => (
        <a
          key={provider}
          className="orange-button"
          href={loginHref(returnTo, provider)}
        >
          {PROVIDER_LABELS[provider] ?? `Continue with ${provider}`}
        </a>
      ))}
    </span>
  );
}
