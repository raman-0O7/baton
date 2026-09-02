'use client';

import type { Account } from '@baton/protocol';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { cloudFetch } from './cloud';
import { SignInButtons } from './sign-in';
import { Frame, LoadingLedger } from './frame';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; account: Account }
  | { kind: 'deleted' };

export function Privacy() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(async () => {
    const response = await cloudFetch('/v1/account').catch(() => null);
    if (response === null) {
      setState({ kind: 'error', message: 'Baton Cloud is unreachable.' });
      return;
    }
    if (response.status === 401) {
      setState({ kind: 'signed-out' });
      return;
    }
    if (!response.ok) {
      setState({
        kind: 'error',
        message: 'Your settings could not be opened.',
      });
      return;
    }
    setState({ kind: 'ready', account: (await response.json()) as Account });
  }, []);

  useEffect(() => void load(), [load]);

  async function exportData() {
    setBusy(true);
    const response = await cloudFetch('/v1/account/export').catch(() => null);
    setBusy(false);
    if (!response?.ok) {
      setState({ kind: 'error', message: 'Export could not be prepared.' });
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'baton-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function deleteAccount() {
    setBusy(true);
    const response = await cloudFetch('/v1/account/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
    setBusy(false);
    if (response?.ok) setState({ kind: 'deleted' });
    else
      setState({ kind: 'error', message: 'Your data could not be deleted.' });
  }

  if (state.kind === 'loading') {
    return (
      <Frame folio="PRIVACY">
        <LoadingLedger />
      </Frame>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <Frame folio="PRIVACY">
        <section className="notice-panel reveal">
          <p className="eyebrow">Signed out</p>
          <h1>
            Your <em>data</em>, your call.
          </h1>
          <p>
            <SignInButtons returnTo="/privacy" />
          </p>
        </section>
      </Frame>
    );
  }
  if (state.kind === 'error') {
    return (
      <Frame folio="PRIVACY">
        <section className="notice-panel reveal">
          <p className="eyebrow">Interruption</p>
          <h1>{state.message}</h1>
        </section>
      </Frame>
    );
  }
  if (state.kind === 'deleted') {
    return (
      <Frame folio="PRIVACY">
        <section className="notice-panel reveal">
          <p className="eyebrow">Done</p>
          <h1>
            Your data has been <em>deleted</em>.
          </h1>
          <p>Every project, event, thread, and memory has been removed.</p>
        </section>
      </Frame>
    );
  }

  return (
    <Frame folio="PRIVACY">
      <section className="work-hero reveal">
        <p className="eyebrow">Privacy &amp; data</p>
        <h1>
          Export or erase, <em>any time</em>.
        </h1>
        <p className="thread-meta">
          Signed in as {state.account.email} ·{' '}
          <Link className="text-link" href="/work">
            Work
          </Link>
        </p>
      </section>

      <section className="thread-card reveal">
        <h2 className="section-heading">Export your data</h2>
        <p className="privacy-note">
          Download a JSON archive of your projects, normalized events, work
          threads, and approved memories. It contains only your own data.
        </p>
        <button
          type="button"
          className="orange-button"
          disabled={busy}
          onClick={() => void exportData()}
        >
          Download export
        </button>
      </section>

      <section className="thread-card reveal">
        <h2 className="section-heading">Delete everything</h2>
        <p className="privacy-note">
          Permanently delete every project, event, thread, chunk, and memory
          across all Baton stores. This cannot be undone. Type{' '}
          <code>DELETE</code> to confirm.
        </p>
        <input
          className="code-panel"
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          aria-label="Type DELETE to confirm"
          placeholder="DELETE"
        />
        <button
          type="button"
          className="revoke-button"
          disabled={busy || confirmText !== 'DELETE'}
          onClick={() => void deleteAccount()}
        >
          Delete my data
        </button>
      </section>
    </Frame>
  );
}
