'use client';

import type { Memory, MemoryCandidate } from '@baton/protocol';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { cloudFetch, loginHref } from './cloud';
import { Frame, LoadingLedger } from './frame';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; candidates: MemoryCandidate[]; memories: Memory[] };

export function MemoryInbox() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [proposed, review, approved] = await Promise.all([
        cloudFetch('/v1/memory/candidates?status=proposed'),
        cloudFetch('/v1/memory/candidates?status=needs_review'),
        cloudFetch('/v1/memory/memories'),
      ]);
      if ([proposed, review, approved].some((r) => r.status === 401)) {
        setState({ kind: 'signed-out' });
        return;
      }
      if (!proposed.ok || !review.ok || !approved.ok) {
        setState({
          kind: 'error',
          message: 'Your memory inbox could not be opened.',
        });
        return;
      }
      const proposedBody = (await proposed.json()) as {
        candidates: MemoryCandidate[];
      };
      const reviewBody = (await review.json()) as {
        candidates: MemoryCandidate[];
      };
      const approvedBody = (await approved.json()) as { memories: Memory[] };
      setState({
        kind: 'ready',
        candidates: [...proposedBody.candidates, ...reviewBody.candidates],
        memories: approvedBody.memories,
      });
    } catch {
      setState({ kind: 'error', message: 'Baton Cloud is unreachable.' });
    }
  }, []);

  useEffect(() => void load(), [load]);

  async function act(candidateId: string, action: 'approve' | 'reject') {
    setBusy(candidateId);
    const response = await cloudFetch(
      `/v1/memory/candidates/${encodeURIComponent(candidateId)}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    ).catch(() => null);
    setBusy(null);
    if (response?.ok) await load();
    else
      setState({
        kind: 'error',
        message: `That memory could not be ${action}d.`,
      });
  }

  if (state.kind === 'loading') {
    return (
      <Frame folio="MEMORY">
        <LoadingLedger />
      </Frame>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <Frame folio="MEMORY">
        <section className="notice-panel reveal">
          <p className="eyebrow">Signed out</p>
          <h1>
            Review your <em>memory</em>.
          </h1>
          <p>
            <a className="orange-button" href={loginHref('/memory')}>
              Sign in to Baton
            </a>
          </p>
        </section>
      </Frame>
    );
  }
  if (state.kind === 'error') {
    return (
      <Frame folio="MEMORY">
        <section className="notice-panel reveal">
          <p className="eyebrow">Interruption</p>
          <h1>{state.message}</h1>
        </section>
      </Frame>
    );
  }

  return (
    <Frame folio="MEMORY">
      <section className="work-hero reveal">
        <p className="eyebrow">Approval inbox</p>
        <h1>
          Nothing becomes <em>memory</em> without you.
        </h1>
        <p className="thread-meta">
          <Link className="text-link" href="/work">
            ← Work
          </Link>
        </p>
      </section>

      <section className="thread-timeline">
        <h2 className="section-heading">Awaiting review</h2>
        {state.candidates.length === 0 ? (
          <p className="empty-note">No memory candidates await review.</p>
        ) : (
          <ul className="fact-list">
            {state.candidates.map((candidate) => (
              <li key={candidate.candidateId} className="memory-row">
                <div>
                  <strong>{candidate.claim}</strong>
                  <div className="memory-meta">
                    {candidate.category} · {candidate.scope.type} ·{' '}
                    {candidate.status}
                    {candidate.reasonCode !== null
                      ? ` · ${candidate.reasonCode}`
                      : ''}{' '}
                    · evidence {candidate.evidenceEventIds.length}
                  </div>
                </div>
                <div className="memory-actions">
                  <button
                    type="button"
                    className="orange-button"
                    disabled={busy === candidate.candidateId}
                    onClick={() => void act(candidate.candidateId, 'approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="revoke-button"
                    disabled={busy === candidate.candidateId}
                    onClick={() => void act(candidate.candidateId, 'reject')}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="thread-timeline">
        <h2 className="section-heading">Approved memories</h2>
        {state.memories.length === 0 ? (
          <p className="empty-note">No approved memories yet.</p>
        ) : (
          <ul className="fact-list">
            {state.memories.map((memory) => (
              <li key={memory.memoryId}>
                <strong>{memory.claim}</strong>
                <span className="memory-meta">
                  {' '}
                  — {memory.category} · {memory.scope.type} · evidence{' '}
                  {memory.evidenceEventIds.length}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Frame>
  );
}
