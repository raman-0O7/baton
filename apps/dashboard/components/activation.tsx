'use client';

import { useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { Frame } from './frame';
import { SignInButtons } from './sign-in';

const apiUrl = (
  process.env.NEXT_PUBLIC_BATON_API_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

export function Activation() {
  const search = useSearchParams();
  const [code, setCode] = useState(search.get('user_code') ?? '');
  const [status, setStatus] = useState<
    'idle' | 'sending' | 'approved' | 'signed-out' | 'error'
  >('idle');
  const [deviceName, setDeviceName] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus('sending');
    try {
      const response = await fetch(`${apiUrl}/v1/auth/device/approve`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ userCode: code.trim().toUpperCase() }),
      });
      if (response.status === 401) {
        setStatus('signed-out');
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      const result = (await response.json()) as { deviceName: string };
      setDeviceName(result.deviceName);
      setStatus('approved');
    } catch {
      setStatus('error');
    }
  }

  const returnTo = `/activate${code.length === 0 ? '' : `?user_code=${encodeURIComponent(code)}`}`;

  return (
    <Frame folio="DEVICE PASSAGE">
      <section className="activation reveal">
        <div className="activation-copy">
          <p className="eyebrow">CLI authorization</p>
          <h1>Pass the baton.</h1>
          <p>
            Confirm the code shown in your terminal. This grants only that
            machine its own revocable route into your workspace.
          </p>
        </div>
        <div className="code-panel">
          {status === 'approved' ? (
            <div className="approval-state" role="status">
              <span className="approval-tick">✓</span>
              <p className="eyebrow">Route opened</p>
              <h2>{deviceName}</h2>
              <p>You can close this page and return to your terminal.</p>
            </div>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <label htmlFor="user-code">Terminal code</label>
              <input
                id="user-code"
                name="user-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ABCD-EFGH"
                autoCapitalize="characters"
                autoComplete="one-time-code"
                minLength={6}
                maxLength={32}
                required
              />
              <button
                className="orange-button full"
                type="submit"
                disabled={status === 'sending'}
              >
                {status === 'sending'
                  ? 'Opening route…'
                  : 'Approve this device'}
              </button>
              {status === 'signed-out' ? (
                <p className="form-message">
                  Sign in first.{' '}
                  <SignInButtons
                    returnTo={returnTo}
                    fallbackLabel="Continue to login"
                  />
                </p>
              ) : null}
              {status === 'error' ? (
                <p className="form-message error">
                  That code is invalid, expired, or already used.
                </p>
              ) : null}
            </form>
          )}
          <p className="code-footnote">
            <strong>One code. One machine.</strong> Baton never shares this
            authorization with another device.
          </p>
        </div>
      </section>
    </Frame>
  );
}
