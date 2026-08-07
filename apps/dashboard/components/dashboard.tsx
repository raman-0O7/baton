'use client';

import type { Account, Device } from '@baton/protocol';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { Frame, LoadingLedger } from './frame';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; account: Account; devices: Device[] };

const apiUrl = (
  process.env.NEXT_PUBLIC_BATON_API_URL ?? 'http://localhost:4000'
).replace(/\/$/, '');

export function Dashboard() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [accountResponse, devicesResponse] = await Promise.all([
        cloudFetch('/v1/account'),
        cloudFetch('/v1/devices'),
      ]);
      if (accountResponse.status === 401 || devicesResponse.status === 401) {
        setState({ kind: 'signed-out' });
        return;
      }
      if (!accountResponse.ok || !devicesResponse.ok) {
        setState({
          kind: 'error',
          message: 'The ledger could not be opened. Try again shortly.',
        });
        return;
      }
      const account = (await accountResponse.json()) as Account;
      const body = (await devicesResponse.json()) as { devices: Device[] };
      setState({ kind: 'ready', account, devices: body.devices });
    } catch {
      setState({
        kind: 'error',
        message: 'Baton Cloud is unreachable. Check your connection.',
      });
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function revoke(deviceId: string) {
    setRevoking(deviceId);
    const response = await cloudFetch(
      `/v1/devices/${encodeURIComponent(deviceId)}`,
      {
        method: 'DELETE',
      },
    ).catch(() => null);
    if (response?.ok) await load();
    else
      setState({ kind: 'error', message: 'That device could not be revoked.' });
    setRevoking(null);
  }

  async function signOut() {
    const response = await cloudFetch('/v1/auth/logout', {
      method: 'POST',
    }).catch(() => null);
    if (response?.ok) setState({ kind: 'signed-out' });
    else
      setState({ kind: 'error', message: 'Sign out could not be completed.' });
  }

  if (state.kind === 'loading') {
    return (
      <Frame folio="ACCOUNT">
        <LoadingLedger />
      </Frame>
    );
  }

  if (state.kind === 'signed-out') return <SignedOut />;

  if (state.kind === 'error') {
    return (
      <Frame folio="INTERRUPTED">
        <section className="notice-panel">
          <p className="eyebrow">Connection interrupted</p>
          <h1>The thread went quiet.</h1>
          <p>{state.message}</p>
          <button
            className="ink-button"
            type="button"
            onClick={() => void load()}
          >
            Try again
          </button>
        </section>
      </Frame>
    );
  }

  const activeDevices = state.devices.filter(
    (device) => device.revokedAt === null,
  );
  return (
    <Frame folio="ACCOUNT">
      <section className="account-hero reveal">
        <div>
          <p className="eyebrow">Account ledger</p>
          <h1>
            Good to see you,
            <br />
            <em>{firstName(state.account.displayName)}.</em>
          </h1>
        </div>
        <div
          className="identity-stamp"
          aria-label={`Signed in as ${state.account.email}`}
        >
          <span>VERIFIED</span>
          <strong>{state.account.email}</strong>
          <small>Tenant {shortId(state.account.tenantId)}</small>
          <Link className="text-link" href="/work">
            View active work <span>↗</span>
          </Link>
          <Link className="text-link" href="/memory">
            Review memory <span>↗</span>
          </Link>
          <button type="button" onClick={() => void signOut()}>
            Sign out →
          </button>
        </div>
      </section>

      <section
        className="registry reveal delay-one"
        aria-labelledby="devices-heading"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              Device registry / {String(activeDevices.length).padStart(2, '0')}
            </p>
            <h2 id="devices-heading">Where your memory can travel</h2>
          </div>
          <Link className="text-link" href="/activate">
            Connect a device <span>↗</span>
          </Link>
        </div>

        <div className="device-list">
          {state.devices.length === 0 ? (
            <p className="empty-note">No CLI devices are connected yet.</p>
          ) : (
            state.devices.map((device, index) => (
              <article
                className={`device-row ${device.revokedAt === null ? '' : 'is-revoked'}`}
                key={device.deviceId}
              >
                <p className="device-index">
                  {String(index + 1).padStart(2, '0')}
                </p>
                <div className="device-main">
                  <div className="device-title">
                    <h3>{device.name}</h3>
                    {device.deviceId === state.account.currentDeviceId ? (
                      <span className="current-tag">THIS DEVICE</span>
                    ) : null}
                  </div>
                  <p>
                    {device.platform} · Baton {device.clientVersion}
                  </p>
                </div>
                <div className="device-seen">
                  <span>
                    {device.revokedAt === null ? 'LAST SIGNAL' : 'REVOKED'}
                  </span>
                  <strong>
                    {formatDate(device.revokedAt ?? device.lastSeenAt)}
                  </strong>
                </div>
                {device.revokedAt === null ? (
                  <button
                    className="revoke-button"
                    type="button"
                    disabled={revoking === device.deviceId}
                    onClick={() => void revoke(device.deviceId)}
                  >
                    {revoking === device.deviceId ? 'Revoking…' : 'Revoke'}
                  </button>
                ) : (
                  <span className="closed-mark">CLOSED</span>
                )}
              </article>
            ))
          )}
        </div>
      </section>

      <aside className="privacy-note reveal delay-two">
        <span className="privacy-number">01</span>
        <div>
          <p className="eyebrow">The compact</p>
          <h2>Access is visible. Revocation is immediate.</h2>
        </div>
        <p>
          Every connected machine gets its own rotating credential. Closing one
          route leaves your other devices uninterrupted.
        </p>
      </aside>
    </Frame>
  );
}

function SignedOut() {
  const loginUrl = `${apiUrl}/v1/auth/web/login?returnTo=${encodeURIComponent('/')}`;
  return (
    <Frame folio="WELCOME">
      <section className="welcome reveal">
        <p className="eyebrow">One memory / every agent</p>
        <h1>
          Carry the thread
          <br />
          <em>without carrying everything.</em>
        </h1>
        <p className="welcome-copy">
          Baton keeps your working context available across devices and agents,
          while you decide what gets connected.
        </p>
        <a className="orange-button" href={loginUrl}>
          Enter your workspace <span>→</span>
        </a>
        <div className="welcome-proof">
          <span>01 / SIGN IN</span>
          <span>02 / CONNECT CLI</span>
          <span>03 / KEEP MOVING</span>
        </div>
      </section>
    </Frame>
  );
}

function cloudFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: { accept: 'application/json', ...init?.headers },
  });
}

function firstName(name: string): string {
  return name.trim().split(/\s+/, 1)[0] ?? name;
}

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
    .format(new Date(value))
    .toUpperCase();
}
