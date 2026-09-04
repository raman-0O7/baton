'use client';

import type { Project, WorkThread } from '@baton/protocol';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { cloudFetch, relativeTime } from './cloud';
import { SignInButtons } from './sign-in';
import { Frame, LoadingLedger } from './frame';

type ViewState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; projects: Project[] };

const stateLabel: Record<WorkThread['state'], string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

export function WorkThreads() {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [selected, setSelected] = useState<string | null>(null);
  const [threads, setThreads] = useState<WorkThread[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await cloudFetch('/v1/projects');
      if (response.status === 401) {
        setState({ kind: 'signed-out' });
        return;
      }
      if (!response.ok) {
        setState({
          kind: 'error',
          message: 'Your projects could not be opened.',
        });
        return;
      }
      const body = (await response.json()) as { projects: Project[] };
      setState({ kind: 'ready', projects: body.projects });
      const first = body.projects.find(
        (project) => project.state !== 'disabled',
      );
      if (first !== undefined) setSelected(first.projectId);
    } catch {
      setState({ kind: 'error', message: 'Baton Cloud is unreachable.' });
    }
  }, []);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (selected === null) return;
    setThreads(null);
    let cancelled = false;
    void (async () => {
      const response = await cloudFetch(
        `/v1/work-threads?projectId=${encodeURIComponent(selected)}`,
      ).catch(() => null);
      if (cancelled) return;
      if (response?.ok) {
        const body = (await response.json()) as { workThreads: WorkThread[] };
        setThreads(body.workThreads);
      } else {
        setThreads([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  if (state.kind === 'loading') {
    return (
      <Frame folio="WORK">
        <LoadingLedger />
      </Frame>
    );
  }

  if (state.kind === 'signed-out') {
    return (
      <Frame folio="WORK">
        <section className="notice-panel reveal">
          <p className="eyebrow">Signed out</p>
          <h1>
            Your <em>work</em> is waiting.
          </h1>
          <p>
            <SignInButtons returnTo="/work" />
          </p>
        </section>
      </Frame>
    );
  }

  if (state.kind === 'error') {
    return (
      <Frame folio="WORK">
        <section className="notice-panel reveal">
          <p className="eyebrow">Interruption</p>
          <h1>{state.message}</h1>
        </section>
      </Frame>
    );
  }

  return (
    <Frame folio="WORK">
      <section className="work-hero reveal">
        <p className="eyebrow">Active work</p>
        <h1>
          Continue a <em>thread</em>, not a transcript.
        </h1>
      </section>
      {state.projects.length === 0 ? (
        <p className="empty-note">
          No projects are enabled yet. Run <code>baton enable</code> in a
          project to begin capturing work.
        </p>
      ) : (
        <div className="work-columns">
          <nav className="project-rail" aria-label="Projects">
            {state.projects.map((project) => (
              <button
                key={project.projectId}
                type="button"
                className={
                  project.projectId === selected
                    ? 'project-chip is-active'
                    : 'project-chip'
                }
                onClick={() => setSelected(project.projectId)}
              >
                {project.displayName}
              </button>
            ))}
          </nav>
          <div className="thread-list">
            {threads === null ? (
              <p className="empty-note">Opening threads…</p>
            ) : threads.length === 0 ? (
              <p className="empty-note">
                No work threads yet for this project. They appear as Baton
                organizes captured sessions.
              </p>
            ) : (
              threads.map((thread) => (
                <Link
                  key={thread.workThreadId}
                  className="thread-row"
                  href={`/work/${thread.workThreadId}`}
                >
                  <span className="thread-title">{thread.title}</span>
                  <span className={`thread-state state-${thread.state}`}>
                    {stateLabel[thread.state]}
                  </span>
                  <span className="thread-updated">
                    updated {relativeTime(thread.updatedAt)}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      )}
    </Frame>
  );
}
