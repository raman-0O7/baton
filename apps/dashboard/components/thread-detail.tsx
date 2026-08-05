'use client';

import type {
  EventReadback,
  RetrievedChunk,
  SourceEvent,
  WorkThreadOverview,
  WorkThreadSession,
} from '@baton/protocol';
import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { cloudFetch, loginHref, relativeTime } from './cloud';
import { Frame, LoadingLedger } from './frame';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; overview: WorkThreadOverview; events: SourceEvent[] };

export function ThreadDetail({ workThreadId }: { workThreadId: string }) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [removing, setRemoving] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<RetrievedChunk[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overviewResponse, eventsResponse] = await Promise.all([
        cloudFetch(
          `/v1/work-threads/${encodeURIComponent(workThreadId)}/overview`,
        ),
        cloudFetch(
          `/v1/work-threads/${encodeURIComponent(workThreadId)}/events?limit=200`,
        ),
      ]);
      if (overviewResponse.status === 401 || eventsResponse.status === 401) {
        setState({ kind: 'signed-out' });
        return;
      }
      if (overviewResponse.status === 404) {
        setState({ kind: 'error', message: 'This work thread was not found.' });
        return;
      }
      if (!overviewResponse.ok || !eventsResponse.ok) {
        setState({
          kind: 'error',
          message: 'This thread could not be opened.',
        });
        return;
      }
      const overview = (await overviewResponse.json()) as WorkThreadOverview;
      const readback = (await eventsResponse.json()) as EventReadback;
      setState({ kind: 'ready', overview, events: readback.events });
    } catch {
      setState({ kind: 'error', message: 'Baton Cloud is unreachable.' });
    }
  }, [workThreadId]);

  useEffect(() => void load(), [load]);

  async function removeSession(sourceSessionId: string) {
    setRemoving(sourceSessionId);
    const response = await cloudFetch(
      `/v1/work-threads/${encodeURIComponent(workThreadId)}/sessions/${encodeURIComponent(sourceSessionId)}`,
      { method: 'DELETE' },
    ).catch(() => null);
    setRemoving(null);
    if (response?.ok) await load();
    else
      setState({
        kind: 'error',
        message: 'That session could not be reassigned.',
      });
  }

  async function runSearch(
    event: FormEvent<HTMLFormElement>,
    projectId: string,
  ) {
    event.preventDefault();
    const trimmed = searchQuery.trim();
    if (trimmed.length === 0) return;
    setSearching(true);
    const params = new URLSearchParams({
      projectId,
      workThreadId,
      query: trimmed,
    });
    const response = await cloudFetch(
      `/v1/retrieval/search?${params.toString()}`,
    ).catch(() => null);
    setSearching(false);
    if (response?.ok) {
      const body = (await response.json()) as { chunks: RetrievedChunk[] };
      setResults(body.chunks);
    } else {
      setResults([]);
    }
  }

  if (state.kind === 'loading') {
    return (
      <Frame folio="THREAD">
        <LoadingLedger />
      </Frame>
    );
  }

  if (state.kind === 'signed-out') {
    return (
      <Frame folio="THREAD">
        <section className="notice-panel reveal">
          <p className="eyebrow">Signed out</p>
          <h1>Sign in to read this thread.</h1>
          <p>
            <a
              className="orange-button"
              href={loginHref(`/work/${workThreadId}`)}
            >
              Sign in to Baton
            </a>
          </p>
        </section>
      </Frame>
    );
  }

  if (state.kind === 'error') {
    return (
      <Frame folio="THREAD">
        <section className="notice-panel reveal">
          <p className="eyebrow">Interruption</p>
          <h1>{state.message}</h1>
          <p>
            <Link className="text-link" href="/work">
              Back to work
            </Link>
          </p>
        </section>
      </Frame>
    );
  }

  const { overview, events } = state;
  return (
    <Frame folio="THREAD">
      <section className="thread-hero reveal">
        <p className="eyebrow">
          <Link className="text-link" href="/work">
            ← Work
          </Link>{' '}
          · {overview.workThread.state}
        </p>
        <h1>{overview.workThread.title}</h1>
        {overview.workThread.goal !== null && (
          <p className="thread-goal">{overview.workThread.goal}</p>
        )}
        <p className="thread-meta">
          {overview.eventCount} events ·{' '}
          {overview.lastActivityAt === null
            ? 'no activity yet'
            : `last activity ${relativeTime(overview.lastActivityAt)}`}
        </p>
      </section>

      <section className="thread-grid">
        <article className="thread-card">
          <h2 className="section-heading">Sources</h2>
          {overview.sessions.length === 0 ? (
            <p className="empty-note">No sessions assigned.</p>
          ) : (
            <ul className="source-list">
              {overview.sessions.map((session: WorkThreadSession) => (
                <li key={session.sourceSession.sourceSessionId}>
                  <span
                    className={`agent-tag agent-${session.sourceSession.sourceAgent}`}
                  >
                    {session.sourceSession.sourceAgent}
                  </span>
                  <span className="source-title">
                    {session.sourceSession.title ?? 'Untitled session'}
                  </span>
                  <span className="source-assignment">
                    {session.assignment}
                  </span>
                  <button
                    type="button"
                    className="revoke-button"
                    disabled={
                      removing === session.sourceSession.sourceSessionId
                    }
                    onClick={() =>
                      void removeSession(session.sourceSession.sourceSessionId)
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="thread-card">
          <h2 className="section-heading">Decisions</h2>
          {overview.decisions.length === 0 ? (
            <p className="empty-note">No decisions recorded.</p>
          ) : (
            <ul className="fact-list">
              {overview.decisions.map((decision) => (
                <li key={decision.eventId}>
                  <strong>{decision.summary}</strong>
                  {decision.rationale !== null && (
                    <span> — {decision.rationale}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="thread-card">
          <h2 className="section-heading">Tasks</h2>
          {overview.tasks.length === 0 ? (
            <p className="empty-note">No tasks tracked.</p>
          ) : (
            <ul className="fact-list">
              {overview.tasks.map((task) => (
                <li key={task.eventId}>
                  <span className={`task-status status-${task.status}`}>
                    {task.status.replace('_', ' ')}
                  </span>{' '}
                  {task.text}
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="thread-card">
          <h2 className="section-heading">Changed files</h2>
          {overview.fileActivities.length === 0 ? (
            <p className="empty-note">No file changes.</p>
          ) : (
            <ul className="fact-list">
              {overview.fileActivities.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> · {file.operations.join(', ')} ·{' '}
                  {file.changeCount}×
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="thread-search">
        <h2 className="section-heading">Search this thread</h2>
        <form
          className="search-form"
          onSubmit={(event) =>
            void runSearch(event, overview.workThread.projectId)
          }
        >
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Ask about a decision, file, or error…"
            aria-label="Search this work thread"
          />
          <button type="submit" className="ink-button" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>
        {results !== null &&
          (results.length === 0 ? (
            <p className="empty-note">No matching evidence.</p>
          ) : (
            <ul className="fact-list search-results">
              {results.map((chunk) => (
                <li key={chunk.chunkId}>
                  <span className={`agent-tag agent-${chunk.sourceAgent}`}>
                    {chunk.kind}
                  </span>{' '}
                  {chunk.text}
                </li>
              ))}
            </ul>
          ))}
      </section>

      <section className="thread-timeline">
        <h2 className="section-heading">Timeline</h2>
        <ol className="timeline">
          {events.map((event) => (
            <li key={event.eventId} className="timeline-row">
              <span className={`agent-tag agent-${event.sourceAgent}`}>
                {event.sourceAgent}
              </span>
              <span className="timeline-body">{summarize(event)}</span>
              <span className="timeline-time">
                {relativeTime(event.occurredAt)}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Frame>
  );
}

function summarize(event: SourceEvent): string {
  const payload = event.payload;
  switch (payload.kind) {
    case 'message':
      return `${payload.role}: ${truncate(payload.text)}`;
    case 'tool_call':
      return `↳ ${payload.name}${payload.inputSummary ? ` ${truncate(payload.inputSummary)}` : ''}`;
    case 'tool_result':
      return `↲ result${payload.isError ? ' (error)' : ''}${payload.outputSummary ? `: ${truncate(payload.outputSummary)}` : ''}`;
    case 'file_change':
      return `${payload.operation} ${payload.path}`;
    case 'task':
      return `task (${payload.status}): ${truncate(payload.text)}`;
    case 'decision':
      return `decision: ${truncate(payload.summary)}`;
    case 'error':
      return `error: ${truncate(payload.message)}`;
    case 'session_metadata':
      return `session${payload.gitBranch ? ` · ${payload.gitBranch}` : ''}`;
    default:
      return 'event';
  }
}

function truncate(value: string): string {
  return value.length > 140 ? `${value.slice(0, 137)}…` : value;
}
